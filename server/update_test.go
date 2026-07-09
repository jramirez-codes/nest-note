package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// resolveRepo should find the checkout at <root>/ai-notepad and return its git
// work-tree root. We simulate the deployment layout by symlinking a temp root's
// ai-notepad/ at this very repo.
func TestResolveRepoUnderRoot(t *testing.T) {
	repoRoot, err := gitToplevel(".")
	if err != nil {
		t.Skipf("tests not running inside a git checkout: %v", err)
	}
	root := t.TempDir()
	if err := os.Symlink(repoRoot, filepath.Join(root, "ai-notepad")); err != nil {
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

// The -repo-dir override wins over <root>/ai-notepad.
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

func TestResolveRepoErrors(t *testing.T) {
	// No -root and no -repo-dir: must explain how to point us at the checkout.
	if _, err := resolveRepo("", ""); err == nil || !strings.Contains(err.Error(), "-root") {
		t.Fatalf("expected a -root/-repo-dir hint, got %v", err)
	}
	// A root whose ai-notepad/ doesn't exist: must name the path it looked for.
	root := t.TempDir()
	_, err := resolveRepo(root, "")
	if err == nil || !strings.Contains(err.Error(), filepath.Join(root, "ai-notepad")) {
		t.Fatalf("expected a missing-checkout error naming the path, got %v", err)
	}
}
