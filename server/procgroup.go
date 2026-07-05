package main

import (
	"os/exec"
	"syscall"
)

// setProcGroup puts cmd in its own process group and arranges for the whole
// group — cmd plus every child it spawns — to be SIGKILLed when the command's
// context is cancelled. Both the Claude runner (claude.go) and the /exec handler
// (exec.go) depend on this: Claude forks MCP servers, and a /run shell forks
// whatever it launches (a dev server, a test runner). Without the group, a
// cancelled or disconnected run leaks a subtree that keeps stdout's write end
// open (blocking our reader on EOF forever) or squats a port.
func setProcGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			// Negative pid signals the whole process group, not just the leader.
			return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
}

// killGroup SIGKILLs cmd's entire process group. Called after Wait to reap any
// children the command left behind so they release inherited pipes. ESRCH (the
// group is already gone) is the expected case and safely ignored.
func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

// signalGroup sends sig (default SIGINT) to cmd's whole process group — the
// wire-level "Ctrl-C" for /exec. A dev server started via `bash -lc` is a child
// of the shell, so signalling the group reaches it, not just the shell.
func signalGroup(cmd *exec.Cmd, sig string) {
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
