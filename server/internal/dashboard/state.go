// Package dashboard is the read-and-lightly-steer surface the phone uses without
// spinning up Claude: /state, /notebook, /page and /action. Everything here only
// ever touches the scaffold's own data files, so it is cheap and can't run
// arbitrary code.
//
//	state.go     /state — the whole world in one payload
//	notebook.go  /notebook and /page — the lazy per-notebook and per-page fetches
//	actions.go   /action — the yes/no loop over cards, merges and reorgs
//	tasklog.go   the Task Log page a dismissed task is recorded on
package dashboard

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"nestnote/server/internal/httpx"
	"nestnote/server/internal/store"
)

// Server is one notebook as the dashboard sees it: its identity (from the
// notebook.json manifest) plus its ordered notes pages (read straight off disk, so
// freshly ingested notes show even before the queryable MCP binary is scaffolded).
// Name stays the slug so the phone can key cards to it by `source`; Title/Icon/Accent/
// Pinned/UpdatedAt come from the manifest for a richer view. Pages[0] is the Appendix.
type Server struct {
	Name      string           `json:"name"`
	Title     string           `json:"title"`
	Summary   string           `json:"summary"`
	Icon      string           `json:"icon,omitempty"`
	Accent    string           `json:"accent,omitempty"`
	Pinned    bool             `json:"pinned"`
	UpdatedAt string           `json:"updated_at,omitempty"`
	Tools     []string         `json:"tools"`
	Pages     []store.NotePage `json:"pages"`
}

// readServer assembles the dashboard view of one notebook from its manifest,
// notes/ pages, and capability.json (for the queryable tool list, if built yet).
func readServer(mcpDir, slug string) Server {
	nb := store.LoadNotebook(mcpDir, slug)
	var tools []string
	if capData, err := os.ReadFile(filepath.Join(mcpDir, slug, "capability.json")); err == nil {
		var c struct {
			Tools []string `json:"tools"`
		}
		json.Unmarshal(capData, &c)
		tools = c.Tools
	}
	pages := store.ListPages(mcpDir, slug)
	if pages == nil {
		pages = []store.NotePage{}
	}
	return Server{
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

// Suggestion is an optional, non-blocking merge proposal the orchestrator
// dropped during an ingest. The user approves or dismisses it in the dashboard.
type Suggestion struct {
	Into   string   `json:"into"`
	From   []string `json:"from"`
	Reason string   `json:"reason"`
}

// Reorg is a pending page-reorganization proposal for one notebook, dropped by the
// orchestrator's propose_reorg tool. The user approves or dismisses it in the dashboard;
// FromPages/ToPages give the confirm card a "N pages → M pages" summary (both counts
// exclude the Appendix and the protected Task Log pages).
type Reorg struct {
	Subject   string `json:"subject"`
	Summary   string `json:"summary"`
	FromPages int    `json:"from_pages"`
	ToPages   int    `json:"to_pages"`
}

type State struct {
	Servers     []Server     `json:"servers"`
	Suggestions []Suggestion `json:"suggestions"`
	Reorgs      []Reorg      `json:"reorgs"`
	Cards       []store.Card `json:"cards"`
}

// toReorg turns an on-disk proposal into the dashboard's view, computing the current
// content-page count for the "N pages → M pages" confirm summary.
func toReorg(mcpDir string, p store.ReorgProposal) Reorg {
	return Reorg{
		Subject:   p.Subject,
		Summary:   p.Summary,
		FromPages: store.ContentPageCount(mcpDir, p.Subject),
		ToPages:   len(p.Pages),
	}
}

// readReorgs collects every pending reorg proposal under stateDir/reorgs, as the
// dashboard's view, sorted by subject.
func readReorgs(mcpDir, stateDir string) []Reorg {
	out := []Reorg{}
	for _, subject := range store.ListReorgSubjects(stateDir) {
		if p, ok := store.LoadReorg(stateDir, subject); ok {
			out = append(out, toReorg(mcpDir, p))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Subject < out[j].Subject })
	return out
}

// StateHandler answers GET/POST /state with the current servers (and their notes)
// plus any open merge suggestions. It reads only, so it never mutates the scaffold.
func StateHandler(token, root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !httpx.Guard(w, r, token) {
			return
		}
		if root == "" {
			http.Error(w, "mcp disabled", http.StatusNotFound)
			return
		}
		mcpDir, stateDir := store.RootDirs(root)
		state := State{Servers: []Server{}, Suggestions: []Suggestion{}, Reorgs: []Reorg{}, Cards: []store.Card{}}

		// One Server per notebook (folder with a manifest), plus that notebook's
		// own cards — cards now live under each notebook, not in a global queue.
		for _, slug := range store.ListNotebookSlugs(mcpDir) {
			state.Servers = append(state.Servers, readServer(mcpDir, slug))
			for _, c := range store.LoadCards(mcpDir, slug) {
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
				var s Suggestion
				if json.Unmarshal(data, &s) == nil && s.Into != "" {
					state.Suggestions = append(state.Suggestions, s)
				}
			}
			sort.Slice(state.Suggestions, func(i, j int) bool { return state.Suggestions[i].Into < state.Suggestions[j].Into })
		}

		state.Reorgs = readReorgs(mcpDir, stateDir)

		httpx.WriteJSON(w, state)
	}
}
