package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
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

type dashState struct {
	Servers     []dashServer     `json:"servers"`
	Suggestions []dashSuggestion `json:"suggestions"`
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
		state := dashState{Servers: []dashServer{}, Suggestions: []dashSuggestion{}}

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
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || !validSlug(req.Into) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		_, stateDir := rootDirs(root)
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

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{\"ok\":true}\n"))
	}
}
