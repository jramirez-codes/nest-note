package main

import (
	"encoding/json"
	"fmt"
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
	Tags      []string       `json:"tags,omitempty"`
	Payload   map[string]any `json:"payload,omitempty"`
	Done      bool           `json:"done"`
	Dismissed bool           `json:"dismissed"`
	Source    string         `json:"source,omitempty"`
	CreatedAt string         `json:"created_at"`
	UpdatedAt string         `json:"updated_at"`
}

// dashReorg is a pending page-reorganization proposal for one notebook, dropped by the
// orchestrator's propose_reorg tool. The user approves or dismisses it in the dashboard;
// FromPages/ToPages give the confirm card a "N pages → M pages" summary (both counts
// exclude the Appendix and the protected Task Log pages).
type dashReorg struct {
	Subject   string `json:"subject"`
	Summary   string `json:"summary"`
	FromPages int    `json:"from_pages"`
	ToPages   int    `json:"to_pages"`
}

type dashState struct {
	Servers     []dashServer     `json:"servers"`
	Suggestions []dashSuggestion `json:"suggestions"`
	Reorgs      []dashReorg      `json:"reorgs"`
	Cards       []dashCard       `json:"cards"`
}

// reorgProposal is the on-disk shape of state/reorgs/<subject>.json: the target subject,
// a one-line summary, and the full intended set of content pages.
type reorgProposal struct {
	Subject string      `json:"subject"`
	Summary string      `json:"summary"`
	Pages   []reorgPage `json:"pages"`
}

// loadReorg reads a notebook's pending reorg proposal, if any.
func loadReorg(stateDir, subject string) (reorgProposal, bool) {
	data, err := os.ReadFile(filepath.Join(stateDir, "reorgs", subject+".json"))
	if err != nil {
		return reorgProposal{}, false
	}
	var p reorgProposal
	if json.Unmarshal(data, &p) != nil {
		return reorgProposal{}, false
	}
	if p.Subject == "" {
		p.Subject = subject
	}
	return p, true
}

// contentPageCount counts a notebook's content pages, excluding the Appendix and every
// Task Log page — the pages a reorg actually replaces.
func contentPageCount(mcpDir, slug string) int {
	n := 0
	for _, p := range listPages(mcpDir, slug) {
		if p.Num == appendixNum {
			continue
		}
		if _, isLog := taskLogSeq(p.Title); isLog {
			continue
		}
		n++
	}
	return n
}

// toDashReorg turns an on-disk proposal into the dashboard's view, computing the current
// content-page count for the "N pages → M pages" confirm summary.
func toDashReorg(mcpDir string, p reorgProposal) dashReorg {
	return dashReorg{
		Subject:   p.Subject,
		Summary:   p.Summary,
		FromPages: contentPageCount(mcpDir, p.Subject),
		ToPages:   len(p.Pages),
	}
}

// readReorgs collects every pending reorg proposal under stateDir/reorgs, as the
// dashboard's view, sorted by subject.
func readReorgs(mcpDir, stateDir string) []dashReorg {
	out := []dashReorg{}
	entries, err := os.ReadDir(filepath.Join(stateDir, "reorgs"))
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		subject := strings.TrimSuffix(e.Name(), ".json")
		if p, ok := loadReorg(stateDir, subject); ok {
			out = append(out, toDashReorg(mcpDir, p))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Subject < out[j].Subject })
	return out
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
		state := dashState{Servers: []dashServer{}, Suggestions: []dashSuggestion{}, Reorgs: []dashReorg{}, Cards: []dashCard{}}

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

		state.Reorgs = readReorgs(mcpDir, stateDir)

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
	// Reorgs holds this notebook's pending reorg proposal (0 or 1), so the notebook view
	// can show the same confirm card the Sandbox does.
	Reorgs []dashReorg `json:"reorgs"`
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
		mcpDir, stateDir := rootDirs(root)
		if !isNotebook(mcpDir, slug) {
			http.Error(w, "notebook not found", http.StatusNotFound)
			return
		}
		detail := notebookDetail{dashServer: readDashServer(mcpDir, slug), Cards: []dashCard{}, Reorgs: []dashReorg{}}
		if p, ok := loadReorg(stateDir, slug); ok {
			detail.Reorgs = append(detail.Reorgs, toDashReorg(mcpDir, p))
		}
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
// on the next run) and clears the suggestion; "dismiss" just clears it. Card verbs
// ("complete"/"uncomplete", "dismiss" with an id, and "restore", which writes a
// content snapshot back over a card) mutate a single card file. Subject slugs and
// card ids are validated (validSlug) so an action can't write outside the state dir.
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
			if _, ok := updateCard(mcpDir, req.Source, req.ID, func(c *dashCard) { c.Done = req.Action == "complete" }); !ok {
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
				var dismissed dashCard
				slug, ok := updateCard(mcpDir, req.Source, req.ID, func(c *dashCard) {
					c.Dismissed = true
					dismissed = *c
				})
				if !ok {
					http.Error(w, "card not found", http.StatusNotFound)
					return
				}
				logTaskDismissal(mcpDir, slug, dismissed)
				writeOK(w)
				return
			}
		case "restore":
			// Put a card's user-visible content back to a snapshot the phone is
			// holding — the idea page's undo, which reverts what Claude wrote to
			// the card while the user was chatting about it. Only the four fields
			// that page renders are written; the card's id, kind, dates and
			// done/dismissed state are whatever they are now and stay that way.
			if !validSlug(req.ID) || len(req.Priority) > 32 {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			if _, ok := updateCard(mcpDir, req.Source, req.ID, func(c *dashCard) {
				c.Title = req.Title
				c.Body = req.Body
				c.Tags = req.Tags
				c.Priority = req.Priority
			}); !ok {
				http.Error(w, "card not found", http.StatusNotFound)
				return
			}
			writeOK(w)
			return
		case "reorg", "reorg-dismiss":
			// A page-reorganization proposal is keyed on its notebook slug. "reorg"
			// applies it now (pure notes/*.md rewriting — no next-run drain needed),
			// preserving the notebook's Task Log pages; "reorg-dismiss" just discards it.
			if !validSlug(req.Subject) {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			reoPath := filepath.Join(stateDir, "reorgs", req.Subject+".json")
			if req.Action == "reorg" {
				p, ok := loadReorg(stateDir, req.Subject)
				if !ok {
					http.Error(w, "reorg not found", http.StatusNotFound)
					return
				}
				if err := applyReorg(mcpDir, req.Subject, p.Pages); err != nil {
					http.Error(w, "reorg failed", http.StatusInternalServerError)
					return
				}
			}
			os.Remove(reoPath)
			writeOK(w)
			return
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
// tried first; otherwise every notebook is searched. Reports the notebook slug the
// card was actually found under, and false when the card is missing so the caller
// can 404. id and hint must already be validSlug-checked.
func updateCard(mcpDir, hint, id string, mutate func(*dashCard)) (slug string, ok bool) {
	try := func(s string) bool {
		path := filepath.Join(cardsDirFor(mcpDir, s), id+".json")
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
		if os.WriteFile(path, append(out, '\n'), 0o644) != nil {
			return false
		}
		slug = s
		return true
	}
	if validSlug(hint) && try(hint) {
		return slug, true
	}
	for _, s := range listNotebookSlugs(mcpDir) {
		if s == hint {
			continue
		}
		if try(s) {
			return slug, true
		}
	}
	return "", false
}

// logTaskDismissal appends one entry to the owning notebook's "Task Log" page
// recording that a task was deleted: whether it was completed or dropped, and how
// long it lived (created_at -> the moment it was dismissed). See taskLogLine for
// the entry's format.
func logTaskDismissal(mcpDir, slug string, c dashCard) {
	if slug == "" || c.Kind != "task" {
		return
	}
	_ = upsertPage(mcpDir, slug, taskLogTargetTitle(mcpDir, slug), []string{taskLogLine(c)})
}

// taskLogPageCap is the most entries kept on one "Task Log" page before a dismissal
// rolls onto a new one ("Task Log 2", "Task Log 3", ...), so a long-lived notebook's
// log stays a series of bounded pages instead of one ever-growing file.
const taskLogPageCap = 100

// taskLogTargetTitle picks which "Task Log" page the next dismissal entry belongs
// on: the highest-numbered existing one if it still has room, otherwise the next
// one in the sequence.
func taskLogTargetTitle(mcpDir, slug string) string {
	n, body := latestTaskLogPage(listPages(mcpDir, slug))
	if n > 0 && countTaskLogEntries(body) >= taskLogPageCap {
		n++
	}
	if n <= 1 {
		return "Task Log"
	}
	return fmt.Sprintf("Task Log %d", n)
}

// latestTaskLogPage returns the sequence number (1 for bare "Task Log", 2+ for
// "Task Log N") and body of the highest-numbered Task Log page present, or (0, "")
// if the notebook doesn't have one yet.
func latestTaskLogPage(pages []notePage) (int, string) {
	best, body := 0, ""
	for _, p := range pages {
		if n, ok := taskLogSeq(p.Title); ok && n > best {
			best, body = n, p.Body
		}
	}
	return best, body
}

// countTaskLogEntries counts task-log entries in a page body by counting "## "
// headings (one per entry — see taskLogLine). A manually edited page that loses a
// heading just undercounts by that much; the cap is a soft target, not a guarantee,
// so that's fine.
func countTaskLogEntries(body string) int {
	n := 0
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "## ") {
			n++
		}
	}
	return n
}

// taskLogLine renders one dismissal as its own "## " heading (just the task title)
// followed by plain bullets for the details — readable directly in the notebook, no
// machine-only tag. No source field: the entry already lives on the owning
// subject's own Task Log page.
func taskLogLine(c dashCard) string {
	now := time.Now().UTC()
	verb := "Dropped"
	if c.Done {
		verb = "Completed"
	}
	created, err := time.Parse(time.RFC3339, c.CreatedAt)
	if err != nil {
		created = now
	}
	dur := now.Sub(created)
	return strings.Join([]string{
		fmt.Sprintf("## %s", c.Title),
		fmt.Sprintf("- %s after %s", verb, humanDuration(dur)),
		fmt.Sprintf("- Filed %s → Closed %s", created.Format("2006-01-02 15:04 MST"), now.Format("2006-01-02 15:04 MST")),
		fmt.Sprintf("- id: `%s`", c.ID),
	}, "\n")
}

// humanDuration renders a duration as its two most significant units (days+hours,
// hours+minutes, minutes+seconds, or bare seconds) for a short, readable "took X" note.
func humanDuration(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	days := int(d.Hours()) / 24
	hours := int(d.Hours()) % 24
	mins := int(d.Minutes()) % 60
	secs := int(d.Seconds()) % 60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd %dh", days, hours)
	case hours > 0:
		return fmt.Sprintf("%dh %dm", hours, mins)
	case mins > 0:
		return fmt.Sprintf("%dm %ds", mins, secs)
	default:
		return fmt.Sprintf("%ds", secs)
	}
}
