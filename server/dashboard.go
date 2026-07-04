package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The dashboard endpoints let the phone read and lightly steer the MCP world
// without spinning up Claude. They only ever touch the scaffold's own data files
// (capability.json, the per-subject markdown, and the orchestrator's suggestion/
// consolidation queues), so they are cheap and can't run arbitrary code. Both are
// bearer-token authed over the same pinned TLS the rest of the server uses.

// dashServer is one notebook as the dashboard sees it: its identity (from the
// notebook.json manifest) plus its ordered notes pages (read straight off disk, so
// freshly ingested notes show even before the queryable MCP binary is scaffolded).
// Name stays the slug so the phone can key cards to it by `source`; Title/Icon/Accent/
// Pinned/UpdatedAt come from the manifest for a richer view. Pages[0] is the Appendix.
type dashServer struct {
	Name      string     `json:"name"`
	Title     string     `json:"title"`
	Summary   string     `json:"summary"`
	Icon      string     `json:"icon,omitempty"`
	Accent    string     `json:"accent,omitempty"`
	Pinned    bool       `json:"pinned"`
	UpdatedAt string     `json:"updated_at,omitempty"`
	Tools     []string   `json:"tools"`
	Pages     []notePage `json:"pages"`
}

// readDashServer assembles the dashboard view of one notebook from its manifest,
// notes/ pages, and capability.json (for the queryable tool list, if built yet).
func readDashServer(mcpDir, slug string) dashServer {
	nb := loadNotebook(mcpDir, slug)
	var tools []string
	if capData, err := os.ReadFile(filepath.Join(mcpDir, slug, "capability.json")); err == nil {
		var c struct {
			Tools []string `json:"tools"`
		}
		json.Unmarshal(capData, &c)
		tools = c.Tools
	}
	pages := listPages(mcpDir, slug)
	if pages == nil {
		pages = []notePage{}
	}
	return dashServer{
		Name:      nb.Slug,
		Title:     nb.Title,
		Summary:   nb.Summary,
		Icon:      nb.Icon,
		Accent:    nb.Accent,
		Pinned:    nb.Pinned,
		UpdatedAt: nb.UpdatedAt,
		Tools:     tools,
		Pages:     pages,
	}
}

// dashSuggestion is an optional, non-blocking merge proposal the orchestrator
// dropped during an ingest. The user approves or dismisses it in the dashboard.
type dashSuggestion struct {
	Into   string   `json:"into"`
	From   []string `json:"from"`
	Reason string   `json:"reason"`
}

// dashCard mirrors the flat card record the orchestrator writes under
// state/cards/<id>.json. The backend stays kind-agnostic: it reads, filters out
// dismissed cards, and hands the rest to the UI, which sorts and renders them
// (including a generic fallback for kinds it doesn't recognize). Priority and date
// are surfaced verbatim so the UI can build a stable sort key.
type dashCard struct {
	ID        string         `json:"id"`
	Kind      string         `json:"kind"`
	Priority  string         `json:"priority"`
	Date      string         `json:"date,omitempty"`
	Title     string         `json:"title"`
	Body      string         `json:"body,omitempty"`
	Payload   map[string]any `json:"payload,omitempty"`
	Done      bool           `json:"done"`
	Dismissed bool           `json:"dismissed"`
	Source    string         `json:"source,omitempty"`
	CreatedAt string         `json:"created_at"`
	UpdatedAt string         `json:"updated_at"`
}

type dashState struct {
	Servers     []dashServer     `json:"servers"`
	Suggestions []dashSuggestion `json:"suggestions"`
	Cards       []dashCard       `json:"cards"`
}

// rootDirs derives the mcp and orchestrator-state directories from -root, matching
// the layout scaffoldRoot lays down.
func rootDirs(root string) (mcpDir, stateDir string) {
	return filepath.Join(root, "mcp"), filepath.Join(root, "orchestrator", "state")
}

// stateHandler answers GET/POST /state with the current servers (and their notes)
// plus any open merge suggestions. It reads only, so it never mutates the scaffold.
func stateHandler(token, root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r, token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if root == "" {
			http.Error(w, "mcp disabled", http.StatusNotFound)
			return
		}
		mcpDir, stateDir := rootDirs(root)
		state := dashState{Servers: []dashServer{}, Suggestions: []dashSuggestion{}, Cards: []dashCard{}}

		// One dashServer per notebook (folder with a manifest), plus that notebook's
		// own cards — cards now live under each notebook, not in a global queue.
		for _, slug := range listNotebookSlugs(mcpDir) {
			state.Servers = append(state.Servers, readDashServer(mcpDir, slug))
			for _, c := range loadCards(mcpDir, slug) {
				if !c.Dismissed {
					state.Cards = append(state.Cards, c)
				}
			}
		}
		sort.Slice(state.Servers, func(i, j int) bool { return state.Servers[i].Name < state.Servers[j].Name })
		sort.Slice(state.Cards, func(i, j int) bool { return state.Cards[i].ID < state.Cards[j].ID })

		if sugEntries, err := os.ReadDir(filepath.Join(stateDir, "suggestions")); err == nil {
			for _, e := range sugEntries {
				if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
					continue
				}
				data, err := os.ReadFile(filepath.Join(stateDir, "suggestions", e.Name()))
				if err != nil {
					continue
				}
				var s dashSuggestion
				if json.Unmarshal(data, &s) == nil && s.Into != "" {
					state.Suggestions = append(state.Suggestions, s)
				}
			}
			sort.Slice(state.Suggestions, func(i, j int) bool { return state.Suggestions[i].Into < state.Suggestions[j].Into })
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(state)
	}
}

// notebookHandler answers GET /notebook?slug=<x> with a single notebook's detail:
// its manifest identity, notes/ pages, and its own cards. This is the lazy per-notebook
// fetch the phone uses when swapping notebooks, so the index (/state) can stay cheap.
//
// With ?meta=1 it returns the same shape but strips every page body, so the phone gets a
// cheap page index (num/title/file only) to virtualize against — it then pulls individual
// bodies via /page as the reader moves. Without it, bodies are included (the eager form).
type notebookDetail struct {
	dashServer
	Cards []dashCard `json:"cards"`
}

func notebookHandler(token, root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r, token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if root == "" {
			http.Error(w, "mcp disabled", http.StatusNotFound)
			return
		}
		slug := r.URL.Query().Get("slug")
		if !validSlug(slug) {
			http.Error(w, "bad slug", http.StatusBadRequest)
			return
		}
		mcpDir, _ := rootDirs(root)
		if !isNotebook(mcpDir, slug) {
			http.Error(w, "notebook not found", http.StatusNotFound)
			return
		}
		detail := notebookDetail{dashServer: readDashServer(mcpDir, slug), Cards: []dashCard{}}
		// The cheap index form: keep the page list (num/title/file) but drop the bodies,
		// which the phone fetches lazily per page via /page.
		if r.URL.Query().Get("meta") != "" {
			for i := range detail.Pages {
				detail.Pages[i].Body = ""
			}
		}
		for _, c := range loadCards(mcpDir, slug) {
			if !c.Dismissed {
				detail.Cards = append(detail.Cards, c)
			}
		}
		sort.Slice(detail.Cards, func(i, j int) bool { return detail.Cards[i].ID < detail.Cards[j].ID })
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(detail)
	}
}

// pageHandler answers GET /page?slug=<x>&num=<n> with a single notebook page and its
// markdown body, reading only that one file. It's the per-page fetch behind the phone's
// virtualized reader: after loading a notebook's index (/notebook?meta=1), the phone pulls
// the current page and its neighbours through here so swiping stays instant.
func pageHandler(token, root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r, token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if root == "" {
			http.Error(w, "mcp disabled", http.StatusNotFound)
			return
		}
		slug := r.URL.Query().Get("slug")
		if !validSlug(slug) {
			http.Error(w, "bad slug", http.StatusBadRequest)
			return
		}
		num, err := strconv.Atoi(r.URL.Query().Get("num"))
		if err != nil {
			http.Error(w, "bad page number", http.StatusBadRequest)
			return
		}
		mcpDir, _ := rootDirs(root)
		if !isNotebook(mcpDir, slug) {
			http.Error(w, "notebook not found", http.StatusNotFound)
			return
		}
		page, ok := readPage(mcpDir, slug, num)
		if !ok {
			http.Error(w, "page not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(page)
	}
}

// actionHandler answers POST /action for the optional yes/no loop. "merge" turns a
// suggestion into a real consolidation request (drained by materializeConsolidations
// on the next run) and clears the suggestion; "dismiss" just clears it. Subject
// slugs are validated (validSlug) so an action can't write outside the state dir.
func actionHandler(token, root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r, token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if root == "" {
			http.Error(w, "mcp disabled", http.StatusNotFound)
			return
		}
		var req struct {
			Action string   `json:"action"`
			Into   string   `json:"into"`
			From   []string `json:"from"`
			ID     string   `json:"id"`
			Source string   `json:"source"` // optional notebook slug the card lives under
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		mcpDir, stateDir := rootDirs(root)

		// Card actions carry an id and mutate a single mcp/<slug>/cards/<id>.json.
		// `source` (when the phone knows it) points straight at the owning notebook;
		// otherwise updateCard searches every notebook. "dismiss" is shared with
		// suggestions, so an id routes it here; without one it falls through to the
		// suggestion switch below (keyed on 'into').
		switch req.Action {
		case "complete", "uncomplete":
			if !validSlug(req.ID) {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			if !updateCard(mcpDir, req.Source, req.ID, func(c *dashCard) { c.Done = req.Action == "complete" }) {
				http.Error(w, "card not found", http.StatusNotFound)
				return
			}
			writeOK(w)
			return
		case "dismiss":
			if req.ID != "" {
				if !validSlug(req.ID) {
					http.Error(w, "bad request", http.StatusBadRequest)
					return
				}
				if !updateCard(mcpDir, req.Source, req.ID, func(c *dashCard) { c.Dismissed = true }) {
					http.Error(w, "card not found", http.StatusNotFound)
					return
				}
				writeOK(w)
				return
			}
		}

		if !validSlug(req.Into) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		sugPath := filepath.Join(stateDir, "suggestions", req.Into+".json")

		switch req.Action {
		case "merge":
			var from []string
			for _, f := range req.From {
				if validSlug(f) && f != req.Into {
					from = append(from, f)
				}
			}
			if len(from) == 0 {
				http.Error(w, "no valid subjects to merge", http.StatusBadRequest)
				return
			}
			conDir := filepath.Join(stateDir, "consolidations")
			if err := os.MkdirAll(conDir, 0o755); err != nil {
				http.Error(w, "write failed", http.StatusInternalServerError)
				return
			}
			data, _ := json.MarshalIndent(map[string]any{"into": req.Into, "from": from}, "", "  ")
			if err := os.WriteFile(filepath.Join(conDir, req.Into+".json"), append(data, '\n'), 0o644); err != nil {
				http.Error(w, "write failed", http.StatusInternalServerError)
				return
			}
			os.Remove(sugPath)
		case "dismiss":
			os.Remove(sugPath)
		default:
			http.Error(w, "unknown action", http.StatusBadRequest)
			return
		}

		writeOK(w)
	}
}

func writeOK(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte("{\"ok\":true}\n"))
}

// updateCard finds mcp/<slug>/cards/<id>.json, applies mutate, bumps updated_at, and
// writes it back. `hint` (the card's source notebook, when the caller knows it) is
// tried first; otherwise every notebook is searched. Reports false when the card is
// missing so the caller can 404. id and hint must already be validSlug-checked.
func updateCard(mcpDir, hint, id string, mutate func(*dashCard)) bool {
	try := func(slug string) bool {
		path := filepath.Join(cardsDirFor(mcpDir, slug), id+".json")
		data, err := os.ReadFile(path)
		if err != nil {
			return false
		}
		var c dashCard
		if json.Unmarshal(data, &c) != nil {
			return false
		}
		mutate(&c)
		c.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		out, err := json.MarshalIndent(c, "", "  ")
		if err != nil {
			return false
		}
		return os.WriteFile(path, append(out, '\n'), 0o644) == nil
	}
	if validSlug(hint) && try(hint) {
		return true
	}
	for _, slug := range listNotebookSlugs(mcpDir) {
		if slug == hint {
			continue
		}
		if try(slug) {
			return true
		}
	}
	return false
}
