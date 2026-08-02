package dashboard

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nestnote/server/internal/build"
	"nestnote/server/internal/cron"
	"nestnote/server/internal/session"
	"nestnote/server/internal/store"
)

// These tests cover the seam between the dashboard and the build pipeline:
// dismissing a card on the dashboard is how an idea is deleted and how a built
// feature is rejected, and either one has to stop the build behind it. They live
// here rather than in the build package because the handler under test is
// /action — build cannot import dashboard, so this is the side the test belongs.
//
// The fixture writes build.json directly rather than through the build package's
// own (unexported) state writer: the on-disk file IS the contract between the two
// packages, so asserting against it is the point.

// Build statuses and the gate card's kind, as the dashboard sees them on disk.
const (
	statusScheduled = "scheduled"
	statusAwaiting  = "awaiting-validation"
	statusBuilding  = "building"
	statusHalted    = "halted"
	statusDone      = "done"
	buildCardKind   = "build-step"
)

// gateCardID mirrors how the build package names the card that gates feature n.
func gateCardID(slug string, n int) string {
	return fmt.Sprintf("build-%s-%d", slug, n)
}

// fakeCrontab stands in for the crontab binary so a test never touches a
// developer's real one.
type fakeCrontab struct {
	content string
	saves   int
}

func (f *fakeCrontab) io() cron.IO {
	return cron.IO{
		List: func() (string, error) { return f.content, nil },
		Save: func(c string) error { f.content = c; f.saves++; return nil },
	}
}

type buildFixture struct {
	cfg    build.Config
	root   string
	mcpDir string
	slug   string
	source string
	dir    string
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
		root: root, mcpDir: mcpDir, slug: slug, source: source, dir: projectDir,
		cfg: build.Config{
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

func (f *buildFixture) stateFile() string {
	return filepath.Join(f.cfg.ProjectsBase, f.slug, ".nestnote", "build.json")
}

func (f *buildFixture) writeState(t *testing.T, st build.State) {
	t.Helper()
	st.Slug = f.slug
	if st.CardID == "" {
		st.CardID = "idea-4f2a"
	}
	if st.Source == "" {
		st.Source = f.source
	}
	if err := os.MkdirAll(filepath.Dir(f.stateFile()), 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.stateFile(), append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (f *buildFixture) loadState(t *testing.T) (build.State, bool) {
	t.Helper()
	data, err := os.ReadFile(f.stateFile())
	if err != nil {
		return build.State{}, false
	}
	var st build.State
	if json.Unmarshal(data, &st) != nil {
		return build.State{}, false
	}
	return st, true
}

// marker is the trailing comment the cron package tags a managed line with.
func marker(slug string) string { return "# nestnote:" + slug }

// TestDismissingAnIdeaStopsItsBuild is the dashboard half of the cleanup:
// dismissing a card is how an idea is deleted, and an idea's build only ever
// existed to build that idea. The crontab line goes with it.
func TestDismissingAnIdeaStopsItsBuild(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	ct := &fakeCrontab{content: "0 9 * * * /usr/bin/backup  # mine\n"}
	f.cfg.Cron = ct.io()
	at := time.Now().Add(9 * time.Hour)
	if err := cron.InstallLine(ct.io(), f.slug, cron.ScheduledLines(f.root, f.slug, at)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, build.State{
		Status:     statusScheduled,
		StartAt:    at.UTC().Format(time.RFC3339),
		GateCardID: gateCardID(f.slug, 1),
	})
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{
		ID: gateCardID(f.slug, 1), Kind: buildCardKind, Title: "Validate: feature 1",
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/action?token="+token,
		strings.NewReader(`{"action":"dismiss","id":"idea-4f2a","source":"greenhouse"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	ActionHandler(token, f.root, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}

	if strings.Contains(ct.content, marker(f.slug)) {
		t.Fatalf("the deleted idea's build kept its crontab line:\n%s", ct.content)
	}
	if !strings.Contains(ct.content, "# mine") {
		t.Fatalf("the user's own line was eaten:\n%s", ct.content)
	}
	st, _ := f.loadState(t)
	if st.Status != statusHalted || st.Note == "" {
		t.Fatalf("state = %+v, want halted with a note saying why", st)
	}
	// And the card that was asking for a decision about it stops asking — without
	// leaving the dashboard, which is the user's own call to make.
	gate, ok := store.LoadCard(f.mcpDir, f.source, gateCardID(f.slug, 1))
	if !ok || gate.Dismissed {
		t.Fatalf("step card = %+v, want it kept on the dashboard", gate)
	}
	if !strings.Contains(gate.Body, "This build was stopped") {
		t.Fatalf("step card body = %q, want it to say the build stopped", gate.Body)
	}
	stamp, _ := gate.Payload["build"].(map[string]any)
	if stamp == nil || stamp["status"] != statusHalted {
		t.Fatalf("step card build stamp = %+v, want status halted", stamp)
	}
}

// TestRejectingAFeatureStopsTheBuildNow: dismissing a gate card is how the user
// rejects a built feature, and rejecting it stops the build. The tick reads the
// same field, but only when it next comes round — so if the dismissal itself
// doesn't stop the build, "stop" means "in up to half an hour", with the crontab
// line armed the whole time. This asserts the line is gone by the time the
// dashboard's request answers.
func TestRejectingAFeatureStopsTheBuildNow(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	ct := &fakeCrontab{content: "0 9 * * * /usr/bin/backup  # mine\n"}
	f.cfg.Cron = ct.io()
	if err := cron.InstallLine(ct.io(), f.slug, cron.LineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	gate := gateCardID(f.slug, 2)
	f.writeState(t, build.State{Status: statusAwaiting, Feature: 2, GateCardID: gate})
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{
		ID: gate, Kind: buildCardKind, Title: "Validate: feature 2",
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/action?token="+token,
		strings.NewReader(`{"action":"dismiss","id":"`+gate+`","source":"greenhouse"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	ActionHandler(token, f.root, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}

	if cron.HasLine(ct.content, f.slug) {
		t.Fatalf("a rejected feature left the build's crontab line armed:\n%s", ct.content)
	}
	if !strings.Contains(ct.content, "# mine") {
		t.Fatalf("the user's own line was eaten:\n%s", ct.content)
	}
	st, _ := f.loadState(t)
	if st.Status != statusHalted {
		t.Fatalf("status = %q, want halted", st.Status)
	}
	if !strings.Contains(st.Note, "feature 2") {
		t.Fatalf("note = %q, want it to say which feature was rejected", st.Note)
	}
}

// TestDismissingAGateCardOfAnEndedBuildChangesNothing: the gate card of a build
// that has already stopped is an ordinary dismissed card. Clearing it off the
// dashboard must not re-open the build's state or rewrite the crontab.
func TestDismissingAGateCardOfAnEndedBuildChangesNothing(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	gate := gateCardID(f.slug, 1)
	f.writeState(t, build.State{Status: statusDone, Feature: 1, GateCardID: gate})
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{
		ID: gate, Kind: buildCardKind, Title: "Validate: feature 1",
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/action?token="+token,
		strings.NewReader(`{"action":"dismiss","id":"`+gate+`","source":"greenhouse"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	ActionHandler(token, f.root, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if st, _ := f.loadState(t); st.Status != statusDone {
		t.Fatalf("status = %q, want the finished build left alone", st.Status)
	}
	if ct.saves != 0 {
		t.Fatalf("the crontab was rewritten %d times for a build that had already ended", ct.saves)
	}
}

// TestDismissingAnotherCardLeavesTheBuildAlone: every dismissal on the dashboard
// runs the sweep, so the match has to be exact. A neighbouring card in the same
// notebook must not take a build down with it.
func TestDismissingAnotherCardLeavesTheBuildAlone(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	if err := cron.InstallLine(ct.io(), f.slug, cron.LineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, build.State{Status: statusBuilding, Feature: 1})
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{
		ID: "idea-9c11", Kind: "idea", Title: "Something else entirely",
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/action?token="+token,
		strings.NewReader(`{"action":"dismiss","id":"idea-9c11","source":"greenhouse"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	ActionHandler(token, f.root, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if !strings.Contains(ct.content, marker(f.slug)) {
		t.Fatalf("dismissing an unrelated card stopped a live build:\n%s", ct.content)
	}
	if st, _ := f.loadState(t); st.Status != statusBuilding {
		t.Fatalf("status = %q, want it still building", st.Status)
	}
}
