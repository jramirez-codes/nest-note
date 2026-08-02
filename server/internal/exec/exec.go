// Package exec runs the /exec endpoint: an arbitrary shell command in a durable
// session, with live stdin and POSIX signals over the socket. It is the server's
// most powerful capability and does nothing unless -allow-exec is set.
package exec

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

	"nestnote/server/internal/httpx"
	"nestnote/server/internal/procio"
	"nestnote/server/internal/session"
)

// execRequest is the first frame the client sends. SessionID keys the durable
// session; ResumeOnly reconnects to an existing one (or gets `gone`). Cmd/Dir
// start a new session's shell — the subdir only sets the *starting* directory (a
// shell can cd anywhere the server's user can), so it is a convenience, not a
// security boundary. The real gate is -allow-exec plus the pinned tunnel + token.
type execRequest struct {
	SessionID  string `json:"sessionId"`
	ResumeOnly bool   `json:"resumeOnly"`
	Cmd        string `json:"cmd"`
	Dir        string `json:"dir"`
}

// execControl is any client frame after the first: live stdin for the running
// process, an interrupt (Ctrl-C), or an explicit kill.
type execControl struct {
	Type string `json:"type"` // "stdin" | "signal" | "kill"
	Data string `json:"data"` // payload for "stdin"
	Sig  string `json:"sig"`  // for "signal": SIGINT (default) | SIGTERM | SIGKILL
}

// Handler runs a raw shell command in the server's workdir and streams its
// stdout/stderr back live, one frame per chunk, staying open until the command
// exits, the client disconnects, or the client sends kill. Unlike /run it never
// spawns Claude — it is the direct "/run <cmd>" terminal channel. That makes it
// the most dangerous endpoint (arbitrary code as the server's user), so it only
// does anything when the operator started the server with -allow-exec.
func Handler(token, baseWorkdir string, enabled bool, reg *session.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !httpx.Guard(w, r, token) {
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

		// First frame names the session (and, for a new one, the command), with a
		// short deadline so a client that connects but never speaks can't hold it.
		readCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, data, err := c.Read(readCtx)
		cancel()
		if err != nil {
			log.Printf("exec ws read: %v", err)
			return
		}
		var req execRequest
		if err := json.Unmarshal(data, &req); err != nil {
			// 4400 (application range), not a reserved code — some WS clients
			// throw on reserved close codes and never surface the reason.
			c.Close(4400, "expected {sessionId | cmd}")
			return
		}

		if req.ResumeOnly {
			sess := reg.Get(strings.TrimSpace(req.SessionID))
			if strings.TrimSpace(req.SessionID) == "" || sess == nil {
				session.WriteGone(c)
				return
			}
			serveExecSocket(c, sess, reg)
			return
		}

		// No sessionId: an un-updated client wanting the old, non-durable behaviour
		// — mint an ephemeral id (unresumable, killed on disconnect).
		id := strings.TrimSpace(req.SessionID)
		ephemeral := id == ""
		if ephemeral {
			id = session.RandomID()
		}
		sess, created := reg.FindOrCreate(id, session.KindExec)
		if !created {
			serveExecSocket(c, sess, reg)
			return
		}
		sess.SetEphemeral(ephemeral)
		if strings.TrimSpace(req.Cmd) == "" {
			reg.Remove(id)
			c.Close(4400, "expected {cmd}")
			return
		}
		workdir, err := resolveExecDir(baseWorkdir, req.Dir)
		if err != nil {
			reg.Remove(id)
			c.Close(4400, "bad dir")
			return
		}

		// Start the shell in a socket-independent owner goroutine (survives this
		// socket dropping unless ephemeral), then attach + run the control loop.
		startExecProcess(sess, workdir, req.Cmd)
		serveExecSocket(c, sess, reg)
	}
}

// startExecProcess launches the durable shell for a fresh session and pumps its
// stdout/stderr into the session buffer from a goroutine not tied to any socket.
// No run-timeout: a dev server is meant to stay up; it ends on kill, the command
// exiting, or the orphan TTL.
func startExecProcess(sess *session.Session, workdir, cmdStr string) {
	ctx, cancelRun := context.WithCancel(context.Background())
	sess.SetCancel(cancelRun)

	cmd := exec.CommandContext(ctx, "bash", "-lc", cmdStr)
	cmd.Dir = workdir
	procio.SetGroup(cmd)

	fail := func(msg string) {
		sess.Emit(session.MustJSON(map[string]any{"type": "error", "message": msg}))
		sess.Emit(session.MustJSON(map[string]any{"type": "exit", "code": -1}))
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
	stderr, err := cmd.StderrPipe()
	if err != nil {
		fail("stderr pipe: " + err.Error())
		return
	}

	// Wire the session's control hooks: stdin feeds live input, signal delivers a
	// POSIX signal to the group. Any attached socket's control loop calls these.
	sess.SetHooks(
		func(d string) { _, _ = io.WriteString(stdin, d) },
		func(sig string) { procio.SignalGroup(cmd, strings.ToUpper(sig)) },
	)

	if err := cmd.Start(); err != nil {
		fail(err.Error())
		return
	}
	log.Printf("exec: start %.60q in %s", cmdStr, workdir)

	go func() {
		start := time.Now()
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
					sess.Emit(session.MustJSON(map[string]any{"type": "log", "stream": stream, "data": string(buf[:n])}))
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
		procio.KillGroup(cmd) // reap any stragglers so nothing keeps squatting resources
		code := 0
		if waitErr != nil {
			code = exitCode(waitErr)
		}
		log.Printf("exec: done in %s, exit=%d", time.Since(start).Round(time.Millisecond), code)
		sess.Emit(session.MustJSON(map[string]any{"type": "exit", "code": code}))
		sess.MarkDone()
		cancelRun()
	}()
}

// serveExecSocket attaches c (replaying the buffered tail) and runs the control
// loop for stdin/signal/kill. On a socket read error the client is gone: detach
// but leave the shell running for the next reconnect.
func serveExecSocket(c *websocket.Conn, sess *session.Session, reg *session.Registry) {
	sess.Attach(c)
	for {
		_, data, err := c.Read(context.Background())
		if err != nil {
			if sess.Ephemeral() {
				sess.Kill()
				reg.Remove(sess.ID())
			}
			sess.Detach(c)
			return
		}
		var ctl execControl
		if json.Unmarshal(data, &ctl) != nil {
			continue
		}
		input, signal := sess.Hooks()
		switch ctl.Type {
		case "stdin":
			if input != nil {
				input(ctl.Data)
			}
		case "signal":
			if signal != nil {
				signal(ctl.Sig)
			}
		case "kill":
			sess.Kill()
			reg.Remove(sess.ID())
			sess.Detach(c)
			return
		}
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
