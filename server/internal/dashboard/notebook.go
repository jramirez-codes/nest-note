package dashboard

import (
	"net/http"
	"sort"
	"strconv"

	"nestnote/server/internal/httpx"
	"nestnote/server/internal/store"
)

// notebookDetail is a single notebook's detail: its manifest identity, notes/
// pages, and its own cards. This is the lazy per-notebook fetch the phone uses
// when swapping notebooks, so the index (/state) can stay cheap.
type notebookDetail struct {
	Server
	Cards []store.Card `json:"cards"`
	// Reorgs holds this notebook's pending reorg proposal (0 or 1), so the notebook view
	// can show the same confirm card the Sandbox does.
	Reorgs []Reorg `json:"reorgs"`
}

// NotebookHandler answers GET /notebook?slug=<x>.
//
// With ?meta=1 it returns the same shape but strips every page body, so the phone gets a
// cheap page index (num/title/file only) to virtualize against — it then pulls individual
// bodies via /page as the reader moves. Without it, bodies are included (the eager form).
func NotebookHandler(token, root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !httpx.Guard(w, r, token) {
			return
		}
		if root == "" {
			http.Error(w, "mcp disabled", http.StatusNotFound)
			return
		}
		slug := r.URL.Query().Get("slug")
		if !store.ValidSlug(slug) {
			http.Error(w, "bad slug", http.StatusBadRequest)
			return
		}
		mcpDir, stateDir := store.RootDirs(root)
		if !store.IsNotebook(mcpDir, slug) {
			http.Error(w, "notebook not found", http.StatusNotFound)
			return
		}
		detail := notebookDetail{Server: readServer(mcpDir, slug), Cards: []store.Card{}, Reorgs: []Reorg{}}
		if p, ok := store.LoadReorg(stateDir, slug); ok {
			detail.Reorgs = append(detail.Reorgs, toReorg(mcpDir, p))
		}
		// The cheap index form: keep the page list (num/title/file) but drop the bodies,
		// which the phone fetches lazily per page via /page.
		if r.URL.Query().Get("meta") != "" {
			for i := range detail.Pages {
				detail.Pages[i].Body = ""
			}
		}
		for _, c := range store.LoadCards(mcpDir, slug) {
			if !c.Dismissed {
				detail.Cards = append(detail.Cards, c)
			}
		}
		sort.Slice(detail.Cards, func(i, j int) bool { return detail.Cards[i].ID < detail.Cards[j].ID })
		httpx.WriteJSON(w, detail)
	}
}

// PageHandler answers GET /page?slug=<x>&num=<n> with a single notebook page and its
// markdown body, reading only that one file. It's the per-page fetch behind the phone's
// virtualized reader: after loading a notebook's index (/notebook?meta=1), the phone pulls
// the current page and its neighbours through here so swiping stays instant.
func PageHandler(token, root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !httpx.Guard(w, r, token) {
			return
		}
		if root == "" {
			http.Error(w, "mcp disabled", http.StatusNotFound)
			return
		}
		slug := r.URL.Query().Get("slug")
		if !store.ValidSlug(slug) {
			http.Error(w, "bad slug", http.StatusBadRequest)
			return
		}
		num, err := strconv.Atoi(r.URL.Query().Get("num"))
		if err != nil {
			http.Error(w, "bad page number", http.StatusBadRequest)
			return
		}
		mcpDir, _ := store.RootDirs(root)
		if !store.IsNotebook(mcpDir, slug) {
			http.Error(w, "notebook not found", http.StatusNotFound)
			return
		}
		page, ok := store.ReadPage(mcpDir, slug, num)
		if !ok {
			http.Error(w, "page not found", http.StatusNotFound)
			return
		}
		httpx.WriteJSON(w, page)
	}
}
