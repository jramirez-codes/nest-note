package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
)

// The /search endpoint backs the editor's `/search <query>` autocomplete: it
// scans every notebook's notes/ pages for a case-insensitive substring match
// against the query, so the menu can offer live results as the user types.
// Read-only and cheap like the other dashboard endpoints — no Claude run.

// maxSearchResults caps how many matches a query returns, since the caller is
// an autocomplete menu, not a full search UI — the top handful is plenty.
const maxSearchResults = 20

// snippetRadius is how many characters of context to keep on each side of a
// body match when building its preview snippet.
const snippetRadius = 60

// searchResult is one page match: enough to render an autocomplete row (the
// owning notebook, the page, and a snippet of where the query hit) and enough
// to build a `[[slug::#N (Title)]]` link to it. rank is unexported so it never
// serializes — it only orders results before the response is capped.
type searchResult struct {
	Slug      string `json:"slug"`
	Title     string `json:"title"`
	PageNum   int    `json:"page_num"`
	PageTitle string `json:"page_title"`
	Snippet   string `json:"snippet"`
	rank      int
}

// searchHandler answers GET /search?q=<text> with the notebook pages whose
// title or body contains q (case-insensitive), most relevant first. An empty
// or missing q yields an empty result list rather than an error, so the
// editor can call it on every keystroke without special-casing the first one.
func searchHandler(token, root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r, token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if root == "" {
			http.Error(w, "mcp disabled", http.StatusNotFound)
			return
		}
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		mcpDir, _ := rootDirs(root)
		results := []searchResult{}
		if q != "" {
			results = searchNotebooks(mcpDir, q)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			Results []searchResult `json:"results"`
		}{results})
	}
}

// searchNotebooks scans every notebook's content pages (the Appendix is a
// generated index, not real content, so it's skipped) for q, ranks title hits
// above body-only hits, and returns at most maxSearchResults.
func searchNotebooks(mcpDir, q string) []searchResult {
	needle := strings.ToLower(q)
	slugs := listNotebookSlugs(mcpDir)
	sort.Strings(slugs)

	var results []searchResult
	for _, slug := range slugs {
		nb := loadNotebook(mcpDir, slug)
		for _, p := range listPages(mcpDir, slug) {
			if p.Num == appendixNum {
				continue
			}
			titleMatch := strings.Contains(strings.ToLower(p.Title), needle)
			idx := strings.Index(strings.ToLower(p.Body), needle)
			if !titleMatch && idx < 0 {
				continue
			}
			rank := 1
			if titleMatch {
				rank = 0
			}
			results = append(results, searchResult{
				Slug:      slug,
				Title:     nb.Title,
				PageNum:   p.Num,
				PageTitle: p.Title,
				Snippet:   snippetAround(p.Body, idx),
				rank:      rank,
			})
		}
	}

	sort.SliceStable(results, func(i, j int) bool {
		if results[i].rank != results[j].rank {
			return results[i].rank < results[j].rank
		}
		if results[i].Slug != results[j].Slug {
			return results[i].Slug < results[j].Slug
		}
		return results[i].PageNum < results[j].PageNum
	})
	if len(results) > maxSearchResults {
		results = results[:maxSearchResults]
	}
	return results
}

// snippetAround extracts a short preview centered on idx (a body match), or —
// when idx is -1 (a title-only match) — the page's opening text. Runs of
// whitespace (including newlines) collapse to single spaces so the preview
// reads as one line, with an ellipsis on whichever side was truncated.
func snippetAround(body string, idx int) string {
	if idx < 0 {
		snippet := strings.Join(strings.Fields(body), " ")
		if len(snippet) > snippetRadius*2 {
			snippet = strings.TrimSpace(snippet[:snippetRadius*2]) + "…"
		}
		return snippet
	}
	start, prefix := idx-snippetRadius, "…"
	if start <= 0 {
		start, prefix = 0, ""
	}
	end, suffix := idx+snippetRadius, "…"
	if end >= len(body) {
		end, suffix = len(body), ""
	}
	return prefix + strings.Join(strings.Fields(body[start:end]), " ") + suffix
}
