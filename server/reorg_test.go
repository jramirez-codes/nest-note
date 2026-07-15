package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// setupReorgNotebook lays down a two-content-page notebook plus a Task Log page holding
// one completed entry, and returns the mcpDir and the Task Log page's exact on-disk body
// so a test can assert it survives a reorg byte-for-byte.
func setupReorgNotebook(t *testing.T, slug string) (mcpDir, logBody string) {
	t.Helper()
	mcpDir = filepath.Join(t.TempDir(), "mcp")
	if err := saveNotebook(mcpDir, notebook{Slug: slug, Summary: "Server work."}); err != nil {
		t.Fatal(err)
	}
	if err := upsertPage(mcpDir, slug, "Open Bugs", []string{"fix the crash", "handle nil deref"}); err != nil {
		t.Fatal(err)
	}
	if err := upsertPage(mcpDir, slug, "Tweaks", []string{"tweak the colors"}); err != nil {
		t.Fatal(err)
	}
	// A Task Log page (page #3, after the two content pages) recording that "fix the
	// crash" is already Completed — written directly so we control its exact bytes.
	logBody = "# Task Log\n\n## Fix the crash\n- Completed after 2h 3m\n- id: `task-fix-the-crash`\n"
	writeFileT(t, filepath.Join(notesDirFor(mcpDir, slug), "#3 (Task Log).md"), logBody)
	if err := rebuildAppendix(mcpDir, slug); err != nil {
		t.Fatal(err)
	}
	return mcpDir, logBody
}

// TestApplyReorgPreservesTaskLog is the load-bearing guarantee: applyReorg replaces a
// notebook's content pages with the proposed set, drops a Task-Log-titled proposal, and
// leaves the real Task Log page untouched (same bytes) as the notebook's last page.
func TestApplyReorgPreservesTaskLog(t *testing.T) {
	mcpDir, logBody := setupReorgNotebook(t, "mcp")

	// Reorg down to one page — "fix the crash" pruned (the log shows it's done) — plus a
	// bogus "Task Log" page the server must ignore.
	pages := []reorgPage{
		{Title: "Bugs & Tweaks", Body: "# Bugs & Tweaks\n\n- handle nil deref\n- tweak the colors\n"},
		{Title: "Task Log", Body: "# Task Log\n\n- I should never be written\n"},
	}
	if err := applyReorg(mcpDir, "mcp", pages); err != nil {
		t.Fatalf("applyReorg: %v", err)
	}

	got := listPages(mcpDir, "mcp")
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
	if _, isLog := taskLogSeq(log.Title); !isLog || log.Num != 2 {
		t.Fatalf("Task Log should be the notebook's last page, got %+v", log)
	}
	if log.Body != logBody {
		t.Fatalf("Task Log body must be byte-for-byte unchanged.\nwant:\n%q\ngot:\n%q", logBody, log.Body)
	}
	if strings.Contains(log.Body, "never be written") {
		t.Fatalf("a Task-Log-titled proposal must never overwrite the real log")
	}
}

// TestReorgActionHTTP covers the wire path: /state and /notebook surface a pending
// proposal (with a N→M page count), POST /action reorg applies it (Task Log preserved)
// and clears the file, and reorg-dismiss discards a proposal without changing pages.
func TestReorgActionHTTP(t *testing.T) {
	mcpDir, logBody := setupReorgNotebook(t, "mcp")
	root := filepath.Dir(mcpDir) // rootDirs(root) == (root/mcp, root/orchestrator/state)
	stateDir := filepath.Join(root, "orchestrator", "state")
	const token = "secret"

	writeProposal := func(subject, summary string, pages []reorgPage) {
		t.Helper()
		data, err := json.MarshalIndent(reorgProposal{Subject: subject, Summary: summary, Pages: pages}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		writeFileT(t, filepath.Join(stateDir, "reorgs", subject+".json"), string(data)+"\n")
	}
	postAction := func(body map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/action?token="+token, strings.NewReader(string(b)))
		rr := httptest.NewRecorder()
		actionHandler(token, root)(rr, req)
		return rr
	}

	writeProposal("mcp", "Merge bug pages; drop done items",
		[]reorgPage{{Title: "Bugs & Tweaks", Body: "# Bugs & Tweaks\n\n- handle nil deref\n"}})

	// /state exposes the proposal with a 2 → 1 page count.
	rr := httptest.NewRequest(http.MethodGet, "/state?token="+token, nil)
	rec := httptest.NewRecorder()
	stateHandler(token, root)(rec, rr)
	if rec.Code != http.StatusOK {
		t.Fatalf("/state code=%d body=%s", rec.Code, rec.Body.String())
	}
	var state struct {
		Reorgs []dashReorg `json:"reorgs"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Reorgs) != 1 || state.Reorgs[0].Subject != "mcp" ||
		state.Reorgs[0].FromPages != 2 || state.Reorgs[0].ToPages != 1 {
		t.Fatalf("/state should carry the mcp reorg (2→1 pages), got %+v", state.Reorgs)
	}

	// /notebook?slug=mcp carries the same proposal for the in-notebook card.
	nbReq := httptest.NewRequest(http.MethodGet, "/notebook?slug=mcp&token="+token, nil)
	nbRec := httptest.NewRecorder()
	notebookHandler(token, root)(nbRec, nbReq)
	var nb struct {
		Reorgs []dashReorg `json:"reorgs"`
	}
	if err := json.Unmarshal(nbRec.Body.Bytes(), &nb); err != nil {
		t.Fatal(err)
	}
	if len(nb.Reorgs) != 1 || nb.Reorgs[0].Subject != "mcp" {
		t.Fatalf("/notebook should carry the notebook's own reorg, got %+v", nb.Reorgs)
	}

	// Apply it: 200, proposal file gone, pages reorganized, Task Log preserved.
	if rr := postAction(map[string]any{"action": "reorg", "subject": "mcp"}); rr.Code != http.StatusOK {
		t.Fatalf("reorg action code=%d body=%s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(stateDir, "reorgs", "mcp.json")); !os.IsNotExist(err) {
		t.Fatalf("applied proposal file should be removed, err=%v", err)
	}
	pages := listPages(mcpDir, "mcp")
	if len(pages) != 3 || pages[1].Title != "Bugs & Tweaks" {
		t.Fatalf("pages should be reorganized, got %+v", pages)
	}
	if _, isLog := taskLogSeq(pages[2].Title); !isLog || pages[2].Body != logBody {
		t.Fatalf("Task Log must survive the applied reorg unchanged, got %+v", pages[2])
	}

	// reorg-dismiss discards a proposal without touching the pages.
	writeProposal("mcp", "second thought", []reorgPage{{Title: "X", Body: "# X\n"}})
	before := listPages(mcpDir, "mcp")
	if rr := postAction(map[string]any{"action": "reorg-dismiss", "subject": "mcp"}); rr.Code != http.StatusOK {
		t.Fatalf("reorg-dismiss code=%d body=%s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(stateDir, "reorgs", "mcp.json")); !os.IsNotExist(err) {
		t.Fatalf("dismissed proposal file should be removed, err=%v", err)
	}
	if after := listPages(mcpDir, "mcp"); len(after) != len(before) {
		t.Fatalf("reorg-dismiss must not change pages: before %d, after %d", len(before), len(after))
	}
}

// reorgCall builds a tools/call frame for the orchestrator's propose_reorg tool.
func reorgCall(t *testing.T, id int, subject, summary string, pages []map[string]any) string {
	t.Helper()
	items := make([]any, len(pages))
	for i, p := range pages {
		items[i] = p
	}
	return rpcLine(t, id, "tools/call", map[string]any{
		"name": "propose_reorg",
		"arguments": map[string]any{
			"subject": subject,
			"summary": summary,
			"pages":   items,
		},
	})
}

// TestProposeReorgStripsTaskLog drives the generated orchestrator binary: propose_reorg
// writes state/reorgs/<subject>.json and drops any Task-Log-titled page from the proposal.
func TestProposeReorgStripsTaskLog(t *testing.T) {
	if testing.Short() {
		t.Skip("scaffold runs go build; skipped in -short")
	}
	root := t.TempDir()
	mcpDir := filepath.Join(root, "mcp")
	stateDir := filepath.Join(root, "orchestrator", "state")
	if _, err := scaffoldRoot(root, 4); err != nil {
		t.Fatalf("scaffoldRoot failed: %v", err)
	}
	orchBin := filepath.Join(root, "orchestrator", "bin", "orchestrator")

	handshake := rpcLine(t, 1, "initialize", map[string]any{"protocolVersion": "2025-06-18"}) +
		rpcLine(t, 0, "notifications/initialized", nil)
	in := handshake + reorgCall(t, 2, "mcp", "tidy up", []map[string]any{
		{"title": "Open Bugs", "body": "# Open Bugs\n\n- one\n"},
		{"title": "Task Log", "body": "# Task Log\n\n- should be stripped\n"},
		{"title": "Notes", "body": "# Notes\n\n- two\n"},
	})
	cmd := exec.Command(orchBin, "-mcp-dir", mcpDir, "-state-dir", stateDir, "-threshold", "4")
	cmd.Stdin = strings.NewReader(in)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("orchestrator run failed: %v\n%s", err, out)
	}

	data, err := os.ReadFile(filepath.Join(stateDir, "reorgs", "mcp.json"))
	if err != nil {
		t.Fatalf("proposal file should exist: %v", err)
	}
	var p reorgProposal
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatal(err)
	}
	if len(p.Pages) != 2 {
		t.Fatalf("the Task Log page should be stripped, leaving 2 pages, got %d: %+v", len(p.Pages), p.Pages)
	}
	for _, pg := range p.Pages {
		if _, isLog := taskLogSeq(sanitizePageTitle(pg.Title)); isLog {
			t.Fatalf("proposal must not contain a Task Log page, got %+v", pg)
		}
	}
}

// TestFactStoreRewriteRefusesTaskLog drives a generated subject server: its <name>_rewrite
// tool refuses to overwrite a Task Log page, leaving it intact.
func TestFactStoreRewriteRefusesTaskLog(t *testing.T) {
	if testing.Short() {
		t.Skip("scaffold runs go build; skipped in -short")
	}
	root := t.TempDir()
	mcpDir := filepath.Join(root, "mcp")
	// A note-bearing subject so scaffold builds its query binary, with a Task Log page.
	logBody := "# Task Log\n\n## Old task\n- Completed after 1h\n"
	writeFileT(t, filepath.Join(mcpDir, "labs", "notes", "#1 (Notes).md"), "# Notes\n\n- a fact\n")
	logPath := filepath.Join(mcpDir, "labs", "notes", "#2 (Task Log).md")
	writeFileT(t, logPath, logBody)
	if _, err := scaffoldRoot(root, 4); err != nil {
		t.Fatalf("scaffoldRoot failed: %v", err)
	}
	labsBin := filepath.Join(mcpDir, "bin", "labs")

	handshake := rpcLine(t, 1, "initialize", map[string]any{"protocolVersion": "2025-06-18"}) +
		rpcLine(t, 0, "notifications/initialized", nil)
	// Target the Task Log by title, then by its number — both must be refused.
	in := handshake +
		rpcLine(t, 2, "tools/call", map[string]any{
			"name":      "labs_rewrite",
			"arguments": map[string]any{"page": "Task Log", "content": "# hacked\n"},
		}) +
		rpcLine(t, 3, "tools/call", map[string]any{
			"name":      "labs_rewrite",
			"arguments": map[string]any{"page": "2", "content": "# hacked\n"},
		})
	cmd := exec.Command(labsBin)
	cmd.Stdin = strings.NewReader(in)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("labs server run failed: %v\n%s", err, out)
	}
	for _, id := range []int{2, 3} {
		if msg := textOf(t, out, id); !strings.Contains(msg, "protected task log") {
			t.Fatalf("rewrite (id %d) should refuse a Task Log page, got: %q", id, msg)
		}
	}
	if b, err := os.ReadFile(logPath); err != nil || string(b) != logBody {
		t.Fatalf("Task Log must be unchanged after a refused rewrite, err=%v body=%q", err, b)
	}
}
