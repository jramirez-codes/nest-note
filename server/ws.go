package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// runRequest is the first message the client sends after connecting. SessionID
// keys the durable session; ResumeOnly reconnects to an existing one (or gets
// `gone`). Prompt starts a new run. cwd is intentionally absent: the working
// directory is fixed server-side.
type runRequest struct {
	SessionID  string `json:"sessionId"`
	ResumeOnly bool   `json:"resumeOnly"`
	Prompt     string `json:"prompt"`
}

// runHandler authenticates, upgrades to a WebSocket, reads a single run request,
// and streams Claude's newline-delimited JSON back as one text frame per line.
//
// When root is set it re-scaffolds on every request (cheap in steady state:
// rebuilds only on source changes) so a server the orchestrator queued last
// turn is built, registered, and callable this turn. staticWorkdir/boot are the
// fallbacks used when root is empty or a re-scaffold fails.
func runHandler(token, staticWorkdir, root string, threshold int, runTimeout time.Duration, boot mcpSetup, reg *sessionRegistry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r, token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			log.Printf("ws accept: %v", err)
			return
		}
		defer c.CloseNow()

		// Read the run request first, with a short deadline — a client that
		// connects but never states its request shouldn't hold the socket.
		readCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, data, err := c.Read(readCtx)
		cancel()
		if err != nil {
			log.Printf("ws read: %v", err)
			return
		}
		var req runRequest
		if err := json.Unmarshal(data, &req); err != nil {
			// 4400 (application range), not a reserved code: some WebSocket
			// clients echo the server's close code back on the closing
			// handshake, and reserved codes like 1003/1011 make them throw and
			// never surface the close — an infinite spinner on the phone.
			c.Close(4400, "expected {sessionId | prompt}")
			return
		}

		if req.ResumeOnly {
			sess := reg.get(strings.TrimSpace(req.SessionID))
			if strings.TrimSpace(req.SessionID) == "" || sess == nil {
				writeGone(c)
				return
			}
			serveRunSocket(c, sess, reg)
			return
		}

		// No sessionId: an un-updated client wanting the old, non-durable behaviour
		// — mint an ephemeral id (unresumable, killed on disconnect).
		id := strings.TrimSpace(req.SessionID)
		ephemeral := id == ""
		if ephemeral {
			id = randomSessionID()
		}
		sess, created := reg.findOrCreate(id, "run")
		if !created {
			serveRunSocket(c, sess, reg)
			return
		}
		sess.ephemeral = ephemeral
		if req.Prompt == "" {
			reg.remove(id)
			c.Close(4400, "expected {prompt}")
			return
		}

		// Scaffold per run (cheap in steady state) so a server the orchestrator
		// queued last turn is built and callable now.
		workdir := staticWorkdir
		var mcpConfigs, allowedTools []string
		if root != "" {
			setup, serr := scaffoldRoot(root, threshold)
			if serr != nil {
				log.Printf("rescaffold: %v (using last-known-good)", serr)
				setup = boot
			}
			workdir = setup.projectsDir
			mcpConfigs = setup.mcpConfigs
			allowedTools = setup.allowedTools
		}

		startRunProcess(sess, workdir, mcpConfigs, allowedTools, req.Prompt, runTimeout)
		serveRunSocket(c, sess, reg)
	}
}

// startRunProcess runs one Claude one-shot for a fresh session, streaming its
// newline-delimited JSON into the session buffer from a socket-independent
// goroutine. A run-timeout still bounds it so a Claude that never produces output
// and never exits can't squat forever. On failure it emits a `result` error line
// the client already renders, so the user sees what happened.
func startRunProcess(sess *session, workdir string, mcpConfigs, allowedTools []string, prompt string, runTimeout time.Duration) {
	ctx, cancelRun := context.WithTimeout(context.Background(), runTimeout)
	sess.setCancel(cancelRun)

	go func() {
		defer cancelRun()
		log.Printf("run: start %.60q", prompt)
		start := time.Now()
		frames := 0
		err := runClaude(ctx, workdir, mcpConfigs, allowedTools, prompt, func(line []byte) {
			if frames == 0 {
				log.Printf("run: first output after %s", time.Since(start).Round(time.Millisecond))
			}
			frames++
			sess.emit(append([]byte(nil), line...))
		})
		if err != nil {
			timedOut := ctx.Err() == context.DeadlineExceeded
			log.Printf("run: FAILED after %s, %d frames (timeout=%v): %v",
				time.Since(start).Round(time.Millisecond), frames, timedOut, err)
			reason := "The run failed on the server."
			if timedOut {
				reason = "The run timed out on the server — no reply within the run-timeout."
			}
			sess.emit(mustJSON(map[string]any{
				"type":     "result",
				"subtype":  "error_during_execution",
				"is_error": true,
				"result":   reason,
			}))
		} else {
			log.Printf("run: done in %s, %d frames", time.Since(start).Round(time.Millisecond), frames)
		}
		sess.markDone()
	}()
}

// serveRunSocket attaches c (replaying the buffered tail) and waits. /run has no
// live input; the only control frame is an optional {type:"kill"} (the phone's ×
// / cancel). On a socket read error the client is gone: detach but leave the run
// to finish (or hit its timeout) so a reconnect can still collect the result.
func serveRunSocket(c *websocket.Conn, sess *session, reg *sessionRegistry) {
	sess.attach(c)
	for {
		_, data, err := c.Read(context.Background())
		if err != nil {
			if sess.ephemeral {
				sess.kill()
				reg.remove(sess.id)
			}
			sess.detach(c)
			return
		}
		var ctl struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(data, &ctl) == nil && ctl.Type == "kill" {
			sess.kill()
			reg.remove(sess.id)
			sess.detach(c)
			return
		}
	}
}
