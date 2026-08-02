package dashboard

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nestnote/server/internal/build"
	"nestnote/server/internal/cron"
	"nestnote/server/internal/store"
)

// postActionT posts one /action body to ActionHandler rooted at root.
func postActionT(t *testing.T, root, token string, cfg build.Config, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/action?token="+token, strings.NewReader(string(b)))
	rr := httptest.NewRecorder()
	ActionHandler(token, root, cfg)(rr, req)
	return rr
}

// TestDeleteNotebookAction covers POST /action "delete-notebook" — the switcher's
// swipe-to-delete. The notebook's whole folder and its built binary go, along with
// every orchestrator proposal keyed on the slug, while its neighbour is untouched.
func TestDeleteNotebookAction(t *testing.T) {
	root := t.TempDir()
	mcpDir, stateDir := store.RootDirs(root)
	const token = "secret"
	const slug = "storage-migration"
	const keep = "reading-list"

	writeFileT(t, filepath.Join(mcpDir, slug, store.NotebookManifest), `{"slug":"storage-migration"}`)
	writeFileT(t, filepath.Join(store.NotesDirFor(mcpDir, slug), "#1 (Notes).md"), "# Notes\n")
	writeFileT(t, filepath.Join(store.CardsDirFor(mcpDir, slug), "card-1.json"), `{"id":"card-1","source":"storage-migration"}`)
	writeFileT(t, filepath.Join(mcpDir, "bin", slug), "binary")
	writeFileT(t, filepath.Join(stateDir, "reorgs", slug+".json"), `{"subject":"storage-migration"}`)
	writeFileT(t, filepath.Join(stateDir, "suggestions", slug+".json"), `{"into":"storage-migration","from":["reading-list"]}`)

	// A neighbour notebook, plus a suggestion of its own that names the doomed one.
	writeFileT(t, filepath.Join(mcpDir, keep, store.NotebookManifest), `{"slug":"reading-list"}`)
	keepSug := filepath.Join(stateDir, "suggestions", keep+".json")
	writeFileT(t, keepSug, `{"into":"reading-list","from":["storage-migration","inbox"],"reason":"same topic"}`)

	if rr := postActionT(t, root, token, build.Config{}, map[string]any{"action": "delete-notebook", "subject": slug}); rr.Code != http.StatusOK {
		t.Fatalf("delete code=%d body=%s", rr.Code, rr.Body.String())
	}

	if _, err := os.Stat(filepath.Join(mcpDir, slug)); !os.IsNotExist(err) {
		t.Fatalf("notebook folder should be gone, stat err=%v", err)
	}
	for _, gone := range []string{
		filepath.Join(mcpDir, "bin", slug),
		filepath.Join(stateDir, "reorgs", slug+".json"),
		filepath.Join(stateDir, "suggestions", slug+".json"),
	} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Fatalf("%s should be gone, stat err=%v", gone, err)
		}
	}

	// The neighbour survives, with the deleted slug pruned from its merge suggestion.
	if !store.IsNotebook(mcpDir, keep) {
		t.Fatalf("%s should be untouched", keep)
	}
	data, err := os.ReadFile(keepSug)
	if err != nil {
		t.Fatal(err)
	}
	var s Suggestion
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatal(err)
	}
	if strings.Join(s.From, ",") != "inbox" {
		t.Fatalf("deleted slug should be pruned from `from`, got %v", s.From)
	}
	if s.Reason != "same topic" {
		t.Fatalf("the rest of the suggestion should survive, got %+v", s)
	}

	// Deleting again reports "already gone" rather than a silent success.
	if rr := postActionT(t, root, token, build.Config{}, map[string]any{"action": "delete-notebook", "subject": slug}); rr.Code != http.StatusNotFound {
		t.Fatalf("second delete code=%d, want 404", rr.Code)
	}
}

// TestDeleteNotebookActionRejectsBadSlug covers the guard rail: a traversal attempt
// or the reserved orchestrator notebook is a 400 and leaves the disk alone.
func TestDeleteNotebookActionRejectsBadSlug(t *testing.T) {
	root := t.TempDir()
	mcpDir, _ := store.RootDirs(root)
	const token = "secret"

	writeFileT(t, filepath.Join(mcpDir, store.OrchestratorSlug, store.NotebookManifest), `{"slug":"orchestrator"}`)

	for _, subject := range []string{store.OrchestratorSlug, "../mcp", "bin", ""} {
		rr := postActionT(t, root, token, build.Config{}, map[string]any{"action": "delete-notebook", "subject": subject})
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("subject %q: code=%d, want 400", subject, rr.Code)
		}
	}
	if !store.IsNotebook(mcpDir, store.OrchestratorSlug) {
		t.Fatal("the orchestrator notebook must survive")
	}
}

// TestDeletingANotebookStopsItsBuild is the other door into the build cleanup that
// TestDismissingAnIdeaStopsItsBuild covers: deleting a notebook takes the idea card
// a build was started from, so the build must not outlive it with a crontab line
// still armed. Same invariant, reached by deleting the whole notebook at once
// rather than one card.
func TestDeletingANotebookStopsItsBuild(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	ct := &fakeCrontab{content: "0 9 * * * /usr/bin/backup  # mine\n"}
	f.cfg.Cron = ct.io()
	at := time.Now().Add(9 * time.Hour)
	if err := cron.InstallLine(ct.io(), f.slug, cron.ScheduledLines(f.root, f.slug, at)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, build.State{
		Status:     statusScheduled,
		StartAt:    at.UTC().Format(time.RFC3339),
		GateCardID: gateCardID(f.slug, 1),
	})
	// The notebook the build's idea card lives in — the thing being deleted.
	writeFileT(t, filepath.Join(f.mcpDir, f.source, store.NotebookManifest), `{"slug":"greenhouse"}`)

	if rr := postActionT(t, f.root, token, f.cfg, map[string]any{"action": "delete-notebook", "subject": f.source}); rr.Code != http.StatusOK {
		t.Fatalf("delete code=%d body=%s", rr.Code, rr.Body.String())
	}

	if strings.Contains(ct.content, marker(f.slug)) {
		t.Fatalf("the deleted notebook's build kept its crontab line:\n%s", ct.content)
	}
	if !strings.Contains(ct.content, "# mine") {
		t.Fatalf("the user's own line was eaten:\n%s", ct.content)
	}
	st, _ := f.loadState(t)
	if st.Status != statusHalted || st.Note == "" {
		t.Fatalf("state = %+v, want halted with a note saying why", st)
	}
	// The build is stopped before the folder goes, so settling its cards can't
	// write a dead notebook's dir back onto disk.
	if _, err := os.Stat(filepath.Join(f.mcpDir, f.source)); !os.IsNotExist(err) {
		t.Fatalf("notebook folder should be gone, stat err=%v", err)
	}
}

// TestDeletingANotebookLeavesOtherBuildsAlone: the stop is keyed on the owning
// notebook, so a build sourced from a different one keeps running.
func TestDeletingANotebookLeavesOtherBuildsAlone(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	ct := &fakeCrontab{content: ""}
	f.cfg.Cron = ct.io()
	if err := cron.InstallLine(ct.io(), f.slug, cron.LineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, build.State{Status: statusBuilding, GateCardID: gateCardID(f.slug, 1)})

	const other = "reading-list"
	writeFileT(t, filepath.Join(f.mcpDir, other, store.NotebookManifest), `{"slug":"reading-list"}`)

	if rr := postActionT(t, f.root, token, f.cfg, map[string]any{"action": "delete-notebook", "subject": other}); rr.Code != http.StatusOK {
		t.Fatalf("delete code=%d body=%s", rr.Code, rr.Body.String())
	}

	if !strings.Contains(ct.content, marker(f.slug)) {
		t.Fatalf("another notebook's build lost its crontab line:\n%s", ct.content)
	}
	st, _ := f.loadState(t)
	if st.Status != statusBuilding {
		t.Fatalf("state = %+v, want it still building", st)
	}
}
