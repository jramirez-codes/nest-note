package scaffold

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"nestnote/server/internal/store"
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

	if _, err := Root(root, 4); err != nil {
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

	if _, err := Root(root, 4); err != nil {
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

	pages := store.ListPages(mcpDir, "greenhouse")
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
	act := store.ListPages(mcpDir, "orchestrator")
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
	if _, err := Root(root, 4); err != nil {
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
	var p store.ReorgProposal
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatal(err)
	}
	if len(p.Pages) != 2 {
		t.Fatalf("the Task Log page should be stripped, leaving 2 pages, got %d: %+v", len(p.Pages), p.Pages)
	}
	for _, pg := range p.Pages {
		if _, isLog := store.TaskLogSeq(store.SanitizePageTitle(pg.Title)); isLog {
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
	if _, err := Root(root, 4); err != nil {
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
