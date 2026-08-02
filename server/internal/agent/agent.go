// Package agent runs the /code endpoint: a persistent, multi-turn Claude Code
// session inside a project directory, plus the /projects listing and deletion
// that manage those directories.
//
//	agent.go     the /code socket, its durable process, and the control loop
//	projects.go  /projects and /projects/delete
package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"nestnote/server/internal/httpx"
	"nestnote/server/internal/procio"
	"nestnote/server/internal/project"
	"nestnote/server/internal/session"
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

// Handler runs a persistent, multi-turn Claude Code session in a project
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
func Handler(token, projectsBase string, enabled bool, reg *session.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !httpx.Guard(w, r, token) {
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
			sess := reg.Get(strings.TrimSpace(req.SessionID))
			if strings.TrimSpace(req.SessionID) == "" || sess == nil {
				session.WriteGone(c)
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
			id = session.RandomID()
		}
		sess, created := reg.FindOrCreate(id, "code")
		if !created {
			// A durable session for this id is already running (reconnect after a
			// dropped socket): just attach, never start a second Claude.
			serveAgentSocket(c, sess, reg)
			return
		}
		sess.SetEphemeral(ephemeral)

		if strings.TrimSpace(req.Project) == "" {
			reg.Remove(id)
			c.Close(4400, "expected {project}")
			return
		}
		dir, slug, err := project.ResolveDir(projectsBase, req.Project)
		if err != nil {
			reg.Remove(id)
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
func startAgentProcess(sess *session.Session, dir, slug, firstPrompt string) {
	ctx, cancelRun := context.WithCancel(context.Background())
	sess.SetCancel(cancelRun)

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
	procio.SetGroup(cmd)

	fail := func(msg string) {
		sess.Emit(session.MustJSON(map[string]any{"type": "error", "message": msg}))
		sess.Emit(session.MustJSON(map[string]any{"type": "exit"}))
		sess.MarkDone()
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
	// without limit (same as the /run Claude runner).
	var stderr procio.BoundedBuffer
	stderr.Limit = 64 * 1024
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
		sess.Emit(session.MustJSON(map[string]any{"type": "userprompt", "text": text}))
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
	sess.SetHooks(sendPrompt, nil)

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
			sess.Emit(session.MustJSON(map[string]any{"type": "cc", "msg": json.RawMessage(raw)}))
		}

		waitErr := cmd.Wait()
		procio.KillGroup(cmd) // reap any tool subprocess it left behind
		log.Printf("code: session done project=%s in %s", slug, time.Since(start).Round(time.Millisecond))

		// Surface why Claude died if it failed for a reason the stream didn't carry
		// (bad flags, auth/quota).
		if waitErr != nil {
			if msg := strings.TrimSpace(stderr.String()); msg != "" {
				sess.Emit(session.MustJSON(map[string]any{"type": "error", "message": msg}))
			}
		}
		sess.Emit(session.MustJSON(map[string]any{"type": "exit"}))
		sess.MarkDone()
	}()
}

// serveAgentSocket attaches c to a session (replaying its buffered tail so the
// client rebuilds its transcript) and runs the control loop for prompts/kill. On
// a socket read error the client is gone: detach (keep the process running) and
// return; the owner goroutine keeps buffering for the next reconnect.
func serveAgentSocket(c *websocket.Conn, sess *session.Session, reg *session.Registry) {
	sess.Attach(c)
	for {
		_, data, err := c.Read(context.Background())
		if err != nil {
			// Client gone. Durable sessions keep running (reconnect later);
			// ephemeral ones die with their socket (pre-durability behaviour).
			if sess.Ephemeral() {
				sess.Kill()
				reg.Remove(sess.ID())
			}
			sess.Detach(c)
			return
		}
		var ctl agentControl
		if json.Unmarshal(data, &ctl) != nil {
			continue
		}
		switch ctl.Type {
		case "prompt":
			if strings.TrimSpace(ctl.Text) != "" {
				input, _ := sess.Hooks()
				if input != nil {
					input(ctl.Text)
				}
			}
		case "kill":
			sess.Kill()
			reg.Remove(sess.ID())
			sess.Detach(c)
			return
		}
	}
}
