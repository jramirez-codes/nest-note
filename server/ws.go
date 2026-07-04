package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// runRequest is the first (and only) message the client sends after connecting.
// cwd is intentionally absent: the working directory is fixed server-side.
type runRequest struct {
	Prompt string `json:"prompt"`
}

// runHandler authenticates, upgrades to a WebSocket, reads a single run request,
// and streams Claude's newline-delimited JSON back as one text frame per line.
//
// When root is set it re-scaffolds on every request (cheap in steady state:
// rebuilds only on source changes) so a server the orchestrator queued last
// turn is built, registered, and callable this turn. staticWorkdir/boot are the
// fallbacks used when root is empty or a re-scaffold fails.
func runHandler(token, staticWorkdir, root string, threshold int, runTimeout time.Duration, boot mcpSetup) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r, token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		workdir := staticWorkdir
		var mcpConfigs, allowedTools []string
		if root != "" {
			setup, err := scaffoldRoot(root, threshold)
			if err != nil {
				log.Printf("rescaffold: %v (using last-known-good)", err)
				setup = boot
			}
			workdir = setup.projectsDir
			mcpConfigs = setup.mcpConfigs
			allowedTools = setup.allowedTools
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
		if err := json.Unmarshal(data, &req); err != nil || req.Prompt == "" {
			// 4400 (application range), not a reserved code: some WebSocket
			// clients echo the server's close code back on the closing
			// handshake, and reserved codes like 1003/1011 make them throw and
			// never surface the close — an infinite spinner on the phone.
			c.Close(4400, "expected {prompt}")
			return
		}

		// Arm disconnect detection: CloseRead drains incoming frames and cancels
		// connCtx when the client goes away, killing the Claude subprocess. On top
		// of that, bound the run so a Claude process that never produces output and
		// never exits can't hold the socket (and the phone's spinner) forever.
		connCtx := c.CloseRead(context.Background())
		ctx, cancelRun := context.WithTimeout(connCtx, runTimeout)
		defer cancelRun()

		log.Printf("run: start %.60q", req.Prompt)
		start := time.Now()
		frames := 0
		err = runClaude(ctx, workdir, mcpConfigs, allowedTools, req.Prompt, func(line []byte) {
			if frames == 0 {
				log.Printf("run: first output after %s", time.Since(start).Round(time.Millisecond))
			}
			frames++
			if werr := c.Write(ctx, websocket.MessageText, line); werr != nil {
				log.Printf("ws write: %v", werr)
			}
		})
		if err != nil {
			timedOut := ctx.Err() == context.DeadlineExceeded
			log.Printf("run: FAILED after %s, %d frames (timeout=%v): %v",
				time.Since(start).Round(time.Millisecond), frames, timedOut, err)
			// Report as a normal result line the client already renders, then
			// close cleanly (1000). This shows the user what happened instead of
			// a silent hang, and avoids reserved close codes that wedge some
			// clients. Write on connCtx, not ctx, since ctx may be the cancelled
			// (timed-out) context.
			reason := "The run failed on the server."
			if timedOut {
				reason = "The run timed out on the server — no reply within the run-timeout."
			}
			errLine, _ := json.Marshal(map[string]any{
				"type":     "result",
				"subtype":  "error_during_execution",
				"is_error": true,
				"result":   reason,
			})
			_ = c.Write(connCtx, websocket.MessageText, errLine)
			c.Close(websocket.StatusNormalClosure, "run failed")
			return
		}
		log.Printf("run: done in %s, %d frames", time.Since(start).Round(time.Millisecond), frames)
		c.Close(websocket.StatusNormalClosure, "done")
	}
}
