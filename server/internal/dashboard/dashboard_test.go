package dashboard

import (
	"encoding/json"
	"nestnote/server/internal/build"
	"nestnote/server/internal/store"
	"net/http"
	"net/http/httptest"
	"os"
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
	if err := store.SaveNotebook(mcpDir, store.Notebook{Slug: slug, Summary: "Server work."}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertPage(mcpDir, slug, "Open Bugs", []string{"fix the crash", "handle nil deref"}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertPage(mcpDir, slug, "Tweaks", []string{"tweak the colors"}); err != nil {
		t.Fatal(err)
	}
	// A Task Log page (page #3, after the two content pages) recording that "fix the
	// crash" is already Completed — written directly so we control its exact bytes.
	logBody = "# Task Log\n\n## Fix the crash\n- Completed after 2h 3m\n- id: `task-fix-the-crash`\n"
	writeFileT(t, filepath.Join(store.NotesDirFor(mcpDir, slug), "#3 (Task Log).md"), logBody)
	if err := store.RebuildAppendix(mcpDir, slug); err != nil {
		t.Fatal(err)
	}
	return mcpDir, logBody
}

// TestStateAndNotebookHTTP checks the wire shape: /state and /notebook carry `pages`
// (Appendix first), and a missing slug 404s.
func TestStateAndNotebookHTTP(t *testing.T) {
	root := t.TempDir()
	mcpDir := filepath.Join(root, "mcp")
	if err := store.SaveNotebook(mcpDir, store.Notebook{Slug: "greenhouse", Summary: "Plants."}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertPage(mcpDir, "greenhouse", "Watering", []string{"water daily"}); err != nil {
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
	rr := do(StateHandler(token, root), "/state")
	if rr.Code != http.StatusOK {
		t.Fatalf("/state code=%d body=%s", rr.Code, rr.Body.String())
	}
	var state struct {
		Servers []struct {
			Name  string           `json:"name"`
			Pages []store.NotePage `json:"pages"`
		} `json:"servers"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Servers) == 0 || len(state.Servers[0].Pages) < 2 {
		t.Fatalf("expected a server with an appendix + content page, got %+v", state.Servers)
	}
	if state.Servers[0].Pages[0].Num != store.AppendixNum {
		t.Fatalf("first page should be the appendix, got %+v", state.Servers[0].Pages[0])
	}

	// /notebook?slug=greenhouse — built explicitly since it needs the slug param.
	req := httptest.NewRequest(http.MethodGet, "/notebook?slug=greenhouse&token="+token, nil)
	rr = httptest.NewRecorder()
	NotebookHandler(token, root)(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("/notebook code=%d body=%s", rr.Code, rr.Body.String())
	}

	// Missing slug 404s.
	req = httptest.NewRequest(http.MethodGet, "/notebook?slug=nope&token="+token, nil)
	rr = httptest.NewRecorder()
	NotebookHandler(token, root)(rr, req)
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
	if err := store.SaveNotebook(mcpDir, store.Notebook{Slug: "greenhouse", Summary: "Plants."}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertPage(mcpDir, "greenhouse", "Watering", []string{"water daily"}); err != nil {
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
	rr := get(NotebookHandler(token, root), "/notebook?slug=greenhouse&meta=1")
	if rr.Code != http.StatusOK {
		t.Fatalf("/notebook?meta code=%d body=%s", rr.Code, rr.Body.String())
	}
	var meta struct {
		Pages []store.NotePage `json:"pages"`
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
	rr = get(PageHandler(token, root), "/page?slug=greenhouse&num=1")
	if rr.Code != http.StatusOK {
		t.Fatalf("/page code=%d body=%s", rr.Code, rr.Body.String())
	}
	var page store.NotePage
	if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Num != 1 || page.Title != "Watering" || !strings.Contains(page.Body, "water daily") {
		t.Fatalf("page #1 should carry its body, got %+v", page)
	}

	// A non-existent page number 404s; a non-numeric one is a 400.
	if rr := get(PageHandler(token, root), "/page?slug=greenhouse&num=99"); rr.Code != http.StatusNotFound {
		t.Fatalf("missing page should 404, got %d", rr.Code)
	}
	if rr := get(PageHandler(token, root), "/page?slug=greenhouse&num=x"); rr.Code != http.StatusBadRequest {
		t.Fatalf("non-numeric page should 400, got %d", rr.Code)
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

	writeProposal := func(subject, summary string, pages []store.ReorgPage) {
		t.Helper()
		data, err := json.MarshalIndent(store.ReorgProposal{Subject: subject, Summary: summary, Pages: pages}, "", "  ")
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
		ActionHandler(token, root, build.Config{})(rr, req)
		return rr
	}

	writeProposal("mcp", "Merge bug pages; drop done items",
		[]store.ReorgPage{{Title: "Bugs & Tweaks", Body: "# Bugs & Tweaks\n\n- handle nil deref\n"}})

	// /state exposes the proposal with a 2 → 1 page count.
	rr := httptest.NewRequest(http.MethodGet, "/state?token="+token, nil)
	rec := httptest.NewRecorder()
	StateHandler(token, root)(rec, rr)
	if rec.Code != http.StatusOK {
		t.Fatalf("/state code=%d body=%s", rec.Code, rec.Body.String())
	}
	var state struct {
		Reorgs []Reorg `json:"reorgs"`
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
	NotebookHandler(token, root)(nbRec, nbReq)
	var nb struct {
		Reorgs []Reorg `json:"reorgs"`
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
	pages := store.ListPages(mcpDir, "mcp")
	if len(pages) != 3 || pages[1].Title != "Bugs & Tweaks" {
		t.Fatalf("pages should be reorganized, got %+v", pages)
	}
	if _, isLog := store.TaskLogSeq(pages[2].Title); !isLog || pages[2].Body != logBody {
		t.Fatalf("Task Log must survive the applied reorg unchanged, got %+v", pages[2])
	}

	// reorg-dismiss discards a proposal without touching the pages.
	writeProposal("mcp", "second thought", []store.ReorgPage{{Title: "X", Body: "# X\n"}})
	before := store.ListPages(mcpDir, "mcp")
	if rr := postAction(map[string]any{"action": "reorg-dismiss", "subject": "mcp"}); rr.Code != http.StatusOK {
		t.Fatalf("reorg-dismiss code=%d body=%s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(stateDir, "reorgs", "mcp.json")); !os.IsNotExist(err) {
		t.Fatalf("dismissed proposal file should be removed, err=%v", err)
	}
	if after := store.ListPages(mcpDir, "mcp"); len(after) != len(before) {
		t.Fatalf("reorg-dismiss must not change pages: before %d, after %d", len(before), len(after))
	}
}
