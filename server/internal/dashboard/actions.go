package dashboard

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"nestnote/server/internal/build"
	"nestnote/server/internal/httpx"
	"nestnote/server/internal/store"
)

// ActionHandler answers POST /action for the optional yes/no loop. "merge" turns a
// suggestion into a real consolidation request (drained by the scaffold on the next
// run) and clears the suggestion; "dismiss" just clears it. Card verbs
// ("complete"/"uncomplete", "dismiss" with an id, and "restore", which writes a
// content snapshot back over a card) mutate a single card file. Subject slugs and
// card ids are validated (store.ValidSlug) so an action can't write outside the
// state dir.
//
// It takes the build config because dismissing a card is how an idea is deleted
// and how a built feature is rejected: neither an idea's scheduled build nor a
// build whose feature was just turned down may outlive the card the user
// dismissed — see build.Config.StopForCard.
func ActionHandler(token, root string, builds build.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !httpx.Guard(w, r, token) {
			return
		}
		if root == "" {
			http.Error(w, "mcp disabled", http.StatusNotFound)
			return
		}
		var req struct {
			Action  string   `json:"action"`
			Into    string   `json:"into"`
			From    []string `json:"from"`
			ID      string   `json:"id"`
			Source  string   `json:"source"`  // optional notebook slug the card lives under
			Subject string   `json:"subject"` // notebook slug a reorg action targets
			// The snapshot a "restore" action puts back on a card.
			Title    string   `json:"title"`
			Body     string   `json:"body"`
			Tags     []string `json:"tags"`
			Priority string   `json:"priority"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		mcpDir, stateDir := store.RootDirs(root)

		// Card actions carry an id and mutate a single mcp/<slug>/cards/<id>.json.
		// `source` (when the phone knows it) points straight at the owning notebook;
		// otherwise store.UpdateCard searches every notebook. "dismiss" is shared with
		// suggestions, so an id routes it here; without one it falls through to the
		// suggestion switch below (keyed on 'into').
		switch req.Action {
		case "complete", "uncomplete":
			if !store.ValidSlug(req.ID) {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			if _, ok := store.UpdateCard(mcpDir, req.Source, req.ID, func(c *store.Card) { c.Done = req.Action == "complete" }); !ok {
				http.Error(w, "card not found", http.StatusNotFound)
				return
			}
			httpx.WriteOK(w)
			return
		case "dismiss":
			if req.ID != "" {
				if !store.ValidSlug(req.ID) {
					http.Error(w, "bad request", http.StatusBadRequest)
					return
				}
				var dismissed store.Card
				slug, ok := store.UpdateCard(mcpDir, req.Source, req.ID, func(c *store.Card) {
					c.Dismissed = true
					dismissed = *c
				})
				if !ok {
					http.Error(w, "card not found", http.StatusNotFound)
					return
				}
				logTaskDismissal(mcpDir, slug, dismissed)
				// Dismissing a card is how the dashboard deletes one, so an idea
				// card going means any build it started goes with it: the run is
				// killed, the crontab entry removed, and the step card left
				// standing says the build was stopped.
				// Dismissing a gate card is how a feature is rejected, and that
				// ends the build too — both while the user is still looking at the
				// dashboard, rather than whenever cron next comes round.
				// Every card comes through here, not just those two — a card that
				// drives no build matches nothing and this is one directory read.
				builds.StopForCard(mcpDir, slug, req.ID)
				httpx.WriteOK(w)
				return
			}
		case "restore":
			// Put a card's user-visible content back to a snapshot the phone is
			// holding — the idea page's undo, which reverts what Claude wrote to
			// the card while the user was chatting about it. Only the four fields
			// that page renders are written; the card's id, kind, dates and
			// done/dismissed state are whatever they are now and stay that way.
			if !store.ValidSlug(req.ID) || len(req.Priority) > 32 {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			if _, ok := store.UpdateCard(mcpDir, req.Source, req.ID, func(c *store.Card) {
				c.Title = req.Title
				c.Body = req.Body
				c.Tags = req.Tags
				c.Priority = req.Priority
			}); !ok {
				http.Error(w, "card not found", http.StatusNotFound)
				return
			}
			httpx.WriteOK(w)
			return
		case "reorg", "reorg-dismiss":
			// A page-reorganization proposal is keyed on its notebook slug. "reorg"
			// applies it now (pure notes/*.md rewriting — no next-run drain needed),
			// preserving the notebook's Task Log pages; "reorg-dismiss" just discards it.
			if !store.ValidSlug(req.Subject) {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			reoPath := filepath.Join(stateDir, "reorgs", req.Subject+".json")
			if req.Action == "reorg" {
				p, ok := store.LoadReorg(stateDir, req.Subject)
				if !ok {
					http.Error(w, "reorg not found", http.StatusNotFound)
					return
				}
				if err := store.ApplyReorg(mcpDir, req.Subject, p.Pages); err != nil {
					http.Error(w, "reorg failed", http.StatusInternalServerError)
					return
				}
			}
			os.Remove(reoPath)
			httpx.WriteOK(w)
			return
		}

		if !store.ValidSlug(req.Into) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		sugPath := filepath.Join(stateDir, "suggestions", req.Into+".json")

		switch req.Action {
		case "merge":
			var from []string
			for _, f := range req.From {
				if store.ValidSlug(f) && f != req.Into {
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

		httpx.WriteOK(w)
	}
}
