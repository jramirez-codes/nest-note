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
// server, and restart it into the new binary — all from a note's `/update server`
// command. Like /exec it runs arbitrary local tooling (git, the Go compiler) as
// the server's user, but it's always enabled: it only ever runs this one fixed
// recipe (never caller-supplied commands), and it's still gated by the pinned
// tunnel + token like every other endpoint. The one thing the caller does choose
// is *which branch* to build — `/update server` takes main, `/update server foo`
// takes foo — and that name is validated (see validateBranch) before it ever
// reaches git.
//
// The hard part is a running server rebuilding and relaunching ITSELF. We can't
// hold the client connection across the restart, so the flow is:
//
//  1. Fetch + check out the requested branch, then `go build` into a *temporary*
//     binary. If any step fails the running process and its current binary are
//     untouched — we just report why.
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
const serverBinaryName = "nestnote-server"

// legacyServerBinaryName is what the binary was called before the NestNote
// rebrand. A deployment installed back then may be supervised by that path (a
// systemd unit, a launch script), so after every build we mirror the fresh
// binary onto it — otherwise the next reboot would silently start pre-rebrand
// code on a machine nobody can log into.
const legacyServerBinaryName = "ainotepad-server"

// repoDirName is the checkout directory under -root; legacyRepoDirName is what
// it was called before the rebrand (the GitHub repo moved ai-notepad ->
// nest-note). Deployments that cloned before the rename still have the old
// directory on disk, and self-update has to keep working on them untouched.
const (
	repoDirName       = "nest-note"
	legacyRepoDirName = "ai-notepad"
)

// defaultUpdateBranch is what a bare `/update server` builds: the branch the
// deployment is expected to track. `/update server <branch>` overrides it.
const defaultUpdateBranch = "main"

// maxBranchLen bounds a caller-supplied branch name. Nothing real is close to
// this; it just keeps a silly value out of a git command line.
const maxBranchLen = 200

// updateHandler runs on the pinned mux. A plain authed POST triggers the
// fetch/checkout/build/restart recipe; `?branch=<name>` picks the branch to build
// (default main); `?probe=1` is a cheap liveness check the phone polls after a
// restart to learn the new process is up. Always enabled — the recipe is fixed,
// only the branch is caller-controlled, and that's validated.
//
// root is the server's -root scaffold dir; the nest-note checkout lives at
// <root>/nest-note. repoOverride is the optional -repo-dir flag that points
// straight at the checkout instead. Resolving the repo this way (not from the
// running binary's location) is what lets git run in the real checkout even when
// the binary lives elsewhere (a temp `go run` build, a copied binary).
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

		// Which branch to build. Bare `/update server` means main.
		branch, err := validateBranch(r.URL.Query().Get("branch"))
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "phase": "branch", "out": err.Error()})
			return
		}

		// Locate the nest-note git checkout to update. This is the step that was
		// failing: the repo is <root>/nest-note, not necessarily next to the
		// running binary.
		repoDir, err := resolveRepo(root, repoOverride)
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "phase": "locate", "branch": branch, "out": err.Error()})
			return
		}
		serverDir := filepath.Join(repoDir, "server") // holds go.mod and the binary
		targetBin := filepath.Join(serverDir, serverBinaryName)

		// 1a. Fetch the branch, from the repo root. The explicit refspec updates
		// origin/<branch> even for a branch this checkout has never seen, so step 1b
		// has a ref to point the local branch at. GIT_TERMINAL_PROMPT=0 turns a
		// would-be credential prompt into an immediate error instead of a hung
		// process.
		fetchArgs := []string{"fetch", "origin", "+refs/heads/" + branch + ":refs/remotes/origin/" + branch}
		fetchOut, err := runUpdateStep(repoDir, 60*time.Second, []string{"GIT_TERMINAL_PROMPT=0"}, "git", fetchArgs...)
		if err != nil {
			out := "in " + repoDir + "\n$ git " + strings.Join(fetchArgs, " ") + "\n" + fetchOut + "\n" + err.Error()
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "phase": "fetch", "branch": branch, "out": tailStr(out)})
			return
		}

		// 1b. Move onto exactly what we just fetched. `-B` creates the local branch
		// or resets an existing one, so the build always matches origin/<branch>
		// rather than whatever this checkout happened to be sitting on. It aborts
		// (rather than discarding anything) if uncommitted local edits are in the
		// way — that's a clear error, not a silent data loss.
		coArgs := []string{"checkout", "-B", branch, "refs/remotes/origin/" + branch}
		coOut, err := runUpdateStep(repoDir, 60*time.Second, nil, "git", coArgs...)
		if err != nil {
			out := "in " + repoDir + "\n$ git " + strings.Join(coArgs, " ") + "\n" + coOut + "\n" + err.Error()
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "phase": "checkout", "branch": branch, "out": tailStr(out)})
			return
		}
		gitOut := strings.TrimSpace(fetchOut + "\n" + coOut)

		// 1c. Build to a temp path so a broken build never clobbers the live binary.
		newBin := targetBin + ".new"
		buildOut, err := runUpdateStep(serverDir, 3*time.Minute, nil, "go", "build", "-o", newBin, ".")
		if err != nil {
			_ = os.Remove(newBin)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "phase": "build", "branch": branch, "out": tailStr(gitOut + "\n" + buildOut + "\n" + err.Error())})
			return
		}

		// 2. Swap the fresh binary into place.
		if err := os.Rename(newBin, targetBin); err != nil {
			_ = os.Remove(newBin)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "phase": "swap", "branch": branch, "out": tailStr(err.Error())})
			return
		}

		// 2b. Keep a pre-rebrand binary path (if any) pointing at the new build, so
		// a supervisor or reboot can't resurrect the old code. Best effort — we
		// restart into the new name regardless.
		if err := mirrorLegacyBinary(serverDir, targetBin); err != nil {
			log.Printf("update: could not refresh legacy binary name: %v", err)
		}

		// 3. Tell the phone we're going down for a restart, and make sure it's on
		// the wire before we sever the connection.
		out := tailStr(gitOut + "\n" + buildOut)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "restarting": true, "branch": branch, "out": out})
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}

		// 4. Restart into the freshly-built binary. Off the handler goroutine so the
		// response fully drains first.
		go restartInto(targetBin)
	}
}

// validateBranch turns the caller's `?branch=` into the branch name to build,
// defaulting to main when it's absent or blank.
//
// The branch is the only part of the update recipe a note can steer, so it's
// checked rather than trusted. We never go through a shell — every step is
// exec'd with an argument list — so the risk isn't shell metacharacters, it's
// *git argument* injection: a name starting with `-` would be read as a flag
// (`--upload-pack=…` runs a command of the caller's choosing on fetch). So we
// require a conservative shape: a non-empty run of letters, digits, `.`, `_`,
// `-` and `/`, not starting with `-` or `/`, no `..` and no trailing `/` —
// which is a subset of what git itself accepts as a branch name.
func validateBranch(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return defaultUpdateBranch, nil
	}
	if len(name) > maxBranchLen {
		return "", fmt.Errorf("branch name is too long (max %d characters)", maxBranchLen)
	}
	bad := fmt.Errorf("%q is not a valid branch name: use letters, digits, and . _ - / (not starting with - or /)", name)
	if strings.HasPrefix(name, "-") || strings.HasPrefix(name, "/") ||
		strings.HasSuffix(name, "/") || strings.Contains(name, "..") {
		return "", bad
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.' || r == '_' || r == '-' || r == '/':
		default:
			return "", bad
		}
	}
	return name, nil
}

// resolveRepo finds the nest-note git checkout to self-update: the -repo-dir
// override if set, otherwise <root>/nest-note, falling back to the pre-rebrand
// <root>/ai-notepad when that's the directory actually on disk. Verifies it's a
// git work tree and returns its root, or a clear error explaining how to point
// us at it.
func resolveRepo(root, override string) (string, error) {
	repo := override
	if repo == "" {
		if root == "" {
			return "", fmt.Errorf("/update server needs the repo location: start the server with -root <dir> (the checkout is <root>/%s), or pass -repo-dir <path>", repoDirName)
		}
		repo = filepath.Join(root, repoDirName)
		if !isDir(repo) {
			if legacy := filepath.Join(root, legacyRepoDirName); isDir(legacy) {
				repo = legacy
			}
		}
	}
	top, err := gitToplevel(repo)
	if err != nil {
		return "", fmt.Errorf("no nest-note git checkout at %s: %v", repo, err)
	}
	return top, nil
}

// isDir reports whether path exists and is a directory (following symlinks, so a
// checkout symlinked into place still counts).
func isDir(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}

// mirrorLegacyBinary copies the freshly-built binary over the pre-rebrand
// binary name, but only when that file already exists — i.e. only for
// deployments that were installed before the rename and may still be launched
// through it. Best effort: a failure here doesn't fail the update, since the
// new name is what we actually restart into. Writing via a temp file + rename
// keeps the swap atomic and is safe even if the running process IS that binary
// (Linux keeps our inode alive until we exit).
func mirrorLegacyBinary(serverDir, freshBin string) error {
	legacy := filepath.Join(serverDir, legacyServerBinaryName)
	if _, err := os.Stat(legacy); err != nil {
		return nil // no pre-rebrand install here; nothing to keep in sync
	}
	data, err := os.ReadFile(freshBin)
	if err != nil {
		return err
	}
	tmp := legacy + ".new"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp, legacy); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
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
//
// Under systemd (INVOCATION_ID is set on every process a unit starts) this
// self-relaunch is skipped entirely: the binary is already swapped in place, so
// we just exit and let Restart=always bring the unit back up as the tracked
// main process. Spawning our own detached child here too would race the
// supervisor's own restart for the port a few seconds later — both end up
// trying to bind :8443, and the loser crash-loops forever.
func restartInto(bin string) {
	if os.Getenv("INVOCATION_ID") != "" {
		time.Sleep(restartDelay / 2)
		os.Exit(0)
	}
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
