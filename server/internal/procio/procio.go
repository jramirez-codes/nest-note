// Package procio manages the process groups of the commands the server spawns.
// Every long-running child — the Claude runner, a /exec shell, a build step —
// forks further children of its own, so the server always signals the whole
// group rather than the leader alone.
package procio

import (
	"os/exec"
	"strings"
	"syscall"
)

// BoundedBuffer is an io.Writer that keeps at most Limit bytes, discarding the
// rest. Every spawned process's stderr is captured through one of these: a
// non-zero exit needs to surface *why* it failed, but a runaway process must not
// be able to balloon the server's memory doing it.
type BoundedBuffer struct {
	buf   strings.Builder
	Limit int
}

func (b *BoundedBuffer) Write(p []byte) (int, error) {
	if remaining := b.Limit - b.buf.Len(); remaining > 0 {
		if len(p) > remaining {
			b.buf.Write(p[:remaining])
		} else {
			b.buf.Write(p)
		}
	}
	// Report the full length written so the caller never sees a short write and
	// errors out; we're intentionally dropping the overflow.
	return len(p), nil
}

func (b *BoundedBuffer) String() string { return b.buf.String() }

// SetGroup puts cmd in its own process group and arranges for the whole group —
// cmd plus every child it spawns — to be SIGKILLed when the command's context is
// cancelled. Both the Claude runner and the /exec handler depend on this: Claude
// forks MCP servers, and a /exec shell forks whatever it launches (a dev server,
// a test runner). Without the group, a cancelled or disconnected run leaks a
// subtree that keeps stdout's write end open (blocking our reader on EOF
// forever) or squats a port.
func SetGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			// Negative pid signals the whole process group, not just the leader.
			return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
}

// KillGroup SIGKILLs cmd's entire process group. Called after Wait to reap any
// children the command left behind so they release inherited pipes. ESRCH (the
// group is already gone) is the expected case and safely ignored.
func KillGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

// SignalGroup sends sig (default SIGINT) to cmd's whole process group — the
// wire-level "Ctrl-C" for /exec. A dev server started via `bash -lc` is a child
// of the shell, so signalling the group reaches it, not just the shell.
func SignalGroup(cmd *exec.Cmd, sig string) {
	if cmd.Process == nil {
		return
	}
	s := syscall.SIGINT
	switch sig {
	case "SIGTERM":
		s = syscall.SIGTERM
	case "SIGKILL":
		s = syscall.SIGKILL
	}
	_ = syscall.Kill(-cmd.Process.Pid, s)
}
