// Package store is the on-disk data model: notebooks, their markdown pages, the
// cards attached to them, and pending reorg proposals. Everything here is plain
// filesystem and JSON — no HTTP, no processes, no other server package. It is
// the bottom of the dependency stack, which is also what lets the build pipeline
// and the dashboard both work with cards without importing each other.
//
// The on-disk contract for a notebook — one subject folder under mcp/. A notebook
// is fully viewable from these files alone; the MCP binary (main.go + capability.json)
// is a separate, lazily-built *query* layer Claude uses during /ask.
//
//	mcp/<slug>/
//	  notebook.json   manifest: the notebook's identity + appearance
//	  notes/          ordered markdown pages: "#N (Title).md" (see page.go)
//	  cards/<id>.json this notebook's tasks / ideas (see card.go)
//	  capability.json MCP tool manifest (query layer)
//	  main.go         the fact-store MCP server (query layer)
//
// A folder is a *notebook* precisely when it has a notebook.json; a pure capability
// server (e.g. the dog demo) has none and is not shown to the user as a notebook.
package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	NotebookManifest = "notebook.json"
	notesSubdir      = "notes"
	legacyNotesFile  = "notes.md" // pre-folder single-file layout, migrated away
	cardsSubdir      = "cards"
	InboxSlug        = "inbox"
	// OrchestratorSlug is a reserved notebook: viewable (data-only), but never a
	// generated query server — that name belongs to the real orchestrator MCP.
	OrchestratorSlug = "orchestrator"
)

// Notebook is the viewable identity of a subject folder, kept separate from
// capability.json (which describes MCP tools). Icon/Accent are optional hints the
// phone maps to a Lucide glyph and a Catppuccin hue.
type Notebook struct {
	Slug      string `json:"slug"`
	Title     string `json:"title"`
	Summary   string `json:"summary"`
	Icon      string `json:"icon,omitempty"`
	Accent    string `json:"accent,omitempty"`
	Pinned    bool   `json:"pinned"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// NowStamp is the timestamp format every record in this package is stamped with.
func NowStamp() string { return time.Now().UTC().Format(time.RFC3339) }

// RootDirs derives the mcp and orchestrator-state directories from -root,
// matching the layout the scaffold lays down. Every feature that reads notebooks
// starts here, so the layout is stated once.
func RootDirs(root string) (mcpDir, stateDir string) {
	return filepath.Join(root, "mcp"), filepath.Join(root, "orchestrator", "state")
}

func NotesDirFor(mcpDir, slug string) string { return filepath.Join(mcpDir, slug, notesSubdir) }

func CardsDirFor(mcpDir, slug string) string {
	return filepath.Join(mcpDir, slug, cardsSubdir)
}

// ValidSlug reports whether s is safe to use as a notebook folder name. It keeps
// a slug from escaping the mcp dir via path characters, from colliding with the
// library/output dirs, or from shadowing the data-only "orchestrator" notebook
// (whose name belongs to the real orchestrator MCP).
func ValidSlug(s string) bool {
	if s == "" || s == "mcpx" || s == "bin" || s == OrchestratorSlug {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// TitleFromSlug turns "taxes-2026" into "Taxes 2026" for a default display title.
func TitleFromSlug(slug string) string {
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

// IsNotebook reports whether a subject folder carries a manifest (so it should be
// shown to the user), as opposed to a bare capability server.
func IsNotebook(mcpDir, slug string) bool {
	_, err := os.Stat(filepath.Join(mcpDir, slug, NotebookManifest))
	return err == nil
}

// LoadNotebook reads mcp/<slug>/notebook.json, filling sensible defaults (and a
// title derived from the slug) so a folder without a full manifest still reads
// cleanly. Missing file yields a zero-value manifest with the derived title.
func LoadNotebook(mcpDir, slug string) Notebook {
	nb := Notebook{Slug: slug}
	if data, err := os.ReadFile(filepath.Join(mcpDir, slug, NotebookManifest)); err == nil {
		_ = json.Unmarshal(data, &nb)
	}
	if nb.Slug == "" {
		nb.Slug = slug
	}
	if nb.Title == "" {
		nb.Title = TitleFromSlug(nb.Slug)
	}
	return nb
}

// SaveNotebook writes the manifest, stamping created_at once and updated_at every
// time, and defaulting the title from the slug. slug must already be ValidSlug.
func SaveNotebook(mcpDir string, nb Notebook) error {
	dir := filepath.Join(mcpDir, nb.Slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if nb.CreatedAt == "" {
		nb.CreatedAt = NowStamp()
	}
	nb.UpdatedAt = NowStamp()
	if nb.Title == "" {
		nb.Title = TitleFromSlug(nb.Slug)
	}
	data, err := json.MarshalIndent(nb, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, NotebookManifest), append(data, '\n'), 0o644)
}

// TouchNotebook bumps a notebook's updated_at (creating the manifest if absent),
// used whenever its notes change so the index can sort by recency.
func TouchNotebook(mcpDir, slug, summary string) error {
	nb := LoadNotebook(mcpDir, slug)
	if nb.Summary == "" {
		nb.Summary = strings.TrimSpace(summary)
	}
	return SaveNotebook(mcpDir, nb)
}

// ListNotebookSlugs returns the slugs of every notebook folder under mcpDir (those
// carrying a notebook.json), skipping the library/output dirs.
func ListNotebookSlugs(mcpDir string) []string {
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
		if IsNotebook(mcpDir, name) {
			slugs = append(slugs, name)
		}
	}
	return slugs
}

// SeedOrchestratorNotebook makes mcp/orchestrator a viewable, data-only notebook: a
// manifest, an About page, and an Appendix — but deliberately no generated query
// server (that name belongs to the real orchestrator MCP). Idempotent: identity and
// the About page are only written when absent, and the Appendix is always refreshed.
func SeedOrchestratorNotebook(mcpDir string) error {
	slug := OrchestratorSlug
	if err := os.MkdirAll(NotesDirFor(mcpDir, slug), 0o755); err != nil {
		return err
	}
	if !IsNotebook(mcpDir, slug) {
		if err := SaveNotebook(mcpDir, Notebook{
			Slug:    slug,
			Title:   "Orchestrator",
			Summary: "How your notes are organized: subjects it tracks, notebooks it creates, and merges it makes.",
			Icon:    "workflow",
			Accent:  "mauve",
		}); err != nil {
			return err
		}
	}
	about := filepath.Join(NotesDirFor(mcpDir, slug), PageFileName(1, "About"))
	if _, err := os.Stat(about); err != nil {
		body := "# About\n\nThe orchestrator sorts your notes into per-subject notebooks during " +
			"/ingest, proposes a new notebook when a subject keeps coming up, and can merge " +
			"overlapping subjects. Its filing activity is logged here.\n"
		if err := os.WriteFile(about, []byte(body), 0o644); err != nil {
			return err
		}
	}
	return RebuildAppendix(mcpDir, slug)
}

// Migrate brings an older root up to the current layout, idempotently:
//  1. fold each subject's legacy single-file notes (<slug>.md or notes.md) into the
//     notes/ page folder as "#1 (Notes).md", and refresh its "#0 (Appendix).md",
//  2. write a notebook.json for any subject folder missing one (a subject folder is
//     one that has notes — never the dog capability),
//  3. move the old global orchestrator/state/cards/*.json into their owning
//     notebook's cards/ dir (by the card's source; unowned ones go to "inbox").
func Migrate(mcpDir, stateDir string) {
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
		notesDir := NotesDirFor(mcpDir, slug)
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
					os.WriteFile(filepath.Join(notesDir, PageFileName(1, "Notes")), body, 0o644) == nil {
					_ = os.Remove(legacy)
					hadNotes = true
				}
			}
		}

		// 2. Write a manifest for note-bearing folders that lack one. Folders with
		// no notes (a bare capability like dog) are intentionally left alone.
		if hadNotes && !IsNotebook(mcpDir, slug) && ValidSlug(slug) {
			summary := ""
			if data, err := os.ReadFile(filepath.Join(dir, "capability.json")); err == nil {
				var c struct {
					Summary string `json:"summary"`
				}
				_ = json.Unmarshal(data, &c)
				summary = c.Summary
			}
			_ = SaveNotebook(mcpDir, Notebook{Slug: slug, Summary: summary})
		}

		// 3. Refresh the Appendix so a migrated (or already-folder) notebook always
		// carries its "#0 (Appendix).md" index.
		if hadNotes {
			_ = RebuildAppendix(mcpDir, slug)
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
		var c Card
		if json.Unmarshal(data, &c) != nil || c.ID == "" {
			_ = os.Remove(src)
			continue
		}
		slug := c.Source
		if !ValidSlug(slug) {
			slug = InboxSlug
		}
		if !IsNotebook(mcpDir, slug) {
			_ = SaveNotebook(mcpDir, Notebook{Slug: slug, Summary: "Unfiled items."})
		}
		dest := CardsDirFor(mcpDir, slug)
		if os.MkdirAll(dest, 0o755) == nil {
			if os.WriteFile(filepath.Join(dest, c.ID+".json"), data, 0o644) == nil {
				_ = os.Remove(src)
			}
		}
	}
	_ = os.Remove(oldCards) // tidy the now-empty legacy dir (no-op if not empty)
}
