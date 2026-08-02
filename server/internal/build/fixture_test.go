package build

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nestnote/server/internal/cron"
	"nestnote/server/internal/session"
	"nestnote/server/internal/store"
)

// fakeCrontab stands in for the crontab binary so a build test never touches a
// developer's real one.
type fakeCrontab struct {
	content string
	saves   int
	listErr error
	saveErr error
}

func (f *fakeCrontab) io() cron.IO {
	return cron.IO{
		List: func() (string, error) { return f.content, f.listErr },
		Save: func(c string) error {
			if f.saveErr != nil {
				return f.saveErr
			}
			f.content = c
			f.saves++
			return nil
		},
	}
}

// marker is the trailing comment the cron package tags a managed line with. The
// build tests assert on it directly — including counting the two lines a
// scheduled build installs — so it is restated here rather than exported.
func marker(slug string) string { return "# nestnote:" + slug }

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// buildFixture is a root with one notebook, one idea card, and one project whose
// build state the test sets up as it likes.
type buildFixture struct {
	cfg    Config
	root   string
	mcpDir string
	slug   string
	source string
	dir    string // the project dir
}

func newBuildFixture(t *testing.T) *buildFixture {
	t.Helper()
	root := t.TempDir()
	mcpDir := filepath.Join(root, "mcp")
	source, slug := "greenhouse", "greenhouse-tracker"
	if err := os.MkdirAll(store.CardsDirFor(mcpDir, source), 0o755); err != nil {
		t.Fatal(err)
	}
	projectDir := filepath.Join(root, "projects", slug)
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	f := &buildFixture{
		root:   root,
		mcpDir: mcpDir,
		slug:   slug,
		source: source,
		dir:    projectDir,
		cfg: Config{
			ProjectsBase: filepath.Join(root, "projects"),
			Root:         root,
			StateDir:     t.TempDir(),
			ListenAddr:   "127.0.0.1:8443",
			RunTimeout:   30 * time.Second,
			Enabled:      true,
			Reg:          session.NewRegistry(),
			Cron:         (&fakeCrontab{}).io(),
		},
	}
	if err := store.WriteCard(mcpDir, source, store.Card{
		ID:    "idea-4f2a",
		Kind:  "idea",
		Title: "Greenhouse tracker",
		Body:  "## Problem\nThe greenhouse is a mystery.\n",
	}); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *buildFixture) writePlan(t *testing.T, plan string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(f.dir, planName), []byte(plan), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (f *buildFixture) writeState(t *testing.T, st State) {
	t.Helper()
	st.Slug, st.Source = f.slug, f.source
	if st.CardID == "" {
		st.CardID = "idea-4f2a"
	}
	if err := saveState(f.cfg.buildDir(f.slug), st); err != nil {
		t.Fatal(err)
	}
}

// ---------------------------------------------------------------------------
// Revising a step
// ---------------------------------------------------------------------------

// stubClaude stands a `claude` on PATH that writes one stream-json line and exits,
// so a test can drive a real run to completion without an agent (or a network).
func stubClaude(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	script := "#!/bin/sh\nprintf '{\"type\":\"stub\"}\\n'\n"
	if err := os.WriteFile(filepath.Join(dir, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func (f *buildFixture) reviseReq(t *testing.T, token, note string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{"slug": f.slug, "note": note})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/build/revise", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	ReviseHandler(token, f.cfg).ServeHTTP(rec, req)
	return rec
}

// ---------------------------------------------------------------------------
// The idea moves onto the build
// ---------------------------------------------------------------------------

// stepPayload pulls payload.step off a card, through the JSON round trip a real
// card takes (so `feature` arrives as a float64, exactly as the phone sees it).
func stepPayload(t *testing.T, c store.Card) map[string]any {
	t.Helper()
	raw, ok := c.Payload["step"].(map[string]any)
	if !ok {
		t.Fatalf("card %s carries no step payload: %#v", c.ID, c.Payload)
	}
	return raw
}
