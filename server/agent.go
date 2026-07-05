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
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// agentRequest is the first frame the client sends: which project to open and an
// optional first prompt. The session's Claude process runs in projects/<slug>,
// created if it doesn't exist yet. The slug is derived from Project — never a
// client-supplied path — so it can't traverse out of the projects dir.
type agentRequest struct {
	Project string `json:"project"`
	Prompt  string `json:"prompt"`
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
func agentHandler(token, projectsBase string, enabled bool) http.HandlerFunc {
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

		// First frame names the project, with a short deadline so a client that
		// connects but never speaks can't hold the socket.
		readCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, data, err := c.Read(readCtx)
		cancel()
		if err != nil {
			log.Printf("code ws read: %v", err)
			return
		}
		var req agentRequest
		if err := json.Unmarshal(data, &req); err != nil || strings.TrimSpace(req.Project) == "" {
			c.Close(4400, "expected {project}")
			return
		}
		dir, slug, err := resolveProjectDir(projectsBase, req.Project)
		if err != nil {
			c.Close(4400, "bad project")
			return
		}

		// The session ends when the client disconnects (control-read loop cancels),
		// the client sends kill, or Claude exits. ctx cancellation SIGKILLs the
		// whole process group (Claude plus any tool subprocess it spawned).
		ctx, cancelRun := context.WithCancel(context.Background())
		defer cancelRun()

		// bypassPermissions: v1 runs every tool without asking. --include-partial-
		// messages types the assistant out token-by-token; --verbose is required
		// for stream-json output.
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

		stdin, err := cmd.StdinPipe()
		if err != nil {
			c.Close(websocket.StatusInternalError, "stdin pipe")
			return
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			c.Close(websocket.StatusInternalError, "stdout pipe")
			return
		}
		// Keep stderr for error reporting, bounded so a chatty session can't grow
		// it without limit (same as runClaude).
		var stderr boundedBuffer
		stderr.limit = 64 * 1024
		cmd.Stderr = &stderr

		// Serialize outbound frames: coder/websocket writes are not concurrent-safe
		// and both the control loop's ack path and the stdout pump can emit.
		var wmu sync.Mutex
		send := func(v any) {
			b, _ := json.Marshal(v)
			wmu.Lock()
			defer wmu.Unlock()
			_ = c.Write(ctx, websocket.MessageText, b)
		}

		if err := cmd.Start(); err != nil {
			send(map[string]any{"type": "error", "message": err.Error()})
			c.Close(websocket.StatusNormalClosure, "start failed")
			return
		}
		log.Printf("code: session start project=%s in %s", slug, dir)
		start := time.Now()

		// Feed one user turn to Claude as a stream-json message. Writes are
		// serialized so two prompts in quick succession can't interleave on stdin.
		var smu sync.Mutex
		sendPrompt := func(text string) {
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
		if strings.TrimSpace(req.Prompt) != "" {
			sendPrompt(req.Prompt)
		}

		// Control-read loop: new prompts / kill from the client. A read error means
		// the client is gone — cancel to tear the session (and its group) down.
		go func() {
			for {
				_, data, err := c.Read(ctx)
				if err != nil {
					cancelRun()
					return
				}
				var ctl agentControl
				if json.Unmarshal(data, &ctl) != nil {
					continue
				}
				switch ctl.Type {
				case "prompt":
					if strings.TrimSpace(ctl.Text) != "" {
						sendPrompt(ctl.Text)
					}
				case "kill":
					cancelRun()
					return
				}
			}
		}()

		// Relay Claude's stream-json output line by line. Each line is a complete
		// JSON object ({type:system|assistant|user|result|...}); it is forwarded
		// nested under "msg" (as RawMessage, no re-encode) so the client parses the
		// CLI shape directly and our own frame types never collide with Claude's.
		scan := bufio.NewScanner(stdout)
		scan.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
		for scan.Scan() {
			raw := append([]byte(nil), scan.Bytes()...)
			send(map[string]any{"type": "cc", "msg": json.RawMessage(raw)})
		}

		waitErr := cmd.Wait()
		killGroup(cmd) // reap any tool subprocess it left behind
		log.Printf("code: session done project=%s in %s", slug, time.Since(start).Round(time.Millisecond))

		// Surface why Claude died if it failed for a reason the stream didn't carry
		// (bad flags, auth/quota). Harmless if the client already disconnected.
		if waitErr != nil {
			if msg := strings.TrimSpace(stderr.String()); msg != "" {
				fin, _ := json.Marshal(map[string]any{"type": "error", "message": msg})
				wmu.Lock()
				_ = c.Write(context.Background(), websocket.MessageText, fin)
				wmu.Unlock()
			}
		}

		// Final frame on a fresh context so a natural exit still reports even though
		// ctx may be cancelled; a mere client disconnect makes this a no-op.
		fin, _ := json.Marshal(map[string]any{"type": "exit"})
		wmu.Lock()
		_ = c.Write(context.Background(), websocket.MessageText, fin)
		wmu.Unlock()
		c.Close(websocket.StatusNormalClosure, "done")
	}
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

// resolveProjectDir turns a human project name into projects/<slug> under the
// base dir, creating it if absent, and returns the absolute dir plus the slug.
// The slug is reduced to [a-z0-9-], so unlike resolveExecDir there is nothing to
// traverse with — an empty result is the only failure. This is the project
// namespace the phone's /code <name> selects; it is not a sandbox (the agent can
// still reach anywhere the server's user can).
func resolveProjectDir(base, name string) (dir, slug string, err error) {
	slug = strings.Trim(slugRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if slug == "" {
		return "", "", errors.New("empty project name")
	}
	dir = filepath.Join(base, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", err
	}
	return dir, slug, nil
}
