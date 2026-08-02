package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFileT creates parent dirs and writes a file.
func writeFileT(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// setupReorgNotebook lays down a two-content-page notebook plus a Task Log page holding
// one completed entry, and returns the mcpDir and the Task Log page's exact on-disk body
// so a test can assert it survives a reorg byte-for-byte.
func setupReorgNotebook(t *testing.T, slug string) (mcpDir, logBody string) {
	t.Helper()
	mcpDir = filepath.Join(t.TempDir(), "mcp")
	if err := SaveNotebook(mcpDir, Notebook{Slug: slug, Summary: "Server work."}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertPage(mcpDir, slug, "Open Bugs", []string{"fix the crash", "handle nil deref"}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertPage(mcpDir, slug, "Tweaks", []string{"tweak the colors"}); err != nil {
		t.Fatal(err)
	}
	// A Task Log page (page #3, after the two content pages) recording that "fix the
	// crash" is already Completed — written directly so we control its exact bytes.
	logBody = "# Task Log\n\n## Fix the crash\n- Completed after 2h 3m\n- id: `task-fix-the-crash`\n"
	writeFileT(t, filepath.Join(NotesDirFor(mcpDir, slug), "#3 (Task Log).md"), logBody)
	if err := RebuildAppendix(mcpDir, slug); err != nil {
		t.Fatal(err)
	}
	return mcpDir, logBody
}

// TestUpsertPageAndAppendix covers the canonical page helpers: a new title creates the
// next-numbered page, the same title appends, and the Appendix indexes both.
func TestUpsertPageAndAppendix(t *testing.T) {
	mcpDir := filepath.Join(t.TempDir(), "mcp")
	if err := SaveNotebook(mcpDir, Notebook{Slug: "greenhouse", Summary: "Plants and soil."}); err != nil {
		t.Fatal(err)
	}

	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(UpsertPage(mcpDir, "greenhouse", "Watering Schedule", []string{"water daily"}))
	must(UpsertPage(mcpDir, "greenhouse", "Pest Notes", []string{"aphids on the tomatoes"}))
	must(UpsertPage(mcpDir, "greenhouse", "watering schedule", []string{"less in winter"})) // case-insensitive append

	pages := ListPages(mcpDir, "greenhouse")
	if len(pages) != 3 { // appendix + 2 content pages (not 3 — the third call appended)
		t.Fatalf("want 3 pages (appendix + 2 content), got %d: %+v", len(pages), pages)
	}
	if pages[0].Num != AppendixNum || pages[0].Title != AppendixTitle {
		t.Fatalf("page[0] should be the Appendix, got %+v", pages[0])
	}
	if pages[1].Num != 1 || pages[1].Title != "Watering Schedule" {
		t.Fatalf("page[1] should be #1 (Watering Schedule), got %+v", pages[1])
	}
	if !strings.Contains(pages[1].Body, "water daily") || !strings.Contains(pages[1].Body, "less in winter") {
		t.Fatalf("watering page should carry both bullets, got:\n%s", pages[1].Body)
	}
	app := pages[0].Body
	if !strings.Contains(app, "[[#1 (Watering Schedule)]]") || !strings.Contains(app, "[[#2 (Pest Notes)]]") {
		t.Fatalf("appendix should link both pages, got:\n%s", app)
	}
	if !strings.Contains(app, "Plants and soil.") {
		t.Fatalf("appendix should carry the notebook summary, got:\n%s", app)
	}
}

// TestApplyReorgPreservesTaskLog is the load-bearing guarantee: applyReorg replaces a
// notebook's content pages with the proposed set, drops a Task-Log-titled proposal, and
// leaves the real Task Log page untouched (same bytes) as the notebook's last page.
func TestApplyReorgPreservesTaskLog(t *testing.T) {
	mcpDir, logBody := setupReorgNotebook(t, "mcp")

	// Reorg down to one page — "fix the crash" pruned (the log shows it's done) — plus a
	// bogus "Task Log" page the server must ignore.
	pages := []ReorgPage{
		{Title: "Bugs & Tweaks", Body: "# Bugs & Tweaks\n\n- handle nil deref\n- tweak the colors\n"},
		{Title: "Task Log", Body: "# Task Log\n\n- I should never be written\n"},
	}
	if err := ApplyReorg(mcpDir, "mcp", pages); err != nil {
		t.Fatalf("applyReorg: %v", err)
	}

	got := ListPages(mcpDir, "mcp")
	// appendix #0, one content page #1, Task Log pushed to #2.
	if len(got) != 3 {
		t.Fatalf("want appendix + 1 content + 1 task log = 3 pages, got %d: %+v", len(got), got)
	}
	if got[1].Num != 1 || got[1].Title != "Bugs & Tweaks" {
		t.Fatalf("page #1 should be the reorganized content page, got %+v", got[1])
	}
	if strings.Contains(got[1].Body, "fix the crash") {
		t.Fatalf("the completed item should have been pruned, got:\n%s", got[1].Body)
	}
	if !strings.Contains(got[1].Body, "handle nil deref") {
		t.Fatalf("the still-open item should survive, got:\n%s", got[1].Body)
	}
	// The old content pages are gone.
	for _, p := range got {
		if p.Title == "Open Bugs" || p.Title == "Tweaks" {
			t.Fatalf("old content page %q should have been replaced", p.Title)
		}
	}
	// The real Task Log is preserved verbatim and last.
	log := got[2]
	if _, isLog := TaskLogSeq(log.Title); !isLog || log.Num != 2 {
		t.Fatalf("Task Log should be the notebook's last page, got %+v", log)
	}
	if log.Body != logBody {
		t.Fatalf("Task Log body must be byte-for-byte unchanged.\nwant:\n%q\ngot:\n%q", logBody, log.Body)
	}
	if strings.Contains(log.Body, "never be written") {
		t.Fatalf("a Task-Log-titled proposal must never overwrite the real log")
	}
}
