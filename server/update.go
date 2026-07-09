package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// The /update feature lets a paired phone pull the latest code, rebuild this Go
// server, and restart it into the new binary — all from a note's `/update-server`
// command. Like /exec it runs arbitrary local tooling (git, the Go compiler) as
// the server's user, but it's always enabled: it only ever runs this one fixed
// recipe (never caller-supplied commands), and it's still gated by the pinned
// tunnel + token like every other endpoint.
//
// The hard part is a running server rebuilding and relaunching ITSELF. We can't
// hold the client connection across the restart, so the flow is:
//
//  1. `git pull` then `go build` into a *temporary* binary. If either fails the
//     running process and its current binary are untouched — we just report why.
//  2. Atomically rename the fresh binary over our own (safe while we're running;
//     Linux keeps our inode alive until we exit).
//  3. Reply {ok, restarting} to the phone and flush it.
//  4. Spawn a DETACHED child (its own session) that waits a beat, then execs the
//     new binary with our exact flags, and exit so the port frees for it.
//
// The phone, on seeing {restarting}, polls `/update?probe=1` until the new
// process answers — that's how the card flips to "reconnected".

// updateOutputTail caps how much pull+build output we echo back to the phone, so
// a chatty build can't bloat the note the card is inlined into.
const updateOutputTail = 4000

// restartDelay is how long the relaunched child sleeps before exec-ing, giving
// this process time to flush its response and exit (freeing the port) first. We
// exit at half this, so the response gets ~half to reach the phone and the child
// still binds only after we're gone.
const restartDelay = 2 * time.Second

// serverBinaryName is the name the server is built and launched as (matches the
// README build step and server/.gitignore). We build/swap/relaunch this fixed
// name inside the repo's server/ dir rather than trusting os.Executable(), which
// points into a temp dir under `go run` and needn't even sit in the repo.
const serverBinaryName = "ainotepad-server"

// updateHandler runs on the pinned mux. A plain authed POST triggers the
// pull/build/restart recipe; `?probe=1` is a cheap liveness check the phone polls
// after a restart to learn the new process is up. Always enabled — the recipe is
// fixed, not caller-controlled.
//
// root is the server's -root scaffold dir; the ai-notepad checkout lives at
// <root>/ai-notepad. repoOverride is the optional -repo-dir flag that points
// straight at the checkout instead. Resolving the repo this way (not from the
// running binary's location) is what lets `git pull` run in the real checkout
// even when the binary lives elsewhere (a temp `go run` build, a copied binary).
func updateHandler(token, root, repoOverride string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r, token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")

		// Liveness probe: the phone hits this in a loop after a restart until the
		// freshly-launched process answers. Does nothing else.
		if r.URL.Query().Get("probe") != "" {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "probe": true})
			return
		}

		// Locate the ai-notepad git checkout to update. This is the step that was
		// failing: the repo is <root>/ai-notepad, not necessarily next to the
		// running binary.
		repoDir, err := resolveRepo(root, repoOverride)
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "phase": "locate", "out": err.Error()})
			return
		}
		serverDir := filepath.Join(repoDir, "server") // holds go.mod and the binary
		targetBin := filepath.Join(serverDir, serverBinaryName)

		// 1a. Pull, from the repo root. GIT_TERMINAL_PROMPT=0 turns a would-be
		// credential prompt into an immediate error instead of a hung process.
		pullOut, err := runUpdateStep(repoDir, 60*time.Second, []string{"GIT_TERMINAL_PROMPT=0"}, "git", "pull")
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "phase": "pull", "out": tailStr("in " + repoDir + "\n$ git pull\n" + pullOut + "\n" + err.Error())})
			return
		}

		// 1b. Build to a temp path so a broken build never clobbers the live binary.
		newBin := targetBin + ".new"
		buildOut, err := runUpdateStep(serverDir, 3*time.Minute, nil, "go", "build", "-o", newBin, ".")
		if err != nil {
			_ = os.Remove(newBin)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "phase": "build", "out": tailStr(pullOut + "\n" + buildOut + "\n" + err.Error())})
			return
		}

		// 2. Swap the fresh binary into place.
		if err := os.Rename(newBin, targetBin); err != nil {
			_ = os.Remove(newBin)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "phase": "swap", "out": tailStr(err.Error())})
			return
		}

		// 3. Tell the phone we're going down for a restart, and make sure it's on
		// the wire before we sever the connection.
		out := tailStr(pullOut + "\n" + buildOut)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "restarting": true, "out": out})
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}

		// 4. Restart into the freshly-built binary. Off the handler goroutine so the
		// response fully drains first.
		go restartInto(targetBin)
	}
}

// resolveRepo finds the ai-notepad git checkout to self-update: the -repo-dir
// override if set, otherwise <root>/ai-notepad. Verifies it's actually a git work
// tree and returns its root, or a clear error explaining how to point us at it.
func resolveRepo(root, override string) (string, error) {
	repo := override
	if repo == "" {
		if root == "" {
			return "", fmt.Errorf("/update-server needs the repo location: start the server with -root <dir> (the checkout is <root>/ai-notepad), or pass -repo-dir <path>")
		}
		repo = filepath.Join(root, "ai-notepad")
	}
	top, err := gitToplevel(repo)
	if err != nil {
		return "", fmt.Errorf("no ai-notepad git checkout at %s: %v", repo, err)
	}
	return top, nil
}

// gitToplevel returns the git work-tree root containing dir, or an error if dir
// isn't a directory or isn't inside a git repo.
func gitToplevel(dir string) (string, error) {
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("not a directory: %s", dir)
	}
	out, err := runUpdateStep(dir, 10*time.Second, nil, "git", "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// runUpdateStep runs one fixed command in `dir` with a timeout and merged
// stdout/stderr, returning the combined output. extraEnv is appended to the
// current environment. A non-nil error means the command failed or timed out.
func runUpdateStep(dir string, timeout time.Duration, extraEnv []string, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return buf.String(), err
}

// restartInto relaunches this server from the freshly-built binary at `bin`
// (the swapped-in one, which may differ from os.Executable() under `go run`) with
// the same flags and workdir, then exits so the child can take the port. The
// child runs in its own session (Setsid) so it survives our exit, sleeps briefly
// so the port is free by the time it binds, then replaces itself with the server
// via exec. Its stdio goes to a log beside the binary.
func restartInto(bin string) {
	wd, err := os.Getwd()
	if err != nil {
		wd = filepath.Dir(bin)
	}
	// `sh -c 'sleep …; exec "$0" "$@"' <bin> <flags…>` — using $0/$@ passes our
	// flags through untouched, with no quoting to get wrong.
	script := "sleep " + strconv.Itoa(restartSeconds()) + "; exec \"$0\" \"$@\""
	shArgs := append([]string{"-c", script, bin}, os.Args[1:]...)
	child := exec.Command("sh", shArgs...)
	child.Dir = wd
	child.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if logf, e := os.OpenFile(filepath.Join(filepath.Dir(bin), "update-restart.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); e == nil {
		child.Stdout = logf
		child.Stderr = logf
	}
	if err := child.Start(); err != nil {
		// Couldn't spawn the replacement — stay up rather than exit into nothing.
		log.Printf("update: relaunch failed, staying on old binary: %v", err)
		return
	}
	_ = child.Process.Release()
	// Give the flushed response a moment to reach the phone, then exit to free the
	// port well before the child's sleep elapses.
	time.Sleep(restartDelay / 2)
	os.Exit(0)
}

// restartSeconds renders restartDelay as a whole-second count for `sleep`.
func restartSeconds() int {
	s := int(restartDelay / time.Second)
	if s < 1 {
		s = 1
	}
	return s
}

// tailStr trims output to the last updateOutputTail bytes (on a rune boundary),
// prefixing an ellipsis when truncated, so the phone card stays small.
func tailStr(s string) string {
	s = strings.TrimSpace(s)
	if len(s) <= updateOutputTail {
		return s
	}
	cut := s[len(s)-updateOutputTail:]
	// Advance to the next line break so we don't start mid-line/mid-rune.
	for i := 0; i < len(cut); i++ {
		if cut[i] == '\n' {
			cut = cut[i+1:]
			break
		}
	}
	return "…\n" + cut
}
