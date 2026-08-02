package search

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"nestnote/server/internal/store"
)

// TestSearchHandler covers the /search contract: a query matches across notebooks by
// title or body (case-insensitively), the Appendix is never a hit, an empty query
// yields an empty list rather than an error, and a disabled scaffold (-root unset) 404s.
func TestSearchHandler(t *testing.T) {
	root := t.TempDir()
	mcpDir := filepath.Join(root, "mcp")
	if err := store.SaveNotebook(mcpDir, store.Notebook{Slug: "greenhouse", Title: "Greenhouse", Summary: "Plants."}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertPage(mcpDir, "greenhouse", "Watering Schedule", []string{"water the tomatoes daily"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveNotebook(mcpDir, store.Notebook{Slug: "taxes", Title: "Taxes", Summary: "Filing."}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertPage(mcpDir, "taxes", "Deadlines", []string{"file by April"}); err != nil {
		t.Fatal(err)
	}

	const token = "secret"
	get := func(url string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, url+"&token="+token, nil)
		rr := httptest.NewRecorder()
		Handler(token, root)(rr, req)
		return rr
	}

	rr := get("/search?q=tomatoes")
	if rr.Code != http.StatusOK {
		t.Fatalf("/search code=%d body=%s", rr.Code, rr.Body.String())
	}
	var body struct {
		Results []searchResult `json:"results"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Results) != 1 {
		t.Fatalf("want 1 result for 'tomatoes', got %+v", body.Results)
	}
	got := body.Results[0]
	if got.Slug != "greenhouse" || got.PageTitle != "Watering Schedule" || got.PageNum != 1 {
		t.Fatalf("unexpected match: %+v", got)
	}
	if got.Title != "Greenhouse" {
		t.Fatalf("want notebook title 'Greenhouse', got %q", got.Title)
	}

	// Case-insensitive, and matches a page title too.
	rr = get("/search?q=DEADLINES")
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Results) != 1 || body.Results[0].Slug != "taxes" {
		t.Fatalf("want the taxes notebook for 'DEADLINES', got %+v", body.Results)
	}

	// The Appendix (an auto-generated index page) is never a hit, even though it
	// links every page and would otherwise match almost anything.
	rr = get("/search?q=Appendix")
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Results) != 0 {
		t.Fatalf("Appendix pages should never match, got %+v", body.Results)
	}

	// Empty query: no error, just no results.
	rr = get("/search?q=")
	if rr.Code != http.StatusOK {
		t.Fatalf("/search?q= code=%d body=%s", rr.Code, rr.Body.String())
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Results) != 0 {
		t.Fatalf("empty query should yield no results, got %+v", body.Results)
	}

	// No match anywhere.
	rr = get("/search?q=nonexistentxyz")
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Results) != 0 {
		t.Fatalf("want no results, got %+v", body.Results)
	}

	// Disabled scaffold (-root unset) 404s, matching the other dashboard endpoints.
	req := httptest.NewRequest(http.MethodGet, "/search?q=tomatoes&token="+token, nil)
	rr2 := httptest.NewRecorder()
	Handler(token, "")(rr2, req)
	if rr2.Code != http.StatusNotFound {
		t.Fatalf("disabled search should 404, got %d", rr2.Code)
	}
}
