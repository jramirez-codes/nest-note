package main

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
)

// ---------------------------------------------------------------------------
// .gitignore re-assertion
// ---------------------------------------------------------------------------

// TestEnsureGitignore is the table for the rule that keeps .nestnote/ out of the
// user's repo. It runs on EVERY tick against a file the feature agent is free to
// rewrite, so each row here is a real thing that happens to a live project — most
// of all the framework-generator row, which is why seeding once is not enough.
func TestEnsureGitignore(t *testing.T) {
	cases := []struct {
		name    string
		before  string // "" with exists=false means no .gitignore at all
		exists  bool
		wantHas bool
		keep    []string // substrings that must survive byte-for-byte
	}{
		{name: "no gitignore at all", exists: false, wantHas: true},
		{
			name:    "already contains the rule",
			before:  "node_modules/\n.nestnote/\ndist/\n",
			exists:  true,
			wantHas: true,
			keep:    []string{"node_modules/", "dist/"},
		},
		{
			name:    "unrelated rules survive",
			before:  "*.log\n/build\n",
			exists:  true,
			wantHas: true,
			keep:    []string{"*.log", "/build"},
		},
		{
			name:    "replaced by a framework generator",
			before:  "# Created by create-next-app\n/node_modules\n/.next/\n",
			exists:  true,
			wantHas: true,
			keep:    []string{"/.next/", "/node_modules"},
		},
		{
			name:    "near miss: no trailing slash",
			before:  ".nestnote\n",
			exists:  true,
			wantHas: true,
			keep:    []string{".nestnote\n"},
		},
		{
			name:    "near miss: commented out",
			before:  "#.nestnote/\n",
			exists:  true,
			wantHas: true,
			keep:    []string{"#.nestnote/"},
		},
		{
			name:    "no trailing newline on the last line",
			before:  "*.tmp",
			exists:  true,
			wantHas: true,
			keep:    []string{"*.tmp\n"}, // must be terminated, not glued to our rule
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, ".gitignore")
			if tc.exists {
				if err := os.WriteFile(path, []byte(tc.before), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if err := ensureGitignore(dir); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if gitignoreHasRule(string(got)) != tc.wantHas {
				t.Fatalf("rule present = %v, want %v.\n%s", !tc.wantHas, tc.wantHas, got)
			}
			for _, keep := range tc.keep {
				if !strings.Contains(string(got), keep) {
					t.Fatalf("lost %q from the original file:\n%s", keep, got)
				}
			}
		})
	}
}

// TestEnsureGitignoreTwiceAppendsOnce: the re-assertion runs on every tick, so a
// build that ticks a hundred times must not leave a hundred copies of the rule.
func TestEnsureGitignoreTwiceAppendsOnce(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 3; i++ {
		if err := ensureGitignore(dir); err != nil {
			t.Fatal(err)
		}
	}
	body, err := os.ReadFile(filepath.Join(dir, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(body), gitignoreRule); n != 1 {
		t.Fatalf("rule appears %d times, want 1:\n%s", n, body)
	}
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

// TestParsePlanFeatures: the "## Feature N" headings are load-bearing — every run
// is addressed by that number — so parsing has to survive the punctuation an agent
// might reasonably write, and must not mistake other headings for features.
func TestParsePlanFeatures(t *testing.T) {
	plan := strings.Join([]string{
		"# Greenhouse Tracker",
		"",
		"A thing for tracking a greenhouse.",
		"",
		"## Feature 1: Running skeleton",
		"Stand up a server that serves one page.",
		"- done when: `npm start` shows the page",
		"",
		"## Feature 2 — Sensor ingest",
		"Take readings over HTTP.",
		"",
		"## Notes",
		"Not a feature.",
		"",
		"## Feature 3",
		"Untitled but numbered.",
	}, "\n")

	feats := parsePlanFeatures(plan)
	if len(feats) != 3 {
		t.Fatalf("parsed %d features, want 3: %+v", len(feats), feats)
	}
	if feats[0].Num != 1 || feats[0].Title != "Running skeleton" {
		t.Fatalf("feature 1 = %+v", feats[0])
	}
	if feats[1].Num != 2 || feats[1].Title != "Sensor ingest" {
		t.Fatalf("feature 2 = %+v", feats[1])
	}
	if feats[2].Num != 3 || feats[2].Title != "Feature 3" {
		t.Fatalf("feature 3 = %+v", feats[2])
	}
	// The "## Notes" section belongs to no feature, so it must not have been
	// swept into feature 2's body.
	if strings.Contains(feats[1].Body, "Not a feature") {
		t.Fatalf("a non-feature heading leaked into feature 2's body: %q", feats[1].Body)
	}
	if !strings.Contains(feats[0].Body, "npm start") {
		t.Fatalf("feature 1 lost its body: %q", feats[0].Body)
	}
}

// TestReadPlanStatuses: the progress toggle reads these, so "what has been built"
// has to follow from the build state alone — below the current feature is done,
// the current one carries the build's status, above it is pending.
func TestReadPlanStatuses(t *testing.T) {
	dir := t.TempDir()
	plan := "## Feature 1: A\nx\n\n## Feature 2: B\ny\n\n## Feature 3: C\nz\n"
	if err := os.WriteFile(filepath.Join(dir, buildPlanName), []byte(plan), 0o644); err != nil {
		t.Fatal(err)
	}
	feats := readPlan(dir, buildState{Feature: 2, Status: buildAwaiting})
	want := []string{buildDone, buildAwaiting, "pending"}
	for i, w := range want {
		if feats[i].Status != w {
			t.Fatalf("feature %d status = %q, want %q", i+1, feats[i].Status, w)
		}
	}
	// A finished build has validated everything, last feature included.
	for i, f := range readPlan(dir, buildState{Feature: 3, Status: buildDone}) {
		if f.Status != buildDone {
			t.Fatalf("finished build: feature %d = %q, want done", i+1, f.Status)
		}
	}
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// buildFixture is a root with one notebook, one idea card, and one project whose
// build state the test sets up as it likes.
type buildFixture struct {
	cfg    buildConfig
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
	if err := os.MkdirAll(cardsDirFor(mcpDir, source), 0o755); err != nil {
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
		cfg: buildConfig{
			projectsBase: filepath.Join(root, "projects"),
			root:         root,
			stateDir:     t.TempDir(),
			listenAddr:   "127.0.0.1:8443",
			runTimeout:   30 * time.Second,
			enabled:      true,
			reg:          &sessionRegistry{m: map[string]*session{}},
			cron:         (&fakeCrontab{}).io(),
		},
	}
	if err := writeCard(mcpDir, source, dashCard{
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
	if err := os.WriteFile(filepath.Join(f.dir, buildPlanName), []byte(plan), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (f *buildFixture) writeState(t *testing.T, st buildState) {
	t.Helper()
	st.Slug, st.Source = f.slug, f.source
	if st.CardID == "" {
		st.CardID = "idea-4f2a"
	}
	if err := saveBuild(f.cfg.buildDir(f.slug), st); err != nil {
		t.Fatal(err)
	}
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

// TestTickGatePoll is the heart of the design: the approve/reject loop rides the
// dashboard's existing complete/dismiss verbs on an ordinary card, so this asserts
// the driver reads exactly those two fields and nothing else.
func TestTickGatePoll(t *testing.T) {
	cases := []struct {
		name       string
		done       bool
		dismissed  bool
		deleteCard bool
		wantAction string
	}{
		{name: "untouched: nothing happens", wantAction: "wait"},
		{name: "completed: build the next feature", done: true, wantAction: "feature"},
		{name: "dismissed: stop the build", dismissed: true, wantAction: "halt"},
		{name: "card deleted: stop the build", deleteCard: true, wantAction: "halt"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newBuildFixture(t)
			f.writePlan(t, "## Feature 1: A\nx\n\n## Feature 2: B\ny\n")
			gate := gateCardID(f.slug, 1)
			f.writeState(t, buildState{Status: buildAwaiting, Feature: 1, GateCardID: gate})
			if !tc.deleteCard {
				if err := writeCard(f.mcpDir, f.source, dashCard{
					ID:        gate,
					Kind:      buildCardKind,
					Title:     "Validate: A",
					Done:      tc.done,
					Dismissed: tc.dismissed,
				}); err != nil {
					t.Fatal(err)
				}
			}

			// Dry run: assert the decision without starting an agent.
			res, err := f.cfg.tick(f.slug, true)
			if err != nil {
				t.Fatal(err)
			}
			if res.Action != tc.wantAction {
				t.Fatalf("action = %q (%s), want %q", res.Action, res.Detail, tc.wantAction)
			}
			if tc.wantAction == "feature" {
				if res.Feature != 2 {
					t.Fatalf("completing feature 1 should queue feature 2, got %d", res.Feature)
				}
				if !strings.Contains(res.Prompt, "Feature 2") {
					t.Fatalf("dry run should report the prompt it would send, got %q", res.Prompt)
				}
			}
		})
	}
}

// TestTickDryRunChangesNothing: the escape hatch is only useful if it is safe to
// point at a live build. Nothing may move — not the state file, not the gate card.
func TestTickDryRunChangesNothing(t *testing.T) {
	f := newBuildFixture(t)
	f.writePlan(t, "## Feature 1: A\nx\n\n## Feature 2: B\ny\n")
	gate := gateCardID(f.slug, 1)
	f.writeState(t, buildState{Status: buildAwaiting, Feature: 1, GateCardID: gate})
	if err := writeCard(f.mcpDir, f.source, dashCard{ID: gate, Kind: buildCardKind, Title: "Validate", Done: true}); err != nil {
		t.Fatal(err)
	}

	before, _ := loadBuild(f.cfg.buildDir(f.slug))
	if _, err := f.cfg.tick(f.slug, true); err != nil {
		t.Fatal(err)
	}
	after, _ := loadBuild(f.cfg.buildDir(f.slug))
	if before != after {
		t.Fatalf("dry run mutated the build state:\n before %+v\n after  %+v", before, after)
	}
	if card, _ := loadCard(f.mcpDir, f.source, gate); card.Dismissed {
		t.Fatal("dry run retired the gate card")
	}
}

// TestTickHaltsOnRejection: dismissing the gate card stops the build for good —
// status halted, and the crontab line gone, so nothing keeps firing at a project
// the user has said no to.
func TestTickHaltsOnRejection(t *testing.T) {
	f := newBuildFixture(t)
	cron := &fakeCrontab{}
	f.cfg.cron = cron.io()
	if err := installCronLine(cron.io(), f.slug, cronLineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	f.writePlan(t, "## Feature 1: A\nx\n\n## Feature 2: B\ny\n")
	gate := gateCardID(f.slug, 1)
	f.writeState(t, buildState{Status: buildAwaiting, Feature: 1, GateCardID: gate})
	if err := writeCard(f.mcpDir, f.source, dashCard{ID: gate, Kind: buildCardKind, Title: "Validate", Dismissed: true}); err != nil {
		t.Fatal(err)
	}

	if _, err := f.cfg.tick(f.slug, false); err != nil {
		t.Fatal(err)
	}
	st, _ := loadBuild(f.cfg.buildDir(f.slug))
	if st.Status != buildHalted {
		t.Fatalf("status = %q, want halted", st.Status)
	}
	if strings.Contains(cron.content, cronMarker(f.slug)) {
		t.Fatalf("halted build kept its crontab line:\n%s", cron.content)
	}
	// The idea page's lock is derived from the card, so halting has to clear it
	// there too or the user can never talk about the idea again.
	idea, ok := loadCard(f.mcpDir, f.source, "idea-4f2a")
	if !ok {
		t.Fatal("idea card vanished")
	}
	stamp, _ := idea.Payload["build"].(map[string]any)
	if stamp == nil || stamp["status"] != buildHalted {
		t.Fatalf("idea card build stamp = %+v, want status halted", stamp)
	}
}

// TestTickFinishesWhenThePlanRunsOut: validating the last feature ends the build
// rather than looping on a feature the plan doesn't have.
func TestTickFinishesWhenThePlanRunsOut(t *testing.T) {
	f := newBuildFixture(t)
	cron := &fakeCrontab{}
	f.cfg.cron = cron.io()
	if err := installCronLine(cron.io(), f.slug, cronLineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	f.writePlan(t, "## Feature 1: Only one\nx\n")
	gate := gateCardID(f.slug, 1)
	f.writeState(t, buildState{Status: buildAwaiting, Feature: 1, GateCardID: gate})
	if err := writeCard(f.mcpDir, f.source, dashCard{ID: gate, Kind: buildCardKind, Title: "Validate", Done: true}); err != nil {
		t.Fatal(err)
	}

	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "finished" {
		t.Fatalf("action = %q (%s), want finished", res.Action, res.Detail)
	}
	st, _ := loadBuild(f.cfg.buildDir(f.slug))
	if st.Status != buildDone {
		t.Fatalf("status = %q, want done", st.Status)
	}
	if strings.Contains(cron.content, cronMarker(f.slug)) {
		t.Fatalf("finished build kept its crontab line:\n%s", cron.content)
	}
	if card, _ := loadCard(f.mcpDir, f.source, gate); !card.Dismissed {
		t.Fatal("the spent gate card is still on the dashboard")
	}
}

// TestTickRefusesASecondRun: a feature that takes longer than the tick interval
// must never get a second agent in the same directory. The session registry is
// the concurrency primitive — one live session per build step.
func TestTickRefusesASecondRun(t *testing.T) {
	f := newBuildFixture(t)
	f.writePlan(t, "## Feature 1: A\nx\n")
	f.writeState(t, buildState{Status: buildBuilding, Feature: 1, GateCardID: gateCardID(f.slug, 1)})

	// Stand in for a run in flight: a registered session whose process hasn't
	// exited. This is exactly what startFeature leaves behind.
	f.cfg.reg.findOrCreateForRun(buildSessionID(f.slug, 1), sessionKindBuild)

	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "busy" {
		t.Fatalf("action = %q (%s), want busy", res.Action, res.Detail)
	}
	if st, _ := loadBuild(f.cfg.buildDir(f.slug)); st.Status != buildBuilding {
		t.Fatalf("a refused tick changed the status to %q", st.Status)
	}
}

// TestTickReAssertsGitignore: the re-assertion has to happen on the tick, not just
// at creation — this is the framework-generator case at the level that actually
// protects a live build.
func TestTickReAssertsGitignore(t *testing.T) {
	f := newBuildFixture(t)
	f.writePlan(t, "## Feature 1: A\nx\n")
	f.writeState(t, buildState{Status: buildAwaiting, Feature: 1, GateCardID: gateCardID(f.slug, 1)})
	// Feature 1's agent ran create-next-app, which replaced the file.
	if err := os.WriteFile(filepath.Join(f.dir, ".gitignore"), []byte("/node_modules\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := f.cfg.tick(f.slug, false); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(f.dir, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	if !gitignoreHasRule(string(body)) {
		t.Fatalf(".nestnote/ was not restored on the tick:\n%s", body)
	}
}

// TestTickOnTerminalBuildSweepsCron: a done or halted build re-asserts that it has
// no crontab line. Cheap insurance against a stale entry firing forever.
func TestTickOnTerminalBuildSweepsCron(t *testing.T) {
	f := newBuildFixture(t)
	cron := &fakeCrontab{}
	f.cfg.cron = cron.io()
	if err := installCronLine(cron.io(), f.slug, cronLineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, buildState{Status: buildHalted, Feature: 1})
	if _, err := f.cfg.tick(f.slug, false); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(cron.content, cronMarker(f.slug)) {
		t.Fatalf("a terminal build left its crontab line:\n%s", cron.content)
	}
}

// ---------------------------------------------------------------------------
// Scheduled starts
// ---------------------------------------------------------------------------

// TestTickWaitsForAScheduledStart: the recurring safety-net line ticks a
// scheduled build every 30 minutes long before it is due, so the clock — not the
// arrival of a tick — has to be what starts it.
func TestTickWaitsForAScheduledStart(t *testing.T) {
	f := newBuildFixture(t)
	f.writeState(t, buildState{
		Status:  buildScheduled,
		StartAt: time.Now().Add(6 * time.Hour).UTC().Format(time.RFC3339),
	})

	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "wait" {
		t.Fatalf("action = %q (%s), want wait", res.Action, res.Detail)
	}
	st, _ := loadBuild(f.cfg.buildDir(f.slug))
	if st.Status != buildScheduled {
		t.Fatalf("status = %q, want it still scheduled", st.Status)
	}
}

// TestTickStartsADueScheduledBuild: once the start time has passed the very next
// tick plans it, and — asserted here because it is the part that rots silently —
// the date-pinned crontab line is collapsed away, leaving only the recurring one.
func TestTickStartsADueScheduledBuild(t *testing.T) {
	f := newBuildFixture(t)
	cron := &fakeCrontab{}
	f.cfg.cron = cron.io()
	due := time.Now().Add(-time.Minute)
	if err := installCronLine(cron.io(), f.slug, scheduledCronLines(f.root, f.slug, due)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, buildState{Status: buildScheduled, StartAt: due.UTC().Format(time.RFC3339)})

	// Dry run first: it reports the planning run without starting an agent.
	res, err := f.cfg.tick(f.slug, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "plan" {
		t.Fatalf("action = %q (%s), want plan", res.Action, res.Detail)
	}
	if !strings.Contains(res.Prompt, buildPlanName) {
		t.Fatalf("dry run should report the planning prompt, got %q", res.Prompt)
	}
	if st, _ := loadBuild(f.cfg.buildDir(f.slug)); st.Status != buildScheduled {
		t.Fatalf("a dry run moved the build to %q", st.Status)
	}

	// For real. The session is pre-registered so no agent is actually spawned —
	// what this asserts is the state transition and the crontab rewrite, both of
	// which happen before the run is handed off.
	f.cfg.reg.findOrCreateForRun(buildSessionID(f.slug, 0), sessionKindBuild)
	if _, err := f.cfg.tick(f.slug, false); err != nil {
		t.Fatal(err)
	}
	st, _ := loadBuild(f.cfg.buildDir(f.slug))
	if st.Status != buildPlanning {
		t.Fatalf("status = %q, want %q", st.Status, buildPlanning)
	}
	if st.StartAt != "" {
		t.Fatalf("a started build still carries start_at = %q", st.StartAt)
	}
	var managed []string
	for _, l := range strings.Split(strings.TrimSpace(cron.content), "\n") {
		if strings.Contains(l, cronMarker(f.slug)) {
			managed = append(managed, l)
		}
	}
	if len(managed) != 1 {
		t.Fatalf("want one line after starting, got %d — a date-pinned one left behind fires again next year:\n%s",
			len(managed), cron.content)
	}
	if !strings.HasPrefix(managed[0], "*/30 * * * *") {
		t.Fatalf("the surviving line is not the recurring one, so the build can never advance:\n%s", managed[0])
	}
}

// TestTickStartsAScheduledBuildWithAnUnreadableStartAt: a timestamp that doesn't
// parse must not strand a build in `scheduled` forever. Starting early is the
// recoverable failure; never starting is not.
func TestTickStartsAScheduledBuildWithAnUnreadableStartAt(t *testing.T) {
	f := newBuildFixture(t)
	f.writeState(t, buildState{Status: buildScheduled, StartAt: "sometime on Tuesday"})

	res, err := f.cfg.tick(f.slug, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "plan" {
		t.Fatalf("action = %q (%s), want plan", res.Action, res.Detail)
	}
}

// TestScheduledBuildHaltsIfTheIdeaIsDeleted: a scheduled build is the one case
// where the idea can go away between asking for the build and the build starting.
// There is nothing to write a plan from, so it stops and says so.
func TestScheduledBuildHaltsIfTheIdeaIsDeleted(t *testing.T) {
	f := newBuildFixture(t)
	f.writeState(t, buildState{
		Status:  buildScheduled,
		StartAt: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339),
	})
	if err := os.Remove(filepath.Join(cardsDirFor(f.mcpDir, f.source), "idea-4f2a.json")); err != nil {
		t.Fatal(err)
	}

	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "halt" {
		t.Fatalf("action = %q (%s), want halt", res.Action, res.Detail)
	}
	st, _ := loadBuild(f.cfg.buildDir(f.slug))
	if st.Status != buildHalted || st.Note == "" {
		t.Fatalf("state = %+v, want halted with a note saying why", st)
	}
}

// TestBuildStartSchedulesForLater: the handler path. A start time in the future
// leaves the build waiting with no run in flight, and arms both crontab lines.
func TestBuildStartSchedulesForLater(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	cron := &fakeCrontab{}
	f.cfg.cron = cron.io()
	at := time.Now().Add(9 * time.Hour).UTC().Round(time.Minute)

	body := fmt.Sprintf(`{"card_id":"idea-4f2a","source":"greenhouse","project":"Greenhouse Tracker","start_at":%q}`,
		at.Format(time.RFC3339))
	req := httptest.NewRequest(http.MethodPost, "/build/start", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	buildStartHandler(token, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}

	var got buildResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != buildScheduled {
		t.Fatalf("status = %q, want %q", got.Status, buildScheduled)
	}
	if got.StartAt != at.Format(time.RFC3339) {
		t.Fatalf("start_at = %q, want %q", got.StartAt, at.Format(time.RFC3339))
	}
	if f.cfg.reg.get(buildSessionID(f.slug, 0)) != nil {
		t.Fatal("a scheduled build started its planning run immediately")
	}
	if !strings.Contains(cron.content, cronLineAt(f.root, f.slug, at)) {
		t.Fatalf("the exact-minute line was not installed:\n%s", cron.content)
	}
	if !strings.Contains(cron.content, "*/30 * * * *") {
		t.Fatalf("the recurring safety net was not installed:\n%s", cron.content)
	}

	// And the idea card carries the schedule, so the phone can say when it starts
	// without fetching the build.
	card, ok := loadCard(f.mcpDir, f.source, "idea-4f2a")
	if !ok {
		t.Fatal("idea card vanished")
	}
	stamp, _ := card.Payload["build"].(map[string]any)
	if stamp["status"] != buildScheduled || stamp["start_at"] != at.Format(time.RFC3339) {
		t.Fatalf("idea stamp = %+v, want the scheduled status and start time", stamp)
	}
}

// TestBuildStartTreatsAnImminentTimeAsNow: phone and server clocks disagree by
// seconds, and "now" arrives from the phone as an actual timestamp. Anything
// inside buildStartSoon takes the immediate path rather than pinning a cron entry
// for a minute that may already have gone.
func TestBuildStartTreatsAnImminentTimeAsNow(t *testing.T) {
	const token = "secret"
	for _, when := range []time.Duration{-time.Hour, 0, 20 * time.Second} {
		t.Run(when.String(), func(t *testing.T) {
			f := newBuildFixture(t)
			// Pre-registered so the handler takes the immediate path without actually
			// spawning an agent — the status is the assertion, not the run.
			f.cfg.reg.findOrCreateForRun(buildSessionID(f.slug, 0), sessionKindBuild)
			body := fmt.Sprintf(`{"card_id":"idea-4f2a","source":"greenhouse","project":"Greenhouse Tracker","start_at":%q}`,
				time.Now().Add(when).UTC().Format(time.RFC3339))
			req := httptest.NewRequest(http.MethodPost, "/build/start", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			buildStartHandler(token, f.cfg).ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
			}
			st, _ := loadBuild(f.cfg.buildDir(f.slug))
			if st.Status != buildPlanning {
				t.Fatalf("status = %q, want %q — an imminent start is just now", st.Status, buildPlanning)
			}
			if st.StartAt != "" {
				t.Fatalf("start_at = %q, want it cleared", st.StartAt)
			}
		})
	}
}

// TestBuildStartRejectsAnUnparseableStartTime: better a 400 the phone can show
// than a build silently starting now when the user asked for Saturday.
func TestBuildStartRejectsAnUnparseableStartTime(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	req := httptest.NewRequest(http.MethodPost, "/build/start",
		strings.NewReader(`{"card_id":"idea-4f2a","source":"greenhouse","project":"Greenhouse Tracker","start_at":"saturday-ish"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	buildStartHandler(token, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d (%s), want 400", rec.Code, rec.Body.String())
	}
}

// scheduleReq posts a reschedule for the fixture's build, with an empty start
// meaning "now".
func (f *buildFixture) scheduleReq(t *testing.T, token string, startAt time.Time) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"slug":%q}`, f.slug)
	if !startAt.IsZero() {
		body = fmt.Sprintf(`{"slug":%q,"start_at":%q}`, f.slug, startAt.Format(time.RFC3339))
	}
	req := httptest.NewRequest(http.MethodPost, "/build/schedule", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	buildScheduleHandler(token, f.cfg).ServeHTTP(rec, req)
	return rec
}

// TestBuildRescheduleMovesTheStartTime: the user changed their mind about when.
// The state, the crontab pair and the idea's stamp all have to land on the new
// time — a build whose card still advertises the old one would have the phone
// telling the user something the server no longer believes.
func TestBuildRescheduleMovesTheStartTime(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	cron := &fakeCrontab{}
	f.cfg.cron = cron.io()
	was := time.Now().Add(2 * time.Hour).UTC().Round(time.Minute)
	now := time.Now().Add(30 * time.Hour).UTC().Round(time.Minute)
	f.writeState(t, buildState{Status: buildScheduled, StartAt: was.Format(time.RFC3339)})

	rec := f.scheduleReq(t, token, now)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	var got buildResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != buildScheduled || got.StartAt != now.Format(time.RFC3339) {
		t.Fatalf("response = %q at %q, want %q at %q", got.Status, got.StartAt, buildScheduled, now.Format(time.RFC3339))
	}
	st, _ := loadBuild(f.cfg.buildDir(f.slug))
	if st.StartAt != now.Format(time.RFC3339) {
		t.Fatalf("state start_at = %q, want %q", st.StartAt, now.Format(time.RFC3339))
	}
	if strings.Contains(cron.content, cronLineAt(f.root, f.slug, was)) {
		t.Fatalf("the old exact-minute line survived:\n%s", cron.content)
	}
	if !strings.Contains(cron.content, cronLineAt(f.root, f.slug, now)) {
		t.Fatalf("the new exact-minute line was not installed:\n%s", cron.content)
	}
	if !strings.Contains(cron.content, "*/30 * * * *") {
		t.Fatalf("the recurring safety net was dropped:\n%s", cron.content)
	}
	card, ok := loadCard(f.mcpDir, f.source, "idea-4f2a")
	if !ok {
		t.Fatal("idea card vanished")
	}
	stamp, _ := card.Payload["build"].(map[string]any)
	if stamp["start_at"] != now.Format(time.RFC3339) {
		t.Fatalf("idea stamp = %+v, want the new start time", stamp)
	}
	if f.cfg.reg.get(buildSessionID(f.slug, 0)) != nil {
		t.Fatal("rescheduling started the planning run")
	}
}

// TestBuildRescheduleToNowStartsIt: "Now" is one of the picker's presets, so it
// is a reachable answer when changing a start time too — and it has to mean the
// same thing it means at /build/start, not "wait until this minute".
func TestBuildRescheduleToNowStartsIt(t *testing.T) {
	const token = "secret"
	for _, when := range []time.Duration{0, 20 * time.Second} {
		t.Run(when.String(), func(t *testing.T) {
			f := newBuildFixture(t)
			cron := &fakeCrontab{}
			f.cfg.cron = cron.io()
			was := time.Now().Add(9 * time.Hour).UTC().Round(time.Minute)
			f.writeState(t, buildState{Status: buildScheduled, StartAt: was.Format(time.RFC3339)})
			// Pre-registered so the immediate path doesn't actually spawn an agent —
			// the transition is the assertion, not the run.
			f.cfg.reg.findOrCreateForRun(buildSessionID(f.slug, 0), sessionKindBuild)

			var at time.Time
			if when != 0 {
				at = time.Now().Add(when).UTC()
			}
			rec := f.scheduleReq(t, token, at)
			if rec.Code != http.StatusOK {
				t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
			}
			st, _ := loadBuild(f.cfg.buildDir(f.slug))
			if st.Status != buildPlanning {
				t.Fatalf("status = %q, want %q", st.Status, buildPlanning)
			}
			if st.StartAt != "" {
				t.Fatalf("start_at = %q, want it spent", st.StartAt)
			}
			// The dated line has done its job and must not be left to come back
			// around in a year.
			if strings.Contains(cron.content, cronLineAt(f.root, f.slug, was)) {
				t.Fatalf("the dated line survived the start:\n%s", cron.content)
			}
			if !strings.Contains(cron.content, "*/30 * * * *") {
				t.Fatalf("the recurring line was not left behind:\n%s", cron.content)
			}
		})
	}
}

// TestBuildRescheduleRefusesAStartedBuild: once planning has run, PROJECT_PLAN.md
// exists and was written from the idea's wording. There is no start left to move,
// and pretending otherwise would leave the phone showing a time that means
// nothing. Stopping is the only way out of a build that has begun.
func TestBuildRescheduleRefusesAStartedBuild(t *testing.T) {
	const token = "secret"
	for _, status := range []string{buildPlanning, buildBuilding, buildAwaiting, buildDone, buildHalted} {
		t.Run(status, func(t *testing.T) {
			f := newBuildFixture(t)
			f.writeState(t, buildState{Status: status, Feature: 1})
			rec := f.scheduleReq(t, token, time.Now().Add(4*time.Hour))
			if rec.Code != http.StatusConflict {
				t.Fatalf("got %d (%s), want 409", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestBuildRescheduleRejectsAnUnparseableStartTime mirrors the same guard on
// /build/start: better a 400 than a build quietly starting now.
func TestBuildRescheduleRejectsAnUnparseableStartTime(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	f.writeState(t, buildState{
		Status:  buildScheduled,
		StartAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
	})
	req := httptest.NewRequest(http.MethodPost, "/build/schedule",
		strings.NewReader(`{"slug":"greenhouse-tracker","start_at":"saturday-ish"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	buildScheduleHandler(token, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d (%s), want 400", rec.Code, rec.Body.String())
	}
}

// TestBuildRescheduleUnknownProject: nothing to move.
func TestBuildRescheduleUnknownProject(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	rec := f.scheduleReq(t, token, time.Now().Add(4*time.Hour))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d (%s), want 404", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Gating — the combination IS the security boundary, so it is asserted
// ---------------------------------------------------------------------------

// TestBuildGating covers the flag matrix on every endpoint. -allow-code and
// -allow-exec are meaningful only together here (a build step is both, run
// unattended), and -root is what makes gate cards possible at all.
func TestBuildGating(t *testing.T) {
	const token = "secret"

	endpoints := []struct {
		name string
		call func(cfg buildConfig) *httptest.ResponseRecorder
	}{
		{"GET /build", func(cfg buildConfig) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodGet, "/build?slug=greenhouse-tracker", nil)
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			buildStateHandler(token, cfg).ServeHTTP(rec, req)
			return rec
		}},
		{"POST /build/start", func(cfg buildConfig) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPost, "/build/start",
				strings.NewReader(`{"card_id":"idea-4f2a","source":"greenhouse","project":"Greenhouse Tracker"}`))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			buildStartHandler(token, cfg).ServeHTTP(rec, req)
			return rec
		}},
		{"POST /build/schedule", func(cfg buildConfig) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPost, "/build/schedule",
				strings.NewReader(`{"slug":"greenhouse-tracker","start_at":"2030-01-01T09:00:00Z"}`))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			buildScheduleHandler(token, cfg).ServeHTTP(rec, req)
			return rec
		}},
		{"POST /build/stop", func(cfg buildConfig) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPost, "/build/stop", strings.NewReader(`{"slug":"greenhouse-tracker"}`))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			buildStopHandler(token, cfg).ServeHTTP(rec, req)
			return rec
		}},
		{"POST /build/tick", func(cfg buildConfig) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPost, "/build/tick", strings.NewReader(`{"slug":"greenhouse-tracker"}`))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			buildTickHandler(token, cfg).ServeHTTP(rec, req)
			return rec
		}},
	}

	gates := []struct {
		name      string
		allowCode bool
		allowExec bool
		withRoot  bool
		want      int
	}{
		{"-allow-code only", true, false, true, http.StatusForbidden},
		{"-allow-exec only", false, true, true, http.StatusForbidden},
		{"neither", false, false, true, http.StatusForbidden},
		{"both but no -root", true, true, false, http.StatusNotFound},
	}

	for _, ep := range endpoints {
		for _, g := range gates {
			t.Run(ep.name+"/"+g.name, func(t *testing.T) {
				f := newBuildFixture(t)
				f.writeState(t, buildState{Status: buildAwaiting, Feature: 1})
				cfg := f.cfg
				cfg.enabled = g.allowCode && g.allowExec
				if !g.withRoot {
					cfg.root = ""
				}
				if code := ep.call(cfg).Code; code != g.want {
					t.Fatalf("got %d, want %d", code, g.want)
				}
			})
		}
	}

	// Both flags plus -root: the request is actually served.
	t.Run("both with -root works", func(t *testing.T) {
		f := newBuildFixture(t)
		f.writePlan(t, "## Feature 1: A\nx\n")
		f.writeState(t, buildState{Status: buildAwaiting, Feature: 1})
		rec := endpoints[0].call(f.cfg)
		if rec.Code != http.StatusOK {
			t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
		}
		var got buildResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Slug != f.slug || len(got.Features) != 1 {
			t.Fatalf("response = %+v", got)
		}
	})

	// And no token is still no service, whatever the flags say.
	t.Run("unauthenticated", func(t *testing.T) {
		f := newBuildFixture(t)
		req := httptest.NewRequest(http.MethodGet, "/build?slug=greenhouse-tracker", nil)
		rec := httptest.NewRecorder()
		buildStateHandler(token, f.cfg).ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("got %d, want 401", rec.Code)
		}
	})
}

// TestBuildStartRefusesASecondBuild: two builds in one folder would be two agents
// editing the same tree.
func TestBuildStartRefusesASecondBuild(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	f.writeState(t, buildState{Status: buildBuilding, Feature: 1})

	req := httptest.NewRequest(http.MethodPost, "/build/start",
		strings.NewReader(`{"card_id":"idea-4f2a","source":"greenhouse","project":"Greenhouse Tracker"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	buildStartHandler(token, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("got %d (%s), want 409", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Environment parity — §5a, the failure mode most likely to sink this feature
// ---------------------------------------------------------------------------

// TestBuildRunInheritsServerEnvironment is the test that would actually have
// caught the bug this design is most afraid of.
//
// Cron hands its children PATH=/usr/bin:/bin, HOME, LOGNAME, SHELL and nothing
// else — no profile, so no nvm, no ~/.local/bin, very likely no `claude`. The
// whole reason cron only pokes the server is that a build run started HERE
// inherits this process's environment, exactly as /run's and /exec's children do.
//
// So this asserts the child's environment, not that the run merely succeeded: it
// stands a stub `claude` on a PATH entry that cron would never have, and checks
// the child saw both that PATH and a variable that exists only in the server
// process. A build started from cron's own environment fails both.
func TestBuildRunInheritsServerEnvironment(t *testing.T) {
	stubDir := t.TempDir()
	stub := filepath.Join(stubDir, "claude")
	// Report the environment the child was actually given, as a stream-json line.
	script := "#!/bin/sh\n" +
		`printf '{"type":"probe","path":"%s","sentinel":"%s","cwd":"%s"}\n'` +
		` "$PATH" "${NESTNOTE_PARITY_PROBE:-MISSING}" "$(pwd)"` + "\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	// Two things cron's environment could not possibly reproduce: a PATH entry
	// that only the operator's profile would add, and an exported credential-ish
	// variable the start script set.
	t.Setenv("PATH", stubDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("NESTNOTE_PARITY_PROBE", "from-the-server-process")

	projectDir := t.TempDir()
	logPath := filepath.Join(projectDir, buildDirName, "runs", "1.log")
	sess := &session{id: "build-parity-1", kind: sessionKindBuild}
	done := make(chan error, 1)
	startBuildProcess(sess, projectDir, logPath, "probe the environment", 30*time.Second, func(err error) { done <- err })

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("stub run failed: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the build run never finished")
	}

	logged, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("the run left no log: %v", err)
	}
	var probe struct {
		Path     string `json:"path"`
		Sentinel string `json:"sentinel"`
		Cwd      string `json:"cwd"`
	}
	line := strings.TrimSpace(strings.SplitN(string(logged), "\n", 2)[0])
	if err := json.Unmarshal([]byte(line), &probe); err != nil {
		t.Fatalf("could not read the probe line %q: %v", line, err)
	}

	if !strings.Contains(probe.Path, stubDir) {
		t.Fatalf("the child did not inherit the server's PATH.\n got: %s\nwant it to contain: %s", probe.Path, stubDir)
	}
	if probe.Sentinel != "from-the-server-process" {
		t.Fatalf("the child did not inherit the server's exported variables (sentinel=%q) — this is the cron-environment bug", probe.Sentinel)
	}
	// And it ran in the project, not wherever the server happens to live.
	if resolved, _ := filepath.EvalSymlinks(projectDir); probe.Cwd != projectDir && probe.Cwd != resolved {
		t.Fatalf("the run's cwd = %q, want the project dir %q", probe.Cwd, projectDir)
	}
}

// ---------------------------------------------------------------------------
// Cleanup — nothing outlives the build it was armed for
// ---------------------------------------------------------------------------

// TestBuildStopReleasesAScheduledBuildsCronLines: cancelling a build that never
// started has to take BOTH of its lines out — the exact-minute one and the
// recurring safety net — or the one left behind fires at a build that no longer
// exists (and the dated one does it again next year).
func TestBuildStopReleasesAScheduledBuildsCronLines(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	cron := &fakeCrontab{content: "0 9 * * * /usr/bin/backup  # mine\n"}
	f.cfg.cron = cron.io()
	at := time.Now().Add(9 * time.Hour)
	if err := installCronLine(cron.io(), f.slug, scheduledCronLines(f.root, f.slug, at)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, buildState{Status: buildScheduled, StartAt: at.UTC().Format(time.RFC3339)})

	req := httptest.NewRequest(http.MethodPost, "/build/stop", strings.NewReader(`{"slug":"greenhouse-tracker"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	buildStopHandler(token, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}

	if strings.Contains(cron.content, cronMarker(f.slug)) {
		t.Fatalf("a cancelled build left a crontab line behind:\n%s", cron.content)
	}
	if !strings.Contains(cron.content, "# mine") {
		t.Fatalf("the user's own line was eaten:\n%s", cron.content)
	}
	if st, _ := loadBuild(f.cfg.buildDir(f.slug)); st.Status != buildHalted {
		t.Fatalf("status = %q, want %q", st.Status, buildHalted)
	}
}

// TestCancelThenScheduleAgainRearmsTheCrontab walks the round trip the phone
// makes when a user calls a build off and then changes their mind: cancel, hand
// the idea over again for a later date, then move that date. Each step is
// asserted against the crontab itself, because "I rescheduled it and there's
// nothing in the crontab" is the failure this feature dies of — and every step
// after the first runs against a project folder that already has a build state
// and a driver script in it.
func TestCancelThenScheduleAgainRearmsTheCrontab(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	cron := &fakeCrontab{content: "0 9 * * * /usr/bin/backup  # mine\n"}
	f.cfg.cron = cron.io()

	post := func(t *testing.T, path string, h http.Handler, body string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: got %d (%s), want 200", path, rec.Code, rec.Body.String())
		}
	}
	// The pair a waiting build is armed with: the minute it was asked for, and the
	// recurring safety net underneath it.
	wantPair := func(t *testing.T, at time.Time) {
		t.Helper()
		for _, want := range []string{cronLineAt(f.root, f.slug, at), cronLineFor(f.root, f.slug)} {
			if !strings.Contains(cron.content, want) {
				t.Fatalf("crontab is missing\n\t%s\ngot:\n%s", want, cron.content)
			}
		}
		if n := strings.Count(cron.content, cronMarker(f.slug)); n != 2 {
			t.Fatalf("%d lines for this build, want exactly the pair:\n%s", n, cron.content)
		}
		if !strings.Contains(cron.content, "# mine") {
			t.Fatalf("the user's own line was eaten:\n%s", cron.content)
		}
	}

	first := time.Now().Add(9 * time.Hour)
	post(t, "/build/start", buildStartHandler(token, f.cfg),
		`{"card_id":"idea-4f2a","source":"greenhouse","project":"Greenhouse tracker","start_at":"`+
			first.UTC().Format(time.RFC3339)+`"}`)
	wantPair(t, first)

	post(t, "/build/stop", buildStopHandler(token, f.cfg), `{"slug":"`+f.slug+`"}`)
	if hasCronLine(cron.content, f.slug) {
		t.Fatalf("a cancelled build left a crontab line behind:\n%s", cron.content)
	}

	// Handed over again, for a different day. The halted build from a moment ago
	// is in the way of this one, and must not be.
	second := time.Now().Add(48 * time.Hour)
	post(t, "/build/start", buildStartHandler(token, f.cfg),
		`{"card_id":"idea-4f2a","source":"greenhouse","project":"Greenhouse tracker","start_at":"`+
			second.UTC().Format(time.RFC3339)+`"}`)
	wantPair(t, second)

	// And moved again from the schedule card, which replaces the dated line rather
	// than adding a second one.
	third := time.Now().Add(72 * time.Hour)
	post(t, "/build/schedule", buildScheduleHandler(token, f.cfg),
		`{"slug":"`+f.slug+`","start_at":"`+third.UTC().Format(time.RFC3339)+`"}`)
	wantPair(t, third)

	st, _ := loadBuild(f.cfg.buildDir(f.slug))
	if st.Status != buildScheduled {
		t.Fatalf("status = %q, want it waiting on the new time", st.Status)
	}
	if st.StartAt != third.UTC().Format(time.RFC3339) {
		t.Fatalf("start_at = %q, want %q", st.StartAt, third.UTC().Format(time.RFC3339))
	}
}

// TestBuildStopSweepsCronWithNoStateOnDisk: the build state lives in the project
// folder, so anything that removed .nestnote/ by hand leaves the crontab line
// armed with nothing to read. A stop is the last request that will ever name that
// slug — it answers 404 honestly, but not before taking the line out.
func TestBuildStopSweepsCronWithNoStateOnDisk(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	cron := &fakeCrontab{}
	f.cfg.cron = cron.io()
	if err := installCronLine(cron.io(), f.slug, cronLineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/build/stop", strings.NewReader(`{"slug":"greenhouse-tracker"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	buildStopHandler(token, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404 — there is no build to report", rec.Code)
	}
	if strings.Contains(cron.content, cronMarker(f.slug)) {
		t.Fatalf("a build with no state kept its crontab line:\n%s", cron.content)
	}
}

// TestHaltKeepsRemovingCronWhenTheStateWriteFails: the halt has to reach the
// crontab even when it cannot record itself. A build.json that didn't land is a
// bug; a line still ticking a build nobody can stop is a worse one.
func TestHaltKeepsRemovingCronWhenTheStateWriteFails(t *testing.T) {
	f := newBuildFixture(t)
	cron := &fakeCrontab{}
	f.cfg.cron = cron.io()
	if err := installCronLine(cron.io(), f.slug, cronLineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	st := buildState{Slug: f.slug, Source: f.source, CardID: "idea-4f2a", Status: buildBuilding, Feature: 1}
	// A file where the .nestnote/ directory should be: saveBuild's MkdirAll fails.
	dir := f.cfg.buildDir(f.slug)
	if err := os.WriteFile(dir, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := f.cfg.halt(dir, f.mcpDir, st, "stopped"); err == nil {
		t.Fatal("halt should report the failed state write")
	}
	if strings.Contains(cron.content, cronMarker(f.slug)) {
		t.Fatalf("the crontab line survived a halt:\n%s", cron.content)
	}
}

// TestDismissingAnIdeaStopsItsBuild is the dashboard half of the cleanup:
// dismissing a card is how an idea is deleted, and an idea's build only ever
// existed to build that idea. The crontab line goes with it.
func TestDismissingAnIdeaStopsItsBuild(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	cron := &fakeCrontab{content: "0 9 * * * /usr/bin/backup  # mine\n"}
	f.cfg.cron = cron.io()
	at := time.Now().Add(9 * time.Hour)
	if err := installCronLine(cron.io(), f.slug, scheduledCronLines(f.root, f.slug, at)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, buildState{
		Status:     buildScheduled,
		StartAt:    at.UTC().Format(time.RFC3339),
		GateCardID: gateCardID(f.slug, 1),
	})
	if err := writeCard(f.mcpDir, f.source, dashCard{
		ID: gateCardID(f.slug, 1), Kind: buildCardKind, Title: "Validate: feature 1",
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/action?token="+token,
		strings.NewReader(`{"action":"dismiss","id":"idea-4f2a","source":"greenhouse"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	actionHandler(token, f.root, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}

	if strings.Contains(cron.content, cronMarker(f.slug)) {
		t.Fatalf("the deleted idea's build kept its crontab line:\n%s", cron.content)
	}
	if !strings.Contains(cron.content, "# mine") {
		t.Fatalf("the user's own line was eaten:\n%s", cron.content)
	}
	st, _ := loadBuild(f.cfg.buildDir(f.slug))
	if st.Status != buildHalted || st.Note == "" {
		t.Fatalf("state = %+v, want halted with a note saying why", st)
	}
	// And the card that was asking for a decision about it stops asking.
	gate, ok := loadCard(f.mcpDir, f.source, gateCardID(f.slug, 1))
	if !ok || !gate.Dismissed {
		t.Fatalf("gate card = %+v, want it retired with the build", gate)
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
	cron := &fakeCrontab{content: "0 9 * * * /usr/bin/backup  # mine\n"}
	f.cfg.cron = cron.io()
	if err := installCronLine(cron.io(), f.slug, cronLineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	gate := gateCardID(f.slug, 2)
	f.writeState(t, buildState{Status: buildAwaiting, Feature: 2, GateCardID: gate})
	if err := writeCard(f.mcpDir, f.source, dashCard{
		ID: gate, Kind: buildCardKind, Title: "Validate: feature 2",
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/action?token="+token,
		strings.NewReader(`{"action":"dismiss","id":"`+gate+`","source":"greenhouse"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	actionHandler(token, f.root, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}

	if hasCronLine(cron.content, f.slug) {
		t.Fatalf("a rejected feature left the build's crontab line armed:\n%s", cron.content)
	}
	if !strings.Contains(cron.content, "# mine") {
		t.Fatalf("the user's own line was eaten:\n%s", cron.content)
	}
	st, _ := loadBuild(f.cfg.buildDir(f.slug))
	if st.Status != buildHalted {
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
	cron := &fakeCrontab{}
	f.cfg.cron = cron.io()
	gate := gateCardID(f.slug, 1)
	f.writeState(t, buildState{Status: buildDone, Feature: 1, GateCardID: gate})
	if err := writeCard(f.mcpDir, f.source, dashCard{
		ID: gate, Kind: buildCardKind, Title: "Validate: feature 1",
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/action?token="+token,
		strings.NewReader(`{"action":"dismiss","id":"`+gate+`","source":"greenhouse"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	actionHandler(token, f.root, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if st, _ := loadBuild(f.cfg.buildDir(f.slug)); st.Status != buildDone {
		t.Fatalf("status = %q, want the finished build left alone", st.Status)
	}
	if cron.saves != 0 {
		t.Fatalf("the crontab was rewritten %d times for a build that had already ended", cron.saves)
	}
}

// TestDismissingAnotherCardLeavesTheBuildAlone: every dismissal on the dashboard
// runs the sweep, so the match has to be exact. A neighbouring card in the same
// notebook must not take a build down with it.
func TestDismissingAnotherCardLeavesTheBuildAlone(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	cron := &fakeCrontab{}
	f.cfg.cron = cron.io()
	if err := installCronLine(cron.io(), f.slug, cronLineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, buildState{Status: buildBuilding, Feature: 1})
	if err := writeCard(f.mcpDir, f.source, dashCard{
		ID: "idea-9c11", Kind: "idea", Title: "Something else entirely",
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/action?token="+token,
		strings.NewReader(`{"action":"dismiss","id":"idea-9c11","source":"greenhouse"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	actionHandler(token, f.root, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	if !strings.Contains(cron.content, cronMarker(f.slug)) {
		t.Fatalf("dismissing an unrelated card stopped a live build:\n%s", cron.content)
	}
	if st, _ := loadBuild(f.cfg.buildDir(f.slug)); st.Status != buildBuilding {
		t.Fatalf("status = %q, want it still building", st.Status)
	}
}

// TestScheduledBuildHaltsIfTheIdeaWasDismissed is the backstop for a dismissal
// that never reached /action — the orchestrator's own dismiss_card tool, or a
// server that was down at the time. A dismissed card is still a file on disk, so
// without this check the planner would happily build an idea the user deleted.
func TestScheduledBuildHaltsIfTheIdeaWasDismissed(t *testing.T) {
	f := newBuildFixture(t)
	cron := &fakeCrontab{}
	f.cfg.cron = cron.io()
	if err := installCronLine(cron.io(), f.slug, cronLineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, buildState{
		Status:  buildScheduled,
		StartAt: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339),
	})
	if _, ok := updateCard(f.mcpDir, f.source, "idea-4f2a", func(c *dashCard) { c.Dismissed = true }); !ok {
		t.Fatal("could not dismiss the idea card")
	}

	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "halt" {
		t.Fatalf("action = %q (%s), want halt", res.Action, res.Detail)
	}
	if strings.Contains(cron.content, cronMarker(f.slug)) {
		t.Fatalf("the halted build kept its crontab line:\n%s", cron.content)
	}
	if f.cfg.reg.get(buildSessionID(f.slug, 0)) != nil {
		t.Fatal("a dismissed idea still started its planning run")
	}
}
