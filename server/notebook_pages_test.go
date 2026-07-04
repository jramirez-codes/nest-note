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

// writeFileT is a tiny test helper that creates parent dirs and writes a file.
func writeFileT(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestUpsertPageAndAppendix covers the canonical page helpers: a new title creates the
// next-numbered page, the same title appends, and the Appendix indexes both.
func TestUpsertPageAndAppendix(t *testing.T) {
	mcpDir := filepath.Join(t.TempDir(), "mcp")
	if err := saveNotebook(mcpDir, notebook{Slug: "greenhouse", Summary: "Plants and soil."}); err != nil {
		t.Fatal(err)
	}

	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(upsertPage(mcpDir, "greenhouse", "Watering Schedule", []string{"water daily"}))
	must(upsertPage(mcpDir, "greenhouse", "Pest Notes", []string{"aphids on the tomatoes"}))
	must(upsertPage(mcpDir, "greenhouse", "watering schedule", []string{"less in winter"})) // case-insensitive append

	pages := listPages(mcpDir, "greenhouse")
	if len(pages) != 3 { // appendix + 2 content pages (not 3 — the third call appended)
		t.Fatalf("want 3 pages (appendix + 2 content), got %d: %+v", len(pages), pages)
	}
	if pages[0].Num != appendixNum || pages[0].Title != appendixTitle {
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

// TestScaffoldMigratesAndBuilds is the load-bearing check: it runs a full scaffold
// against an old single-file root, which regenerates AND go-builds all three templates
// (orchestrator + two fact-store subjects), so a template that doesn't compile fails
// here. It then asserts the migration and the reserved orchestrator notebook.
func TestScaffoldMigratesAndBuilds(t *testing.T) {
	if testing.Short() {
		t.Skip("scaffold runs go build; skipped in -short")
	}
	root := t.TempDir()
	mcpDir := filepath.Join(root, "mcp")

	// Old layout: a single-file subject and a global card owned by it.
	writeFileT(t, filepath.Join(mcpDir, "greenhouse", "greenhouse.md"), "# Greenhouse\n\n- water daily\n")
	writeFileT(t, filepath.Join(root, "orchestrator", "state", "cards", "task-foo.json"),
		`{"id":"task-foo","kind":"task","title":"Prune","source":"greenhouse","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}`+"\n")

	if _, err := scaffoldRoot(root, 4); err != nil {
		t.Fatalf("scaffoldRoot failed (a template may not compile): %v", err)
	}

	// Migration: single file -> notes/#1 (Notes).md, appendix generated, old file gone.
	notesDir := filepath.Join(mcpDir, "greenhouse", "notes")
	page1 := filepath.Join(notesDir, "#1 (Notes).md")
	if b, err := os.ReadFile(page1); err != nil || !strings.Contains(string(b), "water daily") {
		t.Fatalf("expected migrated page #1 with content, err=%v", err)
	}
	if b, err := os.ReadFile(filepath.Join(notesDir, "#0 (Appendix).md")); err != nil || !strings.Contains(string(b), "[[#1 (Notes)]]") {
		t.Fatalf("expected appendix linking #1, err=%v body=%s", err, b)
	}
	if _, err := os.Stat(filepath.Join(mcpDir, "greenhouse", "greenhouse.md")); !os.IsNotExist(err) {
		t.Fatalf("legacy greenhouse.md should be gone, err=%v", err)
	}

	// Card drained into the owning notebook.
	if _, err := os.Stat(filepath.Join(mcpDir, "greenhouse", "cards", "task-foo.json")); err != nil {
		t.Fatalf("card should have moved under its notebook: %v", err)
	}

	// Orchestrator notebook: viewable + data-only (no generated query binary).
	if _, err := os.Stat(filepath.Join(mcpDir, "orchestrator", "notebook.json")); err != nil {
		t.Fatalf("orchestrator notebook manifest missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(mcpDir, "orchestrator", "notes", "#0 (Appendix).md")); err != nil {
		t.Fatalf("orchestrator appendix missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(mcpDir, "bin", "orchestrator")); !os.IsNotExist(err) {
		t.Fatalf("orchestrator notebook must NOT get a fact-store binary, err=%v", err)
	}
	// The subject DID get a query binary (proves the fact-store template compiled).
	if _, err := os.Stat(filepath.Join(mcpDir, "bin", "greenhouse")); err != nil {
		t.Fatalf("greenhouse fact-store binary should exist: %v", err)
	}
}

// rpcLine marshals one newline-delimited JSON-RPC frame for the stdio MCP protocol.
func rpcLine(t *testing.T, id int, method string, params any) string {
	t.Helper()
	req := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		req["params"] = params
	}
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	return string(b) + "\n"
}

// ingestCall builds a tools/call frame for ingest_topic.
func ingestCall(t *testing.T, id int, subject, pageTitle string, notes []string) string {
	return rpcLine(t, id, "tools/call", map[string]any{
		"name": "ingest_topic",
		"arguments": map[string]any{
			"subject": subject,
			"page":    pageTitle,
			"notes":   notes,
		},
	})
}

// TestOrchestratorIngestPages drives the *generated* orchestrator binary over stdio and
// checks the headline flow: each ingest_topic call writes to its titled page, a repeated
// title appends rather than forking a page, and filing is logged on the orchestrator
// notebook. This validates the template's real wiring, not just that it compiles.
func TestOrchestratorIngestPages(t *testing.T) {
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

	cmd := exec.Command(orchBin, "-mcp-dir", mcpDir, "-state-dir", stateDir, "-threshold", "4")
	var in strings.Builder
	in.WriteString(rpcLine(t, 1, "initialize", map[string]any{"protocolVersion": "2025-06-18"}))
	in.WriteString(rpcLine(t, 0, "notifications/initialized", nil))
	in.WriteString(ingestCall(t, 2, "greenhouse", "Watering Schedule", []string{"water daily"}))
	in.WriteString(ingestCall(t, 3, "greenhouse", "Pest Notes", []string{"aphids on the tomatoes"}))
	in.WriteString(ingestCall(t, 4, "greenhouse", "watering schedule", []string{"less in winter"}))
	cmd.Stdin = strings.NewReader(in.String())
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("orchestrator run failed: %v\n%s", err, out)
	}

	pages := listPages(mcpDir, "greenhouse")
	// appendix + 2 content pages (the third call appended to page #1, not a new page).
	if len(pages) != 3 {
		t.Fatalf("want appendix + 2 content pages, got %d: %+v", len(pages), pages)
	}
	if pages[1].Title != "Watering Schedule" ||
		!strings.Contains(pages[1].Body, "water daily") ||
		!strings.Contains(pages[1].Body, "less in winter") {
		t.Fatalf("watering page should hold both bullets, got %+v", pages[1])
	}
	if !strings.Contains(pages[0].Body, "[[#2 (Pest Notes)]]") {
		t.Fatalf("appendix should index the pest page, got:\n%s", pages[0].Body)
	}
	// Filing was logged on the data-only orchestrator notebook.
	act := listPages(mcpDir, "orchestrator")
	found := false
	for _, p := range act {
		if strings.Contains(p.Body, "greenhouse") {
			found = true
		}
	}
	if !found {
		t.Fatalf("orchestrator notebook should log the filing, got %+v", act)
	}
}

// TestStateAndNotebookHTTP checks the wire shape: /state and /notebook carry `pages`
// (Appendix first), and a missing slug 404s.
func TestStateAndNotebookHTTP(t *testing.T) {
	root := t.TempDir()
	mcpDir := filepath.Join(root, "mcp")
	if err := saveNotebook(mcpDir, notebook{Slug: "greenhouse", Summary: "Plants."}); err != nil {
		t.Fatal(err)
	}
	if err := upsertPage(mcpDir, "greenhouse", "Watering", []string{"water daily"}); err != nil {
		t.Fatal(err)
	}

	const token = "secret"

	do := func(h http.HandlerFunc, url string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, url+"?token="+token, nil)
		rr := httptest.NewRecorder()
		h(rr, req)
		return rr
	}

	// /state
	rr := do(stateHandler(token, root), "/state")
	if rr.Code != http.StatusOK {
		t.Fatalf("/state code=%d body=%s", rr.Code, rr.Body.String())
	}
	var state struct {
		Servers []struct {
			Name  string     `json:"name"`
			Pages []notePage `json:"pages"`
		} `json:"servers"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Servers) == 0 || len(state.Servers[0].Pages) < 2 {
		t.Fatalf("expected a server with an appendix + content page, got %+v", state.Servers)
	}
	if state.Servers[0].Pages[0].Num != appendixNum {
		t.Fatalf("first page should be the appendix, got %+v", state.Servers[0].Pages[0])
	}

	// /notebook?slug=greenhouse — built explicitly since it needs the slug param.
	req := httptest.NewRequest(http.MethodGet, "/notebook?slug=greenhouse&token="+token, nil)
	rr = httptest.NewRecorder()
	notebookHandler(token, root)(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("/notebook code=%d body=%s", rr.Code, rr.Body.String())
	}

	// Missing slug 404s.
	req = httptest.NewRequest(http.MethodGet, "/notebook?slug=nope&token="+token, nil)
	rr = httptest.NewRecorder()
	notebookHandler(token, root)(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("missing notebook should 404, got %d", rr.Code)
	}
}

// TestNotebookMetaAndPageHTTP covers the virtualization contract: /notebook?meta=1 returns
// the page index with bodies stripped, and /page?slug&num returns a single page with its
// body. A bad or missing page number is rejected.
func TestNotebookMetaAndPageHTTP(t *testing.T) {
	root := t.TempDir()
	mcpDir := filepath.Join(root, "mcp")
	if err := saveNotebook(mcpDir, notebook{Slug: "greenhouse", Summary: "Plants."}); err != nil {
		t.Fatal(err)
	}
	if err := upsertPage(mcpDir, "greenhouse", "Watering", []string{"water daily"}); err != nil {
		t.Fatal(err)
	}

	const token = "secret"
	get := func(h http.HandlerFunc, url string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, url+"&token="+token, nil)
		rr := httptest.NewRecorder()
		h(rr, req)
		return rr
	}

	// ?meta=1: the page index carries titles but no bodies.
	rr := get(notebookHandler(token, root), "/notebook?slug=greenhouse&meta=1")
	if rr.Code != http.StatusOK {
		t.Fatalf("/notebook?meta code=%d body=%s", rr.Code, rr.Body.String())
	}
	var meta struct {
		Pages []notePage `json:"pages"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &meta); err != nil {
		t.Fatal(err)
	}
	if len(meta.Pages) < 2 {
		t.Fatalf("expected appendix + content page in the index, got %+v", meta.Pages)
	}
	for _, p := range meta.Pages {
		if p.Body != "" {
			t.Fatalf("meta index should strip bodies, got body for page %d: %q", p.Num, p.Body)
		}
		if p.Title == "" {
			t.Fatalf("meta index should keep titles, got %+v", p)
		}
	}

	// /page?slug&num=1: the content page with its body.
	rr = get(pageHandler(token, root), "/page?slug=greenhouse&num=1")
	if rr.Code != http.StatusOK {
		t.Fatalf("/page code=%d body=%s", rr.Code, rr.Body.String())
	}
	var page notePage
	if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Num != 1 || page.Title != "Watering" || !strings.Contains(page.Body, "water daily") {
		t.Fatalf("page #1 should carry its body, got %+v", page)
	}

	// A non-existent page number 404s; a non-numeric one is a 400.
	if rr := get(pageHandler(token, root), "/page?slug=greenhouse&num=99"); rr.Code != http.StatusNotFound {
		t.Fatalf("missing page should 404, got %d", rr.Code)
	}
	if rr := get(pageHandler(token, root), "/page?slug=greenhouse&num=x"); rr.Code != http.StatusBadRequest {
		t.Fatalf("non-numeric page should 400, got %d", rr.Code)
	}
}
