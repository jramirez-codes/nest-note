package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// agentRequest is the first frame the client sends. SessionID keys the durable
// session (the same card id the phone correlates on); ResumeOnly asks to reattach
// to an existing session and get `gone` if it's already reaped, rather than
// starting a fresh one. Project/Prompt open a new session's Claude process in
// projects/<slug> (created if absent; the slug is derived from Project, never a
// client path, so it can't traverse out) and are ignored on a reconnect.
type agentRequest struct {
	SessionID  string `json:"sessionId"`
	ResumeOnly bool   `json:"resumeOnly"`
	Project    string `json:"project"`
	Prompt     string `json:"prompt"`
}

// agentControl is any client frame after the first: a new user prompt for the
// running session, or an explicit kill that ends it. There is no per-tool
// approval in v1 — permissions are auto-accepted (see agentHandler) — so the
// only controls are "keep talking" and "stop".
type agentControl struct {
	Type string `json:"type"` // "prompt" | "kill"
	Text string `json:"text"` // payload for "prompt"
}

// agentHandler runs a persistent, multi-turn Claude Code session in a project
// directory and relays its stream-json output to the phone, staying open until
// the client disconnects or sends kill. Prompts arrive over the socket and are
// fed to Claude's stdin as stream-json user messages, so context is kept in the
// one long-lived process (no cold start per turn).
//
// v1 auto-accepts every tool call (--permission-mode bypassPermissions): this is
// the agent equivalent of /exec — full code execution as the server's user — so
// like /exec it does nothing unless the operator started with -allow-code. A
// live Allow/Deny channel (the CLI's control_request/can_use_tool protocol) is
// a deliberate follow-up, not part of v1.
func agentHandler(token, projectsBase string, enabled bool, reg *sessionRegistry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r, token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !enabled {
			http.Error(w, "code disabled (start the server with -allow-code)", http.StatusForbidden)
			return
		}

		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			log.Printf("code ws accept: %v", err)
			return
		}
		defer c.CloseNow()

		// First frame names the session (and, for a new one, the project), with a
		// short deadline so a client that connects but never speaks can't hold the
		// socket.
		readCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, data, err := c.Read(readCtx)
		cancel()
		if err != nil {
			log.Printf("code ws read: %v", err)
			return
		}
		var req agentRequest
		if err := json.Unmarshal(data, &req); err != nil {
			c.Close(4400, "expected {sessionId | project}")
			return
		}

		// Resume-only reconnect: adopt the still-running session, or tell the client
		// it's gone (reaped / finished) so it can finalize the card as interrupted.
		if req.ResumeOnly {
			sess := reg.get(strings.TrimSpace(req.SessionID))
			if strings.TrimSpace(req.SessionID) == "" || sess == nil {
				writeGone(c)
				return
			}
			serveAgentSocket(c, sess, reg)
			return
		}

		// No sessionId: an un-updated client that wants the old, non-durable
		// behaviour — mint an ephemeral id (unresumable, killed on disconnect).
		id := strings.TrimSpace(req.SessionID)
		ephemeral := id == ""
		if ephemeral {
			id = randomSessionID()
		}
		sess, created := reg.findOrCreate(id, "code")
		if !created {
			// A durable session for this id is already running (reconnect after a
			// dropped socket): just attach, never start a second Claude.
			serveAgentSocket(c, sess, reg)
			return
		}
		sess.ephemeral = ephemeral

		if strings.TrimSpace(req.Project) == "" {
			reg.remove(id)
			c.Close(4400, "expected {project}")
			return
		}
		dir, slug, err := resolveProjectDir(projectsBase, req.Project)
		if err != nil {
			reg.remove(id)
			c.Close(4400, "bad project")
			return
		}

		// Start the process owner in its own goroutine so it outlives THIS socket —
		// the whole point of durability. Then attach this socket + run its control
		// loop; when the socket dies we detach (not cancel), leaving Claude running
		// (unless ephemeral, where serveAgentSocket kills it on disconnect).
		startAgentProcess(sess, dir, slug, req.Prompt)
		serveAgentSocket(c, sess, reg)
	}
}

// startAgentProcess launches the durable Claude Code process for a fresh session
// and pumps its stream-json output into the session buffer from a goroutine that
// is NOT tied to any socket. The session ends only on kill, Claude exiting, or the
// orphan TTL — never on a mere disconnect.
//
// bypassPermissions: v1 runs every tool without asking. --include-partial-messages
// types the assistant out token-by-token; --verbose is required for stream-json.
func startAgentProcess(sess *session, dir, slug, firstPrompt string) {
	ctx, cancelRun := context.WithCancel(context.Background())
	sess.setCancel(cancelRun)

	cmd := exec.CommandContext(ctx, "claude",
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--permission-mode", "bypassPermissions",
		"--model", "sonnet",
	)
	cmd.Dir = dir
	setProcGroup(cmd)

	fail := func(msg string) {
		sess.emit(mustJSON(map[string]any{"type": "error", "message": msg}))
		sess.emit(mustJSON(map[string]any{"type": "exit"}))
		sess.markDone()
		cancelRun()
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		fail("stdin pipe: " + err.Error())
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		fail("stdout pipe: " + err.Error())
		return
	}
	// Keep stderr for error reporting, bounded so a chatty session can't grow it
	// without limit (same as runClaude).
	var stderr boundedBuffer
	stderr.limit = 64 * 1024
	cmd.Stderr = &stderr

	// Feed one user turn to Claude as a stream-json message. Writes are serialized
	// so two prompts in quick succession can't interleave on stdin. Wired as the
	// session's input hook so any attached socket's control loop can send a turn.
	//
	// The prompt is also emitted into the session buffer as a `userprompt` frame
	// BEFORE it's fed to Claude, so it lands in the transcript and — crucially —
	// replays on a reconnect. (Claude's own stream-json echoes the user message
	// too, but the client drops that as structural; making the echo explicit keeps
	// a resumed /code transcript faithful without relying on that format.)
	var smu sync.Mutex
	sendPrompt := func(text string) {
		sess.emit(mustJSON(map[string]any{"type": "userprompt", "text": text}))
		msg, _ := json.Marshal(map[string]any{
			"type": "user",
			"message": map[string]any{
				"role":    "user",
				"content": text,
			},
		})
		smu.Lock()
		_, _ = io.WriteString(stdin, string(msg)+"\n")
		smu.Unlock()
	}
	sess.mu.Lock()
	sess.input = sendPrompt
	sess.mu.Unlock()

	if err := cmd.Start(); err != nil {
		fail(err.Error())
		return
	}
	log.Printf("code: session start project=%s in %s", slug, dir)
	if strings.TrimSpace(firstPrompt) != "" {
		sendPrompt(firstPrompt)
	}

	go func() {
		defer cancelRun()
		start := time.Now()
		// Relay Claude's stream-json output line by line. Each line is a complete
		// JSON object ({type:system|assistant|user|result|...}), forwarded nested
		// under "msg" (as RawMessage, no re-encode) so the client parses the CLI
		// shape directly and our own frame types never collide with Claude's.
		scan := bufio.NewScanner(stdout)
		scan.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
		for scan.Scan() {
			raw := append([]byte(nil), scan.Bytes()...)
			sess.emit(mustJSON(map[string]any{"type": "cc", "msg": json.RawMessage(raw)}))
		}

		waitErr := cmd.Wait()
		killGroup(cmd) // reap any tool subprocess it left behind
		log.Printf("code: session done project=%s in %s", slug, time.Since(start).Round(time.Millisecond))

		// Surface why Claude died if it failed for a reason the stream didn't carry
		// (bad flags, auth/quota).
		if waitErr != nil {
			if msg := strings.TrimSpace(stderr.String()); msg != "" {
				sess.emit(mustJSON(map[string]any{"type": "error", "message": msg}))
			}
		}
		sess.emit(mustJSON(map[string]any{"type": "exit"}))
		sess.markDone()
	}()
}

// serveAgentSocket attaches c to a session (replaying its buffered tail so the
// client rebuilds its transcript) and runs the control loop for prompts/kill. On
// a socket read error the client is gone: detach (keep the process running) and
// return; the owner goroutine keeps buffering for the next reconnect.
func serveAgentSocket(c *websocket.Conn, sess *session, reg *sessionRegistry) {
	sess.attach(c)
	for {
		_, data, err := c.Read(context.Background())
		if err != nil {
			// Client gone. Durable sessions keep running (reconnect later);
			// ephemeral ones die with their socket (pre-durability behaviour).
			if sess.ephemeral {
				sess.kill()
				reg.remove(sess.id)
			}
			sess.detach(c)
			return
		}
		var ctl agentControl
		if json.Unmarshal(data, &ctl) != nil {
			continue
		}
		switch ctl.Type {
		case "prompt":
			if strings.TrimSpace(ctl.Text) != "" {
				sess.mu.Lock()
				input := sess.input
				sess.mu.Unlock()
				if input != nil {
					input(ctl.Text)
				}
			}
		case "kill":
			sess.kill()
			reg.remove(sess.id)
			sess.detach(c)
			return
		}
	}
}

// projectsResponse is the JSON body of /projects: the directory names directly
// under the projects base — the slugs `/code <name>` selects among. Names only,
// no paths, since the phone just needs them to autocomplete the command.
type projectsResponse struct {
	Projects []string `json:"projects"`
}

// projectsHandler lists the existing project directories under projectsBase so
// the phone can autocomplete `/code <name>`. It is strictly read-only — unlike
// resolveProjectDir it never creates a dir — and answers with an empty list
// (never an error) when /code is disabled or the base doesn't exist yet, so the
// client can always treat the reply as "the projects to suggest, possibly none".
func projectsHandler(token, projectsBase string, enabled bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r, token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		names := []string{}
		if enabled {
			if entries, err := os.ReadDir(projectsBase); err == nil {
				for _, e := range entries {
					// Directories only, skipping dotfiles (.git and friends) — those
					// are never valid /code targets.
					if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
						names = append(names, e.Name())
					}
				}
			}
		}
		sort.Strings(names)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(projectsResponse{Projects: names})
	}
}

// deleteProjectRequest is the JSON body of POST /projects/delete: the human
// project name to remove. Slugged the same way resolveProjectDir slugs it, so
// the phone can send whatever the user typed and the same folder is targeted.
type deleteProjectRequest struct {
	Project string `json:"project"`
}

// deleteProjectHandler removes projects/<slug> under projectsBase — the
// destructive counterpart to projectsHandler's read-only listing. Gated behind
// the same -allow-code flag: with /code off there are no phone-managed projects
// to delete, so it 403s just like the agent socket. The slug is reduced to
// [a-z0-9-] before it is joined onto the base (see slugFor), so a client name can
// never traverse out of the projects dir. A missing folder is reported as a 404
// rather than silently succeeding, so the phone can tell "already gone" from
// "removed".
func deleteProjectHandler(token, projectsBase string, enabled bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r, token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !enabled {
			http.Error(w, "code disabled (start the server with -allow-code)", http.StatusForbidden)
			return
		}
		var req deleteProjectRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		slug := slugFor(req.Project)
		if slug == "" {
			http.Error(w, "empty project name", http.StatusBadRequest)
			return
		}
		dir := filepath.Join(projectsBase, slug)
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			http.Error(w, "no such project", http.StatusNotFound)
			return
		}
		if err := os.RemoveAll(dir); err != nil {
			http.Error(w, "delete failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			OK   bool   `json:"ok"`
			Slug string `json:"slug"`
		}{OK: true, Slug: slug})
	}
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

// slugFor reduces a human project name to the [a-z0-9-] folder slug shared by
// resolveProjectDir (project creation) and deleteProjectHandler (removal), so a
// name always maps to the same folder both ways. Empty means "no valid slug".
func slugFor(name string) string {
	return strings.Trim(slugRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
}

// resolveProjectDir turns a human project name into projects/<slug> under the
// base dir, creating it if absent, and returns the absolute dir plus the slug.
// The slug is reduced to [a-z0-9-], so unlike resolveExecDir there is nothing to
// traverse with — an empty result is the only failure. This is the project
// namespace the phone's /code <name> selects; it is not a sandbox (the agent can
// still reach anywhere the server's user can).
func resolveProjectDir(base, name string) (dir, slug string, err error) {
	slug = slugFor(name)
	if slug == "" {
		return "", "", errors.New("empty project name")
	}
	dir = filepath.Join(base, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", err
	}
	return dir, slug, nil
}
