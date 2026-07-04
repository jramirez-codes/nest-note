package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The dashboard endpoints let the phone read and lightly steer the MCP world
// without spinning up Claude. They only ever touch the scaffold's own data files
// (capability.json, the per-subject markdown, and the orchestrator's suggestion/
// consolidation queues), so they are cheap and can't run arbitrary code. Both are
// bearer-token authed over the same pinned TLS the rest of the server uses.

// dashServer is one capability server as the dashboard sees it: its identity plus
// the full markdown of its notes (read straight off disk, so freshly ingested
// notes show even before the queryable MCP binary is scaffolded).
type dashServer struct {
	Name    string   `json:"name"`
	Summary string   `json:"summary"`
	Tools   []string `json:"tools"`
	Notes   string   `json:"notes"`
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

		entries, _ := os.ReadDir(mcpDir)
		for _, e := range entries {
			name := e.Name()
			if !e.IsDir() || name == "mcpx" || name == "bin" {
				continue
			}
			capData, err := os.ReadFile(filepath.Join(mcpDir, name, "capability.json"))
			if err != nil {
				continue // not a capability server (no manifest)
			}
			var c struct {
				Name    string   `json:"name"`
				Summary string   `json:"summary"`
				Tools   []string `json:"tools"`
			}
			if json.Unmarshal(capData, &c) != nil {
				continue
			}
			if c.Name == "" {
				c.Name = name
			}
			notes, _ := os.ReadFile(filepath.Join(mcpDir, name, name+".md"))
			state.Servers = append(state.Servers, dashServer{
				Name:    c.Name,
				Summary: c.Summary,
				Tools:   c.Tools,
				Notes:   string(notes),
			})
		}
		sort.Slice(state.Servers, func(i, j int) bool { return state.Servers[i].Name < state.Servers[j].Name })

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

		// Cards (tasks + notifications + any future kind). Read every card file,
		// drop dismissed ones, and hand the rest over unsorted — the UI computes
		// the priority+date sort key so a new kind needs no backend change.
		if cardEntries, err := os.ReadDir(filepath.Join(stateDir, "cards")); err == nil {
			for _, e := range cardEntries {
				if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
					continue
				}
				data, err := os.ReadFile(filepath.Join(stateDir, "cards", e.Name()))
				if err != nil {
					continue
				}
				var c dashCard
				if json.Unmarshal(data, &c) == nil && c.ID != "" && !c.Dismissed {
					state.Cards = append(state.Cards, c)
				}
			}
			sort.Slice(state.Cards, func(i, j int) bool { return state.Cards[i].ID < state.Cards[j].ID })
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(state)
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
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		_, stateDir := rootDirs(root)

		// Card actions carry an id and mutate a single state/cards/<id>.json.
		// "dismiss" is shared with suggestions, so an id routes it here; without
		// one it falls through to the suggestion switch below (keyed on 'into').
		switch req.Action {
		case "complete", "uncomplete":
			if !validSlug(req.ID) {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			if !updateCard(stateDir, req.ID, func(c *dashCard) { c.Done = req.Action == "complete" }) {
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
				if !updateCard(stateDir, req.ID, func(c *dashCard) { c.Dismissed = true }) {
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

// updateCard reads state/cards/<id>.json, applies mutate, bumps updated_at, and
// writes it back. It reports false when the card is missing or unreadable so the
// caller can 404. id must already be validSlug-checked so it can't escape the dir.
func updateCard(stateDir, id string, mutate func(*dashCard)) bool {
	path := filepath.Join(stateDir, "cards", id+".json")
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
