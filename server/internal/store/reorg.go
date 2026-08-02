package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// ReorgPage is one proposed content page in a reorg proposal: a title and the full
// markdown body it should hold. It mirrors the JSON the orchestrator's propose_reorg
// tool writes under state/reorgs/<subject>.json.
type ReorgPage struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

// ReorgProposal is the on-disk shape of state/reorgs/<subject>.json: the target subject,
// a one-line summary, and the full intended set of content pages.
type ReorgProposal struct {
	Subject string      `json:"subject"`
	Summary string      `json:"summary"`
	Pages   []ReorgPage `json:"pages"`
}

// LoadReorg reads a notebook's pending reorg proposal, if any.
func LoadReorg(stateDir, subject string) (ReorgProposal, bool) {
	data, err := os.ReadFile(filepath.Join(stateDir, "reorgs", subject+".json"))
	if err != nil {
		return ReorgProposal{}, false
	}
	var p ReorgProposal
	if json.Unmarshal(data, &p) != nil {
		return ReorgProposal{}, false
	}
	if p.Subject == "" {
		p.Subject = subject
	}
	return p, true
}

// ListReorgSubjects returns the subject slug of every pending proposal under
// stateDir/reorgs, sorted, so callers can load them without knowing the layout.
func ListReorgSubjects(stateDir string) []string {
	entries, err := os.ReadDir(filepath.Join(stateDir, "reorgs"))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		out = append(out, strings.TrimSuffix(e.Name(), ".json"))
	}
	return out
}

// ContentPageCount counts a notebook's content pages, excluding the Appendix and every
// Task Log page — the pages a reorg actually replaces.
func ContentPageCount(mcpDir, slug string) int {
	n := 0
	for _, p := range ListPages(mcpDir, slug) {
		if p.Num == AppendixNum {
			continue
		}
		if _, isLog := TaskLogSeq(p.Title); isLog {
			continue
		}
		n++
	}
	return n
}

// ApplyReorg replaces a notebook's content pages with the proposed set `pages`, in the
// given order (numbered #1..#N), while preserving every Task Log page — a live database
// of dismissed tasks — untouched and keeping them as the notebook's last pages. Any
// proposed page whose title is a Task Log title is skipped: Task Log content only ever
// comes from the dismissal path, never a reorg. Rebuilds the Appendix and bumps
// updated_at. slug must already be ValidSlug.
func ApplyReorg(mcpDir, slug string, pages []ReorgPage) error {
	dir := NotesDirFor(mcpDir, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// Drop every current content page file, but keep the Appendix (#0) and every Task
	// Log page exactly as they are on disk.
	for _, p := range ListPages(mcpDir, slug) {
		if p.Num == AppendixNum {
			continue
		}
		if _, isLog := TaskLogSeq(p.Title); isLog {
			continue
		}
		if err := os.Remove(filepath.Join(dir, p.File)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	// Write the proposed pages as #1..#N. A Task Log title in the proposal is skipped so
	// a reorg can never author a fake log page (proposeReorg already strips these; this
	// is the server-side guarantee).
	num := 1
	for _, pg := range pages {
		title := SanitizePageTitle(pg.Title)
		if _, isLog := TaskLogSeq(title); isLog {
			continue
		}
		body := pg.Body
		if !strings.HasSuffix(body, "\n") {
			body += "\n"
		}
		if err := os.WriteFile(filepath.Join(dir, PageFileName(num, title)), []byte(body), 0o644); err != nil {
			return err
		}
		num++
	}
	// Slide the preserved Task Log pages to sit after the new content pages, in order.
	if err := pushTaskLogPagesAfter(mcpDir, slug, num-1, ListPages(mcpDir, slug)); err != nil {
		return err
	}
	if err := RebuildAppendix(mcpDir, slug); err != nil {
		return err
	}
	return TouchNotebook(mcpDir, slug, "")
}
