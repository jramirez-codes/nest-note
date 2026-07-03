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
func runHandler(token, workdir string) http.HandlerFunc {
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
		if err := json.Unmarshal(data, &req); err != nil || req.Prompt == "" {
			c.Close(websocket.StatusUnsupportedData, "expected {prompt}")
			return
		}

		// Now arm disconnect detection: CloseRead drains incoming frames and
		// cancels ctx when the client goes away, killing the Claude subprocess.
		ctx := c.CloseRead(context.Background())

		log.Printf("run: %.60q", req.Prompt)
		err = runClaude(ctx, workdir, req.Prompt, func(line []byte) {
			if werr := c.Write(ctx, websocket.MessageText, line); werr != nil {
				log.Printf("ws write: %v", werr)
			}
		})
		if err != nil {
			log.Printf("claude: %v", err)
			c.Close(websocket.StatusInternalError, "claude failed")
			return
		}
		c.Close(websocket.StatusNormalClosure, "done")
	}
}
