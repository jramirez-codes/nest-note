package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRestoreCardAction covers POST /action "restore" — the idea page's undo. A
// snapshot the phone held is written back over the card's four content fields
// (title, body, tags, priority) and nothing else on the card is touched, so
// undoing an edit Claude made can't also un-complete a task or resurrect a
// dismissed card.
func TestRestoreCardAction(t *testing.T) {
	root := t.TempDir()
	mcpDir := filepath.Join(root, "mcp")
	const token = "secret"
	const slug = "storage-migration"
	const id = "card-42"

	writeFileT(t, filepath.Join(mcpDir, slug, notebookManifest), `{"slug":"storage-migration"}`)
	cardPath := filepath.Join(cardsDirFor(mcpDir, slug), id+".json")
	writeFileT(t, cardPath, `{
  "id": "card-42",
  "kind": "idea",
  "priority": "high",
  "title": "Claude's rewrite",
  "body": "## Problem\n\nRewritten by Claude.\n",
  "tags": ["claude-added"],
  "done": true,
  "source": "storage-migration",
  "created_at": "2026-07-01T10:00:00Z",
  "updated_at": "2026-07-20T10:00:00Z"
}
`)

	postAction := func(body map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/action?token="+token, strings.NewReader(string(b)))
		rr := httptest.NewRecorder()
		actionHandler(token, root)(rr, req)
		return rr
	}
	readCard := func() dashCard {
		t.Helper()
		data, err := os.ReadFile(cardPath)
		if err != nil {
			t.Fatal(err)
		}
		var c dashCard
		if err := json.Unmarshal(data, &c); err != nil {
			t.Fatal(err)
		}
		return c
	}

	snapshot := map[string]any{
		"action":   "restore",
		"id":       id,
		"source":   slug,
		"title":    "Move storage to SQLite",
		"body":     "## Problem\n\nAs the user wrote it.\n",
		"tags":     []string{"storage", "v1"},
		"priority": "normal",
	}
	if rr := postAction(snapshot); rr.Code != http.StatusOK {
		t.Fatalf("restore code=%d body=%s", rr.Code, rr.Body.String())
	}

	got := readCard()
	if got.Title != "Move storage to SQLite" || !strings.Contains(got.Body, "As the user wrote it") {
		t.Fatalf("title/body should be the snapshot's, got %+v", got)
	}
	if got.Priority != "normal" || strings.Join(got.Tags, ",") != "storage,v1" {
		t.Fatalf("priority/tags should be the snapshot's, got priority=%q tags=%v", got.Priority, got.Tags)
	}
	// Everything that isn't content is left exactly as it was.
	if !got.Done || got.Kind != "idea" || got.ID != id || got.CreatedAt != "2026-07-01T10:00:00Z" {
		t.Fatalf("restore must only touch content fields, got %+v", got)
	}
	if got.UpdatedAt == "2026-07-20T10:00:00Z" {
		t.Fatalf("restore should bump updated_at")
	}

	// The source hint is only a hint: without it the card is still found.
	snapshot["source"] = ""
	snapshot["title"] = "Found without a hint"
	if rr := postAction(snapshot); rr.Code != http.StatusOK {
		t.Fatalf("restore without source code=%d body=%s", rr.Code, rr.Body.String())
	}
	if readCard().Title != "Found without a hint" {
		t.Fatalf("restore should search notebooks when source is absent")
	}

	// A card that isn't there 404s rather than creating one; a traversal-shaped
	// id is rejected outright.
	if rr := postAction(map[string]any{"action": "restore", "id": "card-99"}); rr.Code != http.StatusNotFound {
		t.Fatalf("unknown card should 404, got %d", rr.Code)
	}
	if rr := postAction(map[string]any{"action": "restore", "id": "../../etc/passwd"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("bad id should 400, got %d", rr.Code)
	}
}
