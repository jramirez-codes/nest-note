package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// resolveRepo should find the checkout at <root>/nest-note and return its git
// work-tree root. We simulate the deployment layout by symlinking a temp root's
// nest-note/ at this very repo.
func TestResolveRepoUnderRoot(t *testing.T) {
	repoRoot, err := gitToplevel(".")
	if err != nil {
		t.Skipf("tests not running inside a git checkout: %v", err)
	}
	root := t.TempDir()
	if err := os.Symlink(repoRoot, filepath.Join(root, "nest-note")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	got, err := resolveRepo(root, "")
	if err != nil {
		t.Fatalf("resolveRepo(%q): %v", root, err)
	}
	// git resolves the symlink, so compare the real path.
	want, _ := filepath.EvalSymlinks(repoRoot)
	if gotReal, _ := filepath.EvalSymlinks(got); gotReal != want {
		t.Fatalf("resolveRepo = %q, want %q", gotReal, want)
	}
	if _, err := os.Stat(filepath.Join(got, "server", "main.go")); err != nil {
		t.Fatalf("resolved repo has no server/main.go: %v", err)
	}
}

// The -repo-dir override wins over <root>/nest-note.
func TestResolveRepoOverride(t *testing.T) {
	repoRoot, err := gitToplevel(".")
	if err != nil {
		t.Skipf("tests not running inside a git checkout: %v", err)
	}
	got, err := resolveRepo("/does/not/matter", repoRoot)
	if err != nil {
		t.Fatalf("resolveRepo override: %v", err)
	}
	if _, err := os.Stat(filepath.Join(got, "server", "main.go")); err != nil {
		t.Fatalf("override repo has no server/main.go: %v", err)
	}
}

// A machine that cloned before the rebrand still has <root>/ai-notepad. Those
// deployments must keep self-updating without anyone logging in to rename it.
func TestResolveRepoLegacyCheckoutName(t *testing.T) {
	repoRoot, err := gitToplevel(".")
	if err != nil {
		t.Skipf("tests not running inside a git checkout: %v", err)
	}
	root := t.TempDir()
	if err := os.Symlink(repoRoot, filepath.Join(root, legacyRepoDirName)); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	got, err := resolveRepo(root, "")
	if err != nil {
		t.Fatalf("resolveRepo(%q) with only a legacy checkout: %v", root, err)
	}
	want, _ := filepath.EvalSymlinks(repoRoot)
	if gotReal, _ := filepath.EvalSymlinks(got); gotReal != want {
		t.Fatalf("resolveRepo = %q, want %q", gotReal, want)
	}
}

// With both names present the current one wins, so a machine that has been
// migrated doesn't keep pulling into a stale directory.
func TestResolveRepoPrefersCurrentName(t *testing.T) {
	repoRoot, err := gitToplevel(".")
	if err != nil {
		t.Skipf("tests not running inside a git checkout: %v", err)
	}
	root := t.TempDir()
	if err := os.Symlink(repoRoot, filepath.Join(root, repoDirName)); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	// A legacy directory that is NOT a git checkout: picking it would error out.
	if err := os.Mkdir(filepath.Join(root, legacyRepoDirName), 0o755); err != nil {
		t.Fatalf("mkdir legacy: %v", err)
	}
	if _, err := resolveRepo(root, ""); err != nil {
		t.Fatalf("resolveRepo should prefer %s/: %v", repoDirName, err)
	}
}

// The freshly-built binary is mirrored onto the pre-rebrand name only when that
// file already exists, so an old systemd unit or launch script pointing at it
// starts the new code rather than resurrecting the old build.
func TestMirrorLegacyBinary(t *testing.T) {
	serverDir := t.TempDir()
	fresh := filepath.Join(serverDir, serverBinaryName)
	if err := os.WriteFile(fresh, []byte("new-build"), 0o755); err != nil {
		t.Fatalf("write fresh binary: %v", err)
	}
	legacy := filepath.Join(serverDir, legacyServerBinaryName)

	// No pre-rebrand install: must not create the old name out of thin air.
	if err := mirrorLegacyBinary(serverDir, fresh); err != nil {
		t.Fatalf("mirrorLegacyBinary with no legacy binary: %v", err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy binary should not have been created, stat err = %v", err)
	}

	// Pre-rebrand install: the old path must end up holding the new build.
	if err := os.WriteFile(legacy, []byte("old-build"), 0o755); err != nil {
		t.Fatalf("write legacy binary: %v", err)
	}
	if err := mirrorLegacyBinary(serverDir, fresh); err != nil {
		t.Fatalf("mirrorLegacyBinary: %v", err)
	}
	got, err := os.ReadFile(legacy)
	if err != nil {
		t.Fatalf("read legacy binary: %v", err)
	}
	if string(got) != "new-build" {
		t.Fatalf("legacy binary = %q, want the fresh build", got)
	}
	if fi, err := os.Stat(legacy); err != nil || fi.Mode().Perm()&0o111 == 0 {
		t.Fatalf("legacy binary must stay executable (mode %v, err %v)", fi.Mode(), err)
	}
	if _, err := os.Stat(legacy + ".new"); !os.IsNotExist(err) {
		t.Fatalf("temp file should not survive, stat err = %v", err)
	}
}

func TestResolveRepoErrors(t *testing.T) {
	// No -root and no -repo-dir: must explain how to point us at the checkout.
	if _, err := resolveRepo("", ""); err == nil || !strings.Contains(err.Error(), "-root") {
		t.Fatalf("expected a -root/-repo-dir hint, got %v", err)
	}
	// A root whose nest-note/ doesn't exist: must name the path it looked for.
	root := t.TempDir()
	_, err := resolveRepo(root, "")
	if err == nil || !strings.Contains(err.Error(), filepath.Join(root, "nest-note")) {
		t.Fatalf("expected a missing-checkout error naming the path, got %v", err)
	}
}
