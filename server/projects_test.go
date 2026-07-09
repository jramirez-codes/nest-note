package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestProjectsHandler covers the /code autocomplete listing: it returns the
// directory names under the projects base (sorted, dotfiles skipped, files
// ignored), an empty list when /code is disabled, and 401 without the token.
func TestProjectsHandler(t *testing.T) {
	base := t.TempDir()
	for _, d := range []string{"beta", "alpha", ".git"} {
		if err := os.MkdirAll(filepath.Join(base, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// A stray file next to the dirs must not be offered as a project.
	if err := os.WriteFile(filepath.Join(base, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	const token = "secret"
	get := func(h http.HandlerFunc, auth bool) (int, projectsResponse) {
		req := httptest.NewRequest(http.MethodGet, "/projects", nil)
		if auth {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		h(rec, req)
		var body projectsResponse
		_ = json.NewDecoder(rec.Body).Decode(&body)
		return rec.Code, body
	}

	// Enabled: sorted dir names only.
	code, body := get(projectsHandler(token, base, true), true)
	if code != http.StatusOK {
		t.Fatalf("status: want 200, got %d", code)
	}
	if got := body.Projects; len(got) != 2 || got[0] != "alpha" || got[1] != "beta" {
		t.Fatalf("projects: want [alpha beta], got %v", got)
	}

	// Disabled: empty list, still 200 so the client treats it as "no suggestions".
	if code, body := get(projectsHandler(token, base, false), true); code != http.StatusOK || len(body.Projects) != 0 {
		t.Fatalf("disabled: want 200 + empty, got %d %v", code, body.Projects)
	}

	// No token: unauthorized.
	if code, _ := get(projectsHandler(token, base, true), false); code != http.StatusUnauthorized {
		t.Fatalf("unauthorized: want 401, got %d", code)
	}
}

// TestDeleteProjectHandler covers the destructive /projects/delete: it removes
// the slugged folder when enabled, refuses without the token (401) or with /code
// off (403), 404s an unknown project, and never touches anything outside the
// projects base — a traversal-y name just slugs down to a sibling folder.
func TestDeleteProjectHandler(t *testing.T) {
	const token = "secret"
	post := func(base, name string, enabled, auth bool) int {
		req := httptest.NewRequest(http.MethodPost, "/projects/delete",
			strings.NewReader(`{"project":`+strconv.Quote(name)+`}`))
		if auth {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		deleteProjectHandler(token, base, enabled).ServeHTTP(rec, req)
		return rec.Code
	}

	// Happy path: an existing project folder is actually removed from disk.
	base := t.TempDir()
	dir := filepath.Join(base, "alpha")
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if code := post(base, "Alpha", true, true); code != http.StatusOK {
		t.Fatalf("delete: want 200, got %d", code)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("delete: folder still present (err=%v)", err)
	}

	// Unknown project: 404, not a silent success.
	if code := post(base, "ghost", true, true); code != http.StatusNotFound {
		t.Fatalf("missing: want 404, got %d", code)
	}

	// /code disabled: 403 even with a valid token, and the folder survives.
	if err := os.MkdirAll(filepath.Join(base, "beta"), 0o755); err != nil {
		t.Fatal(err)
	}
	if code := post(base, "beta", false, true); code != http.StatusForbidden {
		t.Fatalf("disabled: want 403, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(base, "beta")); err != nil {
		t.Fatalf("disabled: folder should survive, got %v", err)
	}

	// No token: unauthorized, and the folder survives.
	if code := post(base, "beta", true, false); code != http.StatusUnauthorized {
		t.Fatalf("unauthorized: want 401, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(base, "beta")); err != nil {
		t.Fatalf("unauthorized: folder should survive, got %v", err)
	}
}
