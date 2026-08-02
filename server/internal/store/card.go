package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Card mirrors the flat card record the orchestrator writes under
// mcp/<slug>/cards/<id>.json. The backend stays kind-agnostic: it reads, filters out
// dismissed cards, and hands the rest to the UI, which sorts and renders them
// (including a generic fallback for kinds it doesn't recognize). Priority and date
// are surfaced verbatim so the UI can build a stable sort key.
//
// This type lives in store rather than with the dashboard because it is the shared
// currency between two features that must not import each other: the dashboard
// renders cards, and the build pipeline writes them (idea cards, gate cards).
type Card struct {
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

// LoadCard reads one card by id from a known notebook.
func LoadCard(mcpDir, source, id string) (Card, bool) {
	data, err := os.ReadFile(filepath.Join(CardsDirFor(mcpDir, source), id+".json"))
	if err != nil {
		return Card{}, false
	}
	var c Card
	if json.Unmarshal(data, &c) != nil || c.ID == "" {
		return Card{}, false
	}
	return c, true
}

// LoadCards reads mcp/<slug>/cards/*.json, defaulting each card's Source to the slug
// so the phone can always group by notebook. Dismissed cards are included; callers
// that show a live list filter them out.
func LoadCards(mcpDir, slug string) []Card {
	entries, err := os.ReadDir(CardsDirFor(mcpDir, slug))
	if err != nil {
		return nil
	}
	var cards []Card
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(CardsDirFor(mcpDir, slug), e.Name()))
		if err != nil {
			continue
		}
		var c Card
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

// WriteCard writes one card under mcp/<source>/cards/<id>.json, preserving the
// original created_at if the card already exists. Same shape and permissions the
// orchestrator's upsert_card uses, so the dashboard can't tell the difference.
func WriteCard(mcpDir, source string, c Card) error {
	dir := CardsDirFor(mcpDir, source)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if existing, ok := LoadCard(mcpDir, source, c.ID); ok && existing.CreatedAt != "" {
		c.CreatedAt = existing.CreatedAt
	}
	if c.CreatedAt == "" {
		c.CreatedAt = NowStamp()
	}
	c.UpdatedAt = NowStamp()
	c.Source = source
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, c.ID+".json"), append(data, '\n'), 0o644)
}

// UpdateCard finds mcp/<slug>/cards/<id>.json, applies mutate, bumps updated_at, and
// writes it back. `hint` (the card's source notebook, when the caller knows it) is
// tried first; otherwise every notebook is searched. Reports the notebook slug the
// card was actually found under, and false when the card is missing so the caller
// can 404. id and hint must already be ValidSlug-checked.
func UpdateCard(mcpDir, hint, id string, mutate func(*Card)) (slug string, ok bool) {
	try := func(s string) bool {
		path := filepath.Join(CardsDirFor(mcpDir, s), id+".json")
		data, err := os.ReadFile(path)
		if err != nil {
			return false
		}
		var c Card
		if json.Unmarshal(data, &c) != nil {
			return false
		}
		mutate(&c)
		c.UpdatedAt = NowStamp()
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
	if ValidSlug(hint) && try(hint) {
		return slug, true
	}
	for _, s := range ListNotebookSlugs(mcpDir) {
		if s == hint {
			continue
		}
		if try(s) {
			return slug, true
		}
	}
	return "", false
}
