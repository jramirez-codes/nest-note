package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
