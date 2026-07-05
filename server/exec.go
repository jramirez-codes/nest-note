package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// execRequest is the first frame the client sends: the shell command to run and
// an optional project subdirectory (relative to the server's base workdir) to
// run it in. The subdir only sets the *starting* directory — a shell can cd
// anywhere the server's user can — so it is a convenience, not a security
// boundary. The real gate is -allow-exec plus the pinned tunnel + token.
type execRequest struct {
	Cmd string `json:"cmd"`
	Dir string `json:"dir"`
}

// execControl is any client frame after the first: live stdin for the running
// process, an interrupt (Ctrl-C), or an explicit kill.
type execControl struct {
	Type string `json:"type"` // "stdin" | "signal" | "kill"
	Data string `json:"data"` // payload for "stdin"
	Sig  string `json:"sig"`  // for "signal": SIGINT (default) | SIGTERM | SIGKILL
}

// execHandler runs a raw shell command in the server's workdir and streams its
// stdout/stderr back live, one frame per chunk, staying open until the command
// exits, the client disconnects, or the client sends kill. Unlike /run it never
// spawns Claude — it is the direct "/run <cmd>" terminal channel. That makes it
// the most dangerous endpoint (arbitrary code as the server's user), so it only
// does anything when the operator started the server with -allow-exec.
func execHandler(token, baseWorkdir string, enabled bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r, token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !enabled {
			http.Error(w, "exec disabled (start the server with -allow-exec)", http.StatusForbidden)
			return
		}

		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			log.Printf("exec ws accept: %v", err)
			return
		}
		defer c.CloseNow()

		// First frame names the command, with a short deadline so a client that
		// connects but never speaks can't hold the socket.
		readCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, data, err := c.Read(readCtx)
		cancel()
		if err != nil {
			log.Printf("exec ws read: %v", err)
			return
		}
		var req execRequest
		if err := json.Unmarshal(data, &req); err != nil || strings.TrimSpace(req.Cmd) == "" {
			// 4400 (application range), not a reserved code — some WS clients
			// throw on reserved close codes and never surface the reason.
			c.Close(4400, "expected {cmd}")
			return
		}
		workdir, err := resolveExecDir(baseWorkdir, req.Dir)
		if err != nil {
			c.Close(4400, "bad dir")
			return
		}

		// No run-timeout: a dev server is meant to stay up. The run ends when the
		// command exits, the client disconnects (control-read loop cancels), or
		// the client sends kill. ctx cancellation SIGKILLs the whole group.
		ctx, cancelRun := context.WithCancel(context.Background())
		defer cancelRun()

		cmd := exec.CommandContext(ctx, "bash", "-lc", req.Cmd)
		cmd.Dir = workdir
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
		stderr, err := cmd.StderrPipe()
		if err != nil {
			c.Close(websocket.StatusInternalError, "stderr pipe")
			return
		}

		// Serialize every outbound frame: coder/websocket writes are not
		// concurrent-safe, and the two pump goroutines plus the exit path all
		// emit. A mutex is enough — frames are small and infrequent per source.
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
		log.Printf("exec: start %.60q in %s", req.Cmd, workdir)
		start := time.Now()

		// Control-read loop: stdin / signal / kill from the client. A read error
		// means the client is gone — cancel to tear the process group down.
		go func() {
			for {
				_, data, err := c.Read(ctx)
				if err != nil {
					cancelRun()
					return
				}
				var ctl execControl
				if json.Unmarshal(data, &ctl) != nil {
					continue
				}
				switch ctl.Type {
				case "stdin":
					_, _ = io.WriteString(stdin, ctl.Data)
				case "signal":
					signalGroup(cmd, strings.ToUpper(ctl.Sig))
				case "kill":
					cancelRun()
				}
			}
		}()

		// Pump stdout and stderr as raw chunks (not lines) so partial output —
		// prompts without a newline, progress bars — reaches the phone the moment
		// it is written. json.Marshal replaces any invalid UTF-8 with U+FFFD, so a
		// stray non-text byte degrades one glyph rather than dropping the frame.
		var wg sync.WaitGroup
		pump := func(rd io.Reader, stream string) {
			defer wg.Done()
			buf := make([]byte, 4096)
			for {
				n, rerr := rd.Read(buf)
				if n > 0 {
					send(map[string]any{"type": "log", "stream": stream, "data": string(buf[:n])})
				}
				if rerr != nil {
					return
				}
			}
		}
		wg.Add(2)
		go pump(stdout, "stdout")
		go pump(stderr, "stderr")
		wg.Wait() // both pipes at EOF: the process (and its group) has closed them

		waitErr := cmd.Wait()
		killGroup(cmd) // reap any stragglers so nothing keeps squatting resources
		code := 0
		if waitErr != nil {
			code = exitCode(waitErr)
		}
		log.Printf("exec: done in %s, exit=%d", time.Since(start).Round(time.Millisecond), code)

		// Final frame on a fresh context: if the client merely disconnected, ctx
		// is already cancelled and this no-ops; if the command exited on its own
		// we still report the code before closing cleanly.
		fin, _ := json.Marshal(map[string]any{"type": "exit", "code": code})
		wmu.Lock()
		_ = c.Write(context.Background(), websocket.MessageText, fin)
		wmu.Unlock()
		c.Close(websocket.StatusNormalClosure, "done")
	}
}

// resolveExecDir joins an optional client-supplied subdir under the base workdir,
// rejecting absolute paths and any ".." that would climb out. This confines only
// the *starting* directory (a shell can still cd away); it exists to keep an
// honest project selector from being a path-traversal footgun, not as a sandbox.
func resolveExecDir(base, sub string) (string, error) {
	if strings.TrimSpace(sub) == "" {
		return base, nil
	}
	clean := filepath.Clean(sub)
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("dir must be a relative subpath of the workdir")
	}
	return filepath.Join(base, clean), nil
}

// exitCode extracts the process exit status from a Wait error, or -1 when the
// failure wasn't a normal non-zero exit (e.g. killed by signal).
func exitCode(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}
