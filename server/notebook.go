package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The on-disk contract for a notebook — one subject folder under mcp/. A notebook
// is fully viewable from these files alone; the MCP binary (main.go + capability.json)
// is a separate, lazily-built *query* layer Claude uses during /ask.
//
//	mcp/<slug>/
//	  notebook.json   manifest: the notebook's identity + appearance  (this file)
//	  notes/          ordered markdown pages: "#N (Title).md" (see below)
//	  cards/<id>.json this notebook's tasks / ideas
//	  capability.json MCP tool manifest (query layer)
//	  main.go         the fact-store MCP server (query layer)
//
// A folder is a *notebook* precisely when it has a notebook.json; a pure capability
// server (e.g. the dog demo) has none and is not shown to the user as a notebook.
//
// Notes are a folder of pages, not a single file. Each page is "#<num> (<title>).md";
// page #0 is the auto-generated Appendix (an index of [[#N (Title)]] links), and
// content pages are 1-based. Within-notebook links are [[#N (Title)]]; cross-notebook
// links are [[slug::#N (Title)]].
const (
	notebookManifest = "notebook.json"
	notesSubdir      = "notes"
	legacyNotesFile  = "notes.md" // pre-folder single-file layout, migrated away
	cardsSubdir      = "cards"
	inboxSlug        = "inbox"
	// orchestratorSlug is a reserved notebook: viewable (data-only), but never a
	// generated query server — that name belongs to the real orchestrator MCP.
	orchestratorSlug = "orchestrator"
	appendixNum      = 0
	appendixTitle    = "Appendix"
)

// notebook is the viewable identity of a subject folder, kept separate from
// capability.json (which describes MCP tools). Icon/Accent are optional hints the
// phone maps to a Lucide glyph and a Catppuccin hue.
type notebook struct {
	Slug      string `json:"slug"`
	Title     string `json:"title"`
	Summary   string `json:"summary"`
	Icon      string `json:"icon,omitempty"`
	Accent    string `json:"accent,omitempty"`
	Pinned    bool   `json:"pinned"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

func nowStamp() string { return time.Now().UTC().Format(time.RFC3339) }

func notesDirFor(mcpDir, slug string) string { return filepath.Join(mcpDir, slug, notesSubdir) }
func cardsDirFor(mcpDir, slug string) string {
	return filepath.Join(mcpDir, slug, cardsSubdir)
}

// notePage is one markdown page in a notebook's notes/ folder. Num is the page
// number (0 = the Appendix), Title is the parenthesized name, File is the on-disk
// "#N (Title).md" filename, and Body is the raw markdown.
type notePage struct {
	Num   int    `json:"num"`
	Title string `json:"title"`
	File  string `json:"file"`
	Body  string `json:"body"`
}

// pageFileRe matches a page filename "#<num> (<title>).md" and captures the two parts.
var pageFileRe = regexp.MustCompile(`^#(\d+) \((.+)\)\.md$`)

// sanitizePageTitle strips characters that would break the "#N (title).md" grammar
// (parens and slashes), collapses whitespace, and caps the length so a title always
// yields a valid, tidy filename.
func sanitizePageTitle(title string) string {
	title = strings.NewReplacer("(", " ", ")", " ", "/", " ", "\n", " ", "\r", " ").Replace(title)
	title = strings.Join(strings.Fields(title), " ")
	if title == "" {
		title = "Untitled"
	}
	if len(title) > 60 {
		title = strings.TrimSpace(title[:60])
	}
	return title
}

func pageFileName(num int, title string) string {
	return fmt.Sprintf("#%d (%s).md", num, sanitizePageTitle(title))
}

// parsePageFile pulls the number and title out of a "#N (Title).md" filename. ok is
// false for anything that isn't a page (so stray files are ignored).
func parsePageFile(name string) (num int, title string, ok bool) {
	m := pageFileRe.FindStringSubmatch(name)
	if m == nil {
		return 0, "", false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, "", false
	}
	return n, m[2], true
}

// listPages reads a notebook's notes/ folder into the ordered pages (Appendix first),
// each with its body. Returns nil when the folder is absent.
func listPages(mcpDir, slug string) []notePage {
	dir := notesDirFor(mcpDir, slug)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var pages []notePage
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		num, title, ok := parsePageFile(e.Name())
		if !ok {
			continue
		}
		body, _ := os.ReadFile(filepath.Join(dir, e.Name()))
		pages = append(pages, notePage{Num: num, Title: title, File: e.Name(), Body: string(body)})
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].Num < pages[j].Num })
	return pages
}

// listPageStubs is listPages without reading bodies: it parses num/title/file from the
// notes/ folder's names alone, so building a notebook's page index stays cheap even when
// its pages are large. Bodies are then fetched one page at a time via readPage — the
// backbone of the phone's page virtualization.
func listPageStubs(mcpDir, slug string) []notePage {
	dir := notesDirFor(mcpDir, slug)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var pages []notePage
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		num, title, ok := parsePageFile(e.Name())
		if !ok {
			continue
		}
		pages = append(pages, notePage{Num: num, Title: title, File: e.Name()})
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].Num < pages[j].Num })
	return pages
}

// readPage returns one page (with its body) by number, reading only that single file so a
// page fetch never pays for the rest of the notebook. ok is false when no page has that num.
func readPage(mcpDir, slug string, num int) (notePage, bool) {
	for _, p := range listPageStubs(mcpDir, slug) {
		if p.Num == num {
			body, _ := os.ReadFile(filepath.Join(notesDirFor(mcpDir, slug), p.File))
			p.Body = string(body)
			return p, true
		}
	}
	return notePage{}, false
}

// nextPageNum returns the next free content-page number (>= 1), skipping the Appendix.
func nextPageNum(pages []notePage) int {
	next := 1
	for _, p := range pages {
		if p.Num >= next {
			next = p.Num + 1
		}
	}
	return next
}

// upsertPage files bullets under a titled content page: an existing content page with
// the same title (case-insensitive) has the bullets appended; otherwise a new
// next-numbered page is created. The Appendix is regenerated and the manifest touched
// so the index and recency stay current. Creating a new non-Task-Log page pushes any
// existing Task Log page(s) to higher numbers so they stay the notebook's last pages.
func upsertPage(mcpDir, slug, title string, bullets []string) error {
	title = sanitizePageTitle(title)
	dir := notesDirFor(mcpDir, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	pages := listPages(mcpDir, slug)
	num := nextPageNum(pages)
	body := "# " + title + "\n"
	reused := false
	// An existing content page with the same title (case-insensitive) is reused —
	// keep its number AND its original title so we append in place, not fork a file.
	for _, p := range pages {
		if p.Num != appendixNum && strings.EqualFold(p.Title, title) {
			num, title, body = p.Num, p.Title, p.Body
			reused = true
			break
		}
	}
	if _, isLog := taskLogSeq(title); !reused && !isLog {
		if err := pushTaskLogPagesAfter(mcpDir, slug, num, pages); err != nil {
			return err
		}
	}
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	for _, b := range bullets {
		if b = strings.TrimSpace(b); b != "" {
			// A block that's already a heading (e.g. a task-log entry) is inserted as
			// its own block, blank-line separated, rather than folded into a bullet.
			if strings.HasPrefix(b, "#") {
				if !strings.HasSuffix(body, "\n\n") {
					body += "\n"
				}
				body += b + "\n\n"
			} else {
				body += "- " + b + "\n"
			}
		}
	}
	if err := os.WriteFile(filepath.Join(dir, pageFileName(num, title)), []byte(body), 0o644); err != nil {
		return err
	}
	if err := rebuildAppendix(mcpDir, slug); err != nil {
		return err
	}
	return touchNotebook(mcpDir, slug, "")
}

// taskLogSeq reports whether title is a Task Log page's title ("Task Log" or
// "Task Log N"), returning its sequence number (1 for the bare title).
func taskLogSeq(title string) (int, bool) {
	switch {
	case title == "Task Log":
		return 1, true
	case strings.HasPrefix(title, "Task Log "):
		if v, err := strconv.Atoi(strings.TrimPrefix(title, "Task Log ")); err == nil && v > 1 {
			return v, true
		}
	}
	return 0, false
}

// pushTaskLogPagesAfter renumbers any existing Task Log pages so they all sit at
// numbers greater than afterNum, in their existing sequence order — keeping them
// the notebook's last pages whenever a new non-Task-Log page claims a number.
// No-op if there's no Task Log page yet.
func pushTaskLogPagesAfter(mcpDir, slug string, afterNum int, pages []notePage) error {
	var logs []notePage
	for _, p := range pages {
		if _, ok := taskLogSeq(p.Title); ok {
			logs = append(logs, p)
		}
	}
	if len(logs) == 0 {
		return nil
	}
	sort.Slice(logs, func(i, j int) bool {
		ni, _ := taskLogSeq(logs[i].Title)
		nj, _ := taskLogSeq(logs[j].Title)
		return ni < nj
	})
	dir := notesDirFor(mcpDir, slug)
	next := afterNum + 1
	for _, p := range logs {
		if p.Num != next {
			oldPath := filepath.Join(dir, p.File)
			newPath := filepath.Join(dir, pageFileName(next, p.Title))
			if err := os.Rename(oldPath, newPath); err != nil {
				return err
			}
		}
		next++
	}
	return nil
}

// rebuildAppendix regenerates a notebook's "#0 (Appendix).md": the notebook title and
// summary, then a "## Pages" index of within-notebook [[#N (Title)]] links to every
// content page in order. Server-owned and overwritten on every page change, so it can
// never drift from the real page list.
func rebuildAppendix(mcpDir, slug string) error {
	dir := notesDirFor(mcpDir, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	nb := loadNotebook(mcpDir, slug)
	var b strings.Builder
	b.WriteString("# " + nb.Title + " — Appendix\n\n")
	if s := strings.TrimSpace(nb.Summary); s != "" {
		b.WriteString(s + "\n\n")
	}
	b.WriteString("## Pages\n")
	count := 0
	for _, p := range listPages(mcpDir, slug) {
		if p.Num == appendixNum {
			continue
		}
		fmt.Fprintf(&b, "- [[#%d (%s)]]\n", p.Num, p.Title)
		count++
	}
	if count == 0 {
		b.WriteString("_No pages yet._\n")
	}
	return os.WriteFile(filepath.Join(dir, pageFileName(appendixNum, appendixTitle)), []byte(b.String()), 0o644)
}

// mergeNotebookPages copies every content page of `from` into `into` as one new page
// titled after `from`'s display title, preserving the markdown verbatim, then refreshes
// `into`'s Appendix. A no-op when `from` has no content. Used by consolidation.
func mergeNotebookPages(mcpDir, from, into string) error {
	var b strings.Builder
	for _, p := range listPages(mcpDir, from) {
		if p.Num == appendixNum {
			continue
		}
		b.WriteString(strings.TrimRight(p.Body, "\n"))
		b.WriteString("\n\n")
	}
	content := strings.TrimSpace(b.String())
	if content == "" {
		return nil
	}
	title := loadNotebook(mcpDir, from).Title
	dir := notesDirFor(mcpDir, into)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	num := nextPageNum(listPages(mcpDir, into))
	body := "# " + sanitizePageTitle(title) + "\n\n" + content + "\n"
	if err := os.WriteFile(filepath.Join(dir, pageFileName(num, title)), []byte(body), 0o644); err != nil {
		return err
	}
	return rebuildAppendix(mcpDir, into)
}

// seedOrchestratorNotebook makes mcp/orchestrator a viewable, data-only notebook: a
// manifest, an About page, and an Appendix — but deliberately no generated query
// server (that name belongs to the real orchestrator MCP). Idempotent: identity and
// the About page are only written when absent, and the Appendix is always refreshed.
func seedOrchestratorNotebook(mcpDir string) error {
	slug := orchestratorSlug
	if err := os.MkdirAll(notesDirFor(mcpDir, slug), 0o755); err != nil {
		return err
	}
	if !isNotebook(mcpDir, slug) {
		if err := saveNotebook(mcpDir, notebook{
			Slug:    slug,
			Title:   "Orchestrator",
			Summary: "How your notes are organized: subjects it tracks, notebooks it creates, and merges it makes.",
			Icon:    "workflow",
			Accent:  "mauve",
		}); err != nil {
			return err
		}
	}
	about := filepath.Join(notesDirFor(mcpDir, slug), pageFileName(1, "About"))
	if _, err := os.Stat(about); err != nil {
		body := "# About\n\nThe orchestrator sorts your notes into per-subject notebooks during " +
			"/ingest, proposes a new notebook when a subject keeps coming up, and can merge " +
			"overlapping subjects. Its filing activity is logged here.\n"
		if err := os.WriteFile(about, []byte(body), 0o644); err != nil {
			return err
		}
	}
	return rebuildAppendix(mcpDir, slug)
}

// titleFromSlug turns "taxes-2026" into "Taxes 2026" for a default display title.
func titleFromSlug(slug string) string {
	words := strings.FieldsFunc(slug, func(r rune) bool { return r == '-' || r == '_' })
	for i, w := range words {
		if w != "" {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	if len(words) == 0 {
		return slug
	}
	return strings.Join(words, " ")
}

// isNotebook reports whether a subject folder carries a manifest (so it should be
// shown to the user), as opposed to a bare capability server.
func isNotebook(mcpDir, slug string) bool {
	_, err := os.Stat(filepath.Join(mcpDir, slug, notebookManifest))
	return err == nil
}

// loadNotebook reads mcp/<slug>/notebook.json, filling sensible defaults (and a
// title derived from the slug) so a folder without a full manifest still reads
// cleanly. Missing file yields a zero-value manifest with the derived title.
func loadNotebook(mcpDir, slug string) notebook {
	nb := notebook{Slug: slug}
	if data, err := os.ReadFile(filepath.Join(mcpDir, slug, notebookManifest)); err == nil {
		_ = json.Unmarshal(data, &nb)
	}
	if nb.Slug == "" {
		nb.Slug = slug
	}
	if nb.Title == "" {
		nb.Title = titleFromSlug(nb.Slug)
	}
	return nb
}

// saveNotebook writes the manifest, stamping created_at once and updated_at every
// time, and defaulting the title from the slug. slug must already be validSlug.
func saveNotebook(mcpDir string, nb notebook) error {
	dir := filepath.Join(mcpDir, nb.Slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if nb.CreatedAt == "" {
		nb.CreatedAt = nowStamp()
	}
	nb.UpdatedAt = nowStamp()
	if nb.Title == "" {
		nb.Title = titleFromSlug(nb.Slug)
	}
	data, err := json.MarshalIndent(nb, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, notebookManifest), append(data, '\n'), 0o644)
}

// touchNotebook bumps a notebook's updated_at (creating the manifest if absent),
// used whenever its notes change so the index can sort by recency.
func touchNotebook(mcpDir, slug, summary string) error {
	nb := loadNotebook(mcpDir, slug)
	if nb.Summary == "" {
		nb.Summary = strings.TrimSpace(summary)
	}
	return saveNotebook(mcpDir, nb)
}

// loadCards reads mcp/<slug>/cards/*.json, skipping dismissed ones and defaulting
// each card's Source to the slug so the phone can always group by notebook.
func loadCards(mcpDir, slug string) []dashCard {
	entries, err := os.ReadDir(cardsDirFor(mcpDir, slug))
	if err != nil {
		return nil
	}
	var cards []dashCard
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(cardsDirFor(mcpDir, slug), e.Name()))
		if err != nil {
			continue
		}
		var c dashCard
		if json.Unmarshal(data, &c) != nil || c.ID == "" {
			continue
		}
		if c.Source == "" {
			c.Source = slug
		}
		cards = append(cards, c)
	}
	return cards
}

// listNotebookSlugs returns the slugs of every notebook folder under mcpDir (those
// carrying a notebook.json), skipping the library/output dirs.
func listNotebookSlugs(mcpDir string) []string {
	entries, err := os.ReadDir(mcpDir)
	if err != nil {
		return nil
	}
	var slugs []string
	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() || name == "mcpx" || name == "bin" {
			continue
		}
		if isNotebook(mcpDir, name) {
			slugs = append(slugs, name)
		}
	}
	return slugs
}

// migrateNotebooks brings an older root up to the current layout, idempotently:
//  1. fold each subject's legacy single-file notes (<slug>.md or notes.md) into the
//     notes/ page folder as "#1 (Notes).md", and refresh its "#0 (Appendix).md",
//  2. write a notebook.json for any subject folder missing one (a subject folder is
//     one that has notes — never the dog capability),
//  3. move the old global orchestrator/state/cards/*.json into their owning
//     notebook's cards/ dir (by the card's source; unowned ones go to "inbox").
func migrateNotebooks(mcpDir, stateDir string) {
	entries, _ := os.ReadDir(mcpDir)
	for _, e := range entries {
		slug := e.Name()
		if !e.IsDir() || slug == "mcpx" || slug == "bin" {
			continue
		}
		dir := filepath.Join(mcpDir, slug)

		// 1. Fold any legacy single-file notes into the notes/ page folder: the oldest
		// layout was <slug>.md, the interim one notes.md. Either becomes "#1 (Notes).md",
		// but only when notes/ isn't already present.
		notesDir := notesDirFor(mcpDir, slug)
		hadNotes := false
		if _, err := os.Stat(notesDir); err == nil {
			hadNotes = true
		} else {
			legacy := ""
			if _, err := os.Stat(filepath.Join(dir, legacyNotesFile)); err == nil {
				legacy = filepath.Join(dir, legacyNotesFile)
			} else if _, err := os.Stat(filepath.Join(dir, slug+".md")); err == nil {
				legacy = filepath.Join(dir, slug+".md")
			}
			if legacy != "" {
				body, _ := os.ReadFile(legacy)
				if os.MkdirAll(notesDir, 0o755) == nil &&
					os.WriteFile(filepath.Join(notesDir, pageFileName(1, "Notes")), body, 0o644) == nil {
					_ = os.Remove(legacy)
					hadNotes = true
				}
			}
		}

		// 2. Write a manifest for note-bearing folders that lack one. Folders with
		// no notes (a bare capability like dog) are intentionally left alone.
		if hadNotes && !isNotebook(mcpDir, slug) && validSlug(slug) {
			summary := ""
			if data, err := os.ReadFile(filepath.Join(dir, "capability.json")); err == nil {
				var c struct {
					Summary string `json:"summary"`
				}
				_ = json.Unmarshal(data, &c)
				summary = c.Summary
			}
			_ = saveNotebook(mcpDir, notebook{Slug: slug, Summary: summary})
		}

		// 3. Refresh the Appendix so a migrated (or already-folder) notebook always
		// carries its "#0 (Appendix).md" index.
		if hadNotes {
			_ = rebuildAppendix(mcpDir, slug)
		}
	}

	// 4. Drain the old global cards dir into each card's owning notebook.
	oldCards := filepath.Join(stateDir, cardsSubdir)
	cardEntries, err := os.ReadDir(oldCards)
	if err != nil {
		return
	}
	for _, ce := range cardEntries {
		if ce.IsDir() || !strings.HasSuffix(ce.Name(), ".json") {
			continue
		}
		src := filepath.Join(oldCards, ce.Name())
		data, err := os.ReadFile(src)
		if err != nil {
			continue
		}
		var c dashCard
		if json.Unmarshal(data, &c) != nil || c.ID == "" {
			_ = os.Remove(src)
			continue
		}
		slug := c.Source
		if !validSlug(slug) {
			slug = inboxSlug
		}
		if !isNotebook(mcpDir, slug) {
			_ = saveNotebook(mcpDir, notebook{Slug: slug, Summary: "Unfiled items."})
		}
		dest := cardsDirFor(mcpDir, slug)
		if os.MkdirAll(dest, 0o755) == nil {
			if os.WriteFile(filepath.Join(dest, c.ID+".json"), data, 0o644) == nil {
				_ = os.Remove(src)
			}
		}
	}
	_ = os.Remove(oldCards) // tidy the now-empty legacy dir (no-op if not empty)
}
