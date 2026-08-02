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
			f.writeState(t, State{Status: statusAwaiting, Feature: 1, GateCardID: gate})
			if !tc.deleteCard {
				if err := store.WriteCard(f.mcpDir, f.source, store.Card{
					ID:        gate,
					Kind:      cardKind,
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
	f.writeState(t, State{Status: statusAwaiting, Feature: 1, GateCardID: gate})
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{ID: gate, Kind: cardKind, Title: "Validate", Done: true}); err != nil {
		t.Fatal(err)
	}

	before, _ := loadState(f.cfg.buildDir(f.slug))
	if _, err := f.cfg.tick(f.slug, true); err != nil {
		t.Fatal(err)
	}
	after, _ := loadState(f.cfg.buildDir(f.slug))
	if before != after {
		t.Fatalf("dry run mutated the build state:\n before %+v\n after  %+v", before, after)
	}
	if card, _ := store.LoadCard(f.mcpDir, f.source, gate); card.Dismissed {
		t.Fatal("dry run retired the gate card")
	}
}

// TestTickHaltsOnRejection: dismissing the gate card stops the build for good —
// status halted, and the crontab line gone, so nothing keeps firing at a project
// the user has said no to.
func TestTickHaltsOnRejection(t *testing.T) {
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	if err := cron.InstallLine(ct.io(), f.slug, cron.LineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	f.writePlan(t, "## Feature 1: A\nx\n\n## Feature 2: B\ny\n")
	gate := gateCardID(f.slug, 1)
	f.writeState(t, State{Status: statusAwaiting, Feature: 1, GateCardID: gate})
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{ID: gate, Kind: cardKind, Title: "Validate", Dismissed: true}); err != nil {
		t.Fatal(err)
	}

	if _, err := f.cfg.tick(f.slug, false); err != nil {
		t.Fatal(err)
	}
	st, _ := loadState(f.cfg.buildDir(f.slug))
	if st.Status != statusHalted {
		t.Fatalf("status = %q, want halted", st.Status)
	}
	if strings.Contains(ct.content, marker(f.slug)) {
		t.Fatalf("halted build kept its crontab line:\n%s", ct.content)
	}
	// The idea page's lock is derived from the card, so halting has to clear it
	// there too or the user can never talk about the idea again.
	idea, ok := store.LoadCard(f.mcpDir, f.source, "idea-4f2a")
	if !ok {
		t.Fatal("idea card vanished")
	}
	stamp, _ := idea.Payload["build"].(map[string]any)
	if stamp == nil || stamp["status"] != statusHalted {
		t.Fatalf("idea card build stamp = %+v, want status halted", stamp)
	}
	// And *why* it halted, since the card is all the dashboard row has: a row that
	// could only say "Stopped" would make the user open the page to learn the one
	// thing worth knowing about a stopped build.
	if stamp["note"] != "feature 1 was rejected" {
		t.Fatalf("idea card build stamp note = %v, want the reason it halted", stamp["note"])
	}
}

// TestTickFinishesWhenThePlanRunsOut: validating the last feature ends the build
// rather than looping on a feature the plan doesn't have.
func TestTickFinishesWhenThePlanRunsOut(t *testing.T) {
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	if err := cron.InstallLine(ct.io(), f.slug, cron.LineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	f.writePlan(t, "## Feature 1: Only one\nx\n")
	gate := gateCardID(f.slug, 1)
	f.writeState(t, State{Status: statusAwaiting, Feature: 1, GateCardID: gate})
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{ID: gate, Kind: cardKind, Title: "Validate", Done: true}); err != nil {
		t.Fatal(err)
	}

	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "finished" {
		t.Fatalf("action = %q (%s), want finished", res.Action, res.Detail)
	}
	st, _ := loadState(f.cfg.buildDir(f.slug))
	if st.Status != statusDone {
		t.Fatalf("status = %q, want done", st.Status)
	}
	if strings.Contains(ct.content, marker(f.slug)) {
		t.Fatalf("finished build kept its crontab line:\n%s", ct.content)
	}
	// The step card stays — it is the user's record of that feature, and only the
	// user takes one off the dashboard — but it stops reading as an open decision.
	card, _ := store.LoadCard(f.mcpDir, f.source, gate)
	if card.Dismissed {
		t.Fatal("the finished build dismissed its step card")
	}
	if !strings.HasPrefix(card.Body, "> Every feature in the plan is built") {
		t.Fatalf("step card body = %q, want the outcome quoted at the top", card.Body)
	}
	stamp, _ := card.Payload["build"].(map[string]any)
	if stamp == nil || stamp["status"] != statusDone {
		t.Fatalf("step card build stamp = %+v, want status done", stamp)
	}
}

// TestTickRefusesASecondRun: a feature that takes longer than the tick interval
// must never get a second agent in the same directory. The session registry is
// the concurrency primitive — one live session per build step.
func TestTickRefusesASecondRun(t *testing.T) {
	f := newBuildFixture(t)
	f.writePlan(t, "## Feature 1: A\nx\n")
	f.writeState(t, State{Status: statusBuilding, Feature: 1, GateCardID: gateCardID(f.slug, 1)})

	// Stand in for a run in flight: a registered session whose process hasn't
	// exited. This is exactly what startFeature leaves behind.
	f.cfg.Reg.FindOrCreateForRun(sessionID(f.slug, 1), session.KindBuild)

	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "busy" {
		t.Fatalf("action = %q (%s), want busy", res.Action, res.Detail)
	}
	if st, _ := loadState(f.cfg.buildDir(f.slug)); st.Status != statusBuilding {
		t.Fatalf("a refused tick changed the status to %q", st.Status)
	}
}

// TestTickReAssertsGitignore: the re-assertion has to happen on the tick, not just
// at creation — this is the framework-generator case at the level that actually
// protects a live build.
func TestTickReAssertsGitignore(t *testing.T) {
	f := newBuildFixture(t)
	f.writePlan(t, "## Feature 1: A\nx\n")
	f.writeState(t, State{Status: statusAwaiting, Feature: 1, GateCardID: gateCardID(f.slug, 1)})
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
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	if err := cron.InstallLine(ct.io(), f.slug, cron.LineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, State{Status: statusHalted, Feature: 1})
	if _, err := f.cfg.tick(f.slug, false); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(ct.content, marker(f.slug)) {
		t.Fatalf("a terminal build left its crontab line:\n%s", ct.content)
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
	f.writeState(t, State{
		Status:  statusScheduled,
		StartAt: time.Now().Add(6 * time.Hour).UTC().Format(time.RFC3339),
	})

	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "wait" {
		t.Fatalf("action = %q (%s), want wait", res.Action, res.Detail)
	}
	st, _ := loadState(f.cfg.buildDir(f.slug))
	if st.Status != statusScheduled {
		t.Fatalf("status = %q, want it still scheduled", st.Status)
	}
}

// TestTickStartsADueScheduledBuild: once the start time has passed the very next
// tick plans it, and — asserted here because it is the part that rots silently —
// the date-pinned crontab line is collapsed away, leaving only the recurring one.
func TestTickStartsADueScheduledBuild(t *testing.T) {
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	due := time.Now().Add(-time.Minute)
	if err := cron.InstallLine(ct.io(), f.slug, cron.ScheduledLines(f.root, f.slug, due)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, State{Status: statusScheduled, StartAt: due.UTC().Format(time.RFC3339)})

	// Dry run first: it reports the planning run without starting an agent.
	res, err := f.cfg.tick(f.slug, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "plan" {
		t.Fatalf("action = %q (%s), want plan", res.Action, res.Detail)
	}
	if !strings.Contains(res.Prompt, planName) {
		t.Fatalf("dry run should report the planning prompt, got %q", res.Prompt)
	}
	if st, _ := loadState(f.cfg.buildDir(f.slug)); st.Status != statusScheduled {
		t.Fatalf("a dry run moved the build to %q", st.Status)
	}

	// For real. The session is pre-registered so no agent is actually spawned —
	// what this asserts is the state transition and the crontab rewrite, both of
	// which happen before the run is handed off.
	f.cfg.Reg.FindOrCreateForRun(sessionID(f.slug, 0), session.KindBuild)
	if _, err := f.cfg.tick(f.slug, false); err != nil {
		t.Fatal(err)
	}
	st, _ := loadState(f.cfg.buildDir(f.slug))
	if st.Status != statusPlanning {
		t.Fatalf("status = %q, want %q", st.Status, statusPlanning)
	}
	if st.StartAt != "" {
		t.Fatalf("a started build still carries start_at = %q", st.StartAt)
	}
	var managed []string
	for _, l := range strings.Split(strings.TrimSpace(ct.content), "\n") {
		if strings.Contains(l, marker(f.slug)) {
			managed = append(managed, l)
		}
	}
	if len(managed) != 1 {
		t.Fatalf("want one line after starting, got %d — a date-pinned one left behind fires again next year:\n%s",
			len(managed), ct.content)
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
	f.writeState(t, State{Status: statusScheduled, StartAt: "sometime on Tuesday"})

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
	f.writeState(t, State{
		Status:  statusScheduled,
		StartAt: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339),
	})
	if err := os.Remove(filepath.Join(store.CardsDirFor(f.mcpDir, f.source), "idea-4f2a.json")); err != nil {
		t.Fatal(err)
	}

	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "halt" {
		t.Fatalf("action = %q (%s), want halt", res.Action, res.Detail)
	}
	st, _ := loadState(f.cfg.buildDir(f.slug))
	if st.Status != statusHalted || st.Note == "" {
		t.Fatalf("state = %+v, want halted with a note saying why", st)
	}
}

// TestTickHoldsTheNextFeatureUntilItsTime: the whole point of putting a time on a
// validated step. The tick runs every half hour regardless, so if it didn't read
// the clock the next feature would start at the next tick and the chosen time
// would be decoration.
func TestTickHoldsTheNextFeatureUntilItsTime(t *testing.T) {
	f := newBuildFixture(t)
	f.writePlan(t, "## Feature 1: A\nx\n\n## Feature 2: B\ny\n")
	gate := gateCardID(f.slug, 1)
	f.writeState(t, State{
		Status: statusAwaiting, Feature: 1, GateCardID: gate,
		StartAt: time.Now().Add(6 * time.Hour).UTC().Format(time.RFC3339),
	})
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{
		ID: gate, Kind: cardKind, Title: "Validate: feature 1", Done: true,
	}); err != nil {
		t.Fatal(err)
	}

	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "wait" {
		t.Fatalf("action = %q (%s), want wait", res.Action, res.Detail)
	}
	st, _ := loadState(f.cfg.buildDir(f.slug))
	if st.Status != statusAwaiting {
		t.Fatalf("status = %q, want it still parked at the step", st.Status)
	}
	if f.cfg.Reg.Get(sessionID(f.slug, 2)) != nil {
		t.Fatal("the next feature started early")
	}
}

// TestTickStartsTheNextFeatureWhenDue: and when the minute comes round it goes,
// leaving the crontab back on the recurring line alone — a dated entry left behind
// fires again a year later, against whatever that project has become by then.
func TestTickStartsTheNextFeatureWhenDue(t *testing.T) {
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	due := time.Now().Add(-2 * time.Minute)
	if err := cron.InstallLine(ct.io(), f.slug, cron.ScheduledLines(f.root, f.slug, due)); err != nil {
		t.Fatal(err)
	}
	f.writePlan(t, "## Feature 1: A\nx\n\n## Feature 2: B\ny\n")
	gate := gateCardID(f.slug, 1)
	f.writeState(t, State{
		Status: statusAwaiting, Feature: 1, GateCardID: gate,
		StartAt: due.UTC().Format(time.RFC3339),
	})
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{
		ID: gate, Kind: cardKind, Title: "Validate: feature 1", Done: true,
	}); err != nil {
		t.Fatal(err)
	}
	f.cfg.Reg.FindOrCreateForRun(sessionID(f.slug, 2), session.KindBuild)

	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "busy" && res.Action != "feature" {
		t.Fatalf("action = %q (%s), want the next feature to have been taken up", res.Action, res.Detail)
	}
	st, _ := loadState(f.cfg.buildDir(f.slug))
	if st.Status != statusBuilding || st.Feature != 2 {
		t.Fatalf("state = %q feature %d, want building feature 2", st.Status, st.Feature)
	}
	if st.StartAt != "" {
		t.Fatalf("start_at = %q, want it spent", st.StartAt)
	}
	if strings.Contains(ct.content, cron.LineAt(f.root, f.slug, due)) {
		t.Fatalf("the dated line survived the run it triggered:\n%s", ct.content)
	}
	if !strings.Contains(ct.content, "*/30 * * * *") {
		t.Fatalf("the recurring line was not left behind:\n%s", ct.content)
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
	logPath := filepath.Join(projectDir, dirName, "runs", "1.log")
	sess, _ := session.NewRegistry().FindOrCreateForRun("build-parity-1", session.KindBuild)
	done := make(chan error, 1)
	startProcess(sess, projectDir, logPath, "probe the environment", 30*time.Second, func(err error) { done <- err })

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
	ct := &fakeCrontab{content: "0 9 * * * /usr/bin/backup  # mine\n"}
	f.cfg.Cron = ct.io()
	at := time.Now().Add(9 * time.Hour)
	if err := cron.InstallLine(ct.io(), f.slug, cron.ScheduledLines(f.root, f.slug, at)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, State{Status: statusScheduled, StartAt: at.UTC().Format(time.RFC3339)})

	req := httptest.NewRequest(http.MethodPost, "/build/stop", strings.NewReader(`{"slug":"greenhouse-tracker"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	StopHandler(token, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}

	if strings.Contains(ct.content, marker(f.slug)) {
		t.Fatalf("a cancelled build left a crontab line behind:\n%s", ct.content)
	}
	if !strings.Contains(ct.content, "# mine") {
		t.Fatalf("the user's own line was eaten:\n%s", ct.content)
	}
	if st, _ := loadState(f.cfg.buildDir(f.slug)); st.Status != statusHalted {
		t.Fatalf("status = %q, want %q", st.Status, statusHalted)
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
	ct := &fakeCrontab{content: "0 9 * * * /usr/bin/backup  # mine\n"}
	f.cfg.Cron = ct.io()

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
		for _, want := range []string{cron.LineAt(f.root, f.slug, at), cron.LineFor(f.root, f.slug)} {
			if !strings.Contains(ct.content, want) {
				t.Fatalf("crontab is missing\n\t%s\ngot:\n%s", want, ct.content)
			}
		}
		if n := strings.Count(ct.content, marker(f.slug)); n != 2 {
			t.Fatalf("%d lines for this build, want exactly the pair:\n%s", n, ct.content)
		}
		if !strings.Contains(ct.content, "# mine") {
			t.Fatalf("the user's own line was eaten:\n%s", ct.content)
		}
	}

	first := time.Now().Add(9 * time.Hour)
	post(t, "/build/start", StartHandler(token, f.cfg),
		`{"card_id":"idea-4f2a","source":"greenhouse","project":"Greenhouse tracker","start_at":"`+
			first.UTC().Format(time.RFC3339)+`"}`)
	wantPair(t, first)

	post(t, "/build/stop", StopHandler(token, f.cfg), `{"slug":"`+f.slug+`"}`)
	if cron.HasLine(ct.content, f.slug) {
		t.Fatalf("a cancelled build left a crontab line behind:\n%s", ct.content)
	}

	// Handed over again, for a different day. The halted build from a moment ago
	// is in the way of this one, and must not be.
	second := time.Now().Add(48 * time.Hour)
	post(t, "/build/start", StartHandler(token, f.cfg),
		`{"card_id":"idea-4f2a","source":"greenhouse","project":"Greenhouse tracker","start_at":"`+
			second.UTC().Format(time.RFC3339)+`"}`)
	wantPair(t, second)

	// And moved again from the schedule card, which replaces the dated line rather
	// than adding a second one.
	third := time.Now().Add(72 * time.Hour)
	post(t, "/build/schedule", ScheduleHandler(token, f.cfg),
		`{"slug":"`+f.slug+`","start_at":"`+third.UTC().Format(time.RFC3339)+`"}`)
	wantPair(t, third)

	st, _ := loadState(f.cfg.buildDir(f.slug))
	if st.Status != statusScheduled {
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
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	if err := cron.InstallLine(ct.io(), f.slug, cron.LineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/build/stop", strings.NewReader(`{"slug":"greenhouse-tracker"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	StopHandler(token, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404 — there is no build to report", rec.Code)
	}
	if strings.Contains(ct.content, marker(f.slug)) {
		t.Fatalf("a build with no state kept its crontab line:\n%s", ct.content)
	}
}

// TestHaltKeepsRemovingCronWhenTheStateWriteFails: the halt has to reach the
// crontab even when it cannot record itself. A build.json that didn't land is a
// bug; a line still ticking a build nobody can stop is a worse one.
func TestHaltKeepsRemovingCronWhenTheStateWriteFails(t *testing.T) {
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	if err := cron.InstallLine(ct.io(), f.slug, cron.LineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	st := State{Slug: f.slug, Source: f.source, CardID: "idea-4f2a", Status: statusBuilding, Feature: 1}
	// A file where the .nestnote/ directory should be: saveBuild's MkdirAll fails.
	dir := f.cfg.buildDir(f.slug)
	if err := os.WriteFile(dir, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := f.cfg.halt(dir, f.mcpDir, st, "stopped"); err == nil {
		t.Fatal("halt should report the failed state write")
	}
	if strings.Contains(ct.content, marker(f.slug)) {
		t.Fatalf("the crontab line survived a halt:\n%s", ct.content)
	}
}

// TestScheduledBuildHaltsIfTheIdeaWasDismissed is the backstop for a dismissal
// that never reached /action — the orchestrator's own dismiss_card tool, or a
// server that was down at the time. A dismissed card is still a file on disk, so
// without this check the planner would happily build an idea the user deleted.
func TestScheduledBuildHaltsIfTheIdeaWasDismissed(t *testing.T) {
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	if err := cron.InstallLine(ct.io(), f.slug, cron.LineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	f.writeState(t, State{
		Status:  statusScheduled,
		StartAt: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339),
	})
	if _, ok := store.UpdateCard(f.mcpDir, f.source, "idea-4f2a", func(c *store.Card) { c.Dismissed = true }); !ok {
		t.Fatal("could not dismiss the idea card")
	}

	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "halt" {
		t.Fatalf("action = %q (%s), want halt", res.Action, res.Detail)
	}
	if strings.Contains(ct.content, marker(f.slug)) {
		t.Fatalf("the halted build kept its crontab line:\n%s", ct.content)
	}
	if f.cfg.Reg.Get(sessionID(f.slug, 0)) != nil {
		t.Fatal("a dismissed idea still started its planning run")
	}
}

// TestTickPutsTheIdeaBackAtTheTopOfThePlan: the Overview is the server's section,
// not the agent's. A revision run that reworded it (they are allowed to edit the
// plan) has it replaced on the next tick, in the user's own words — this is the
// only place a project still says what problem it was for once the idea card is
// off the dashboard.
func TestTickPutsTheIdeaBackAtTheTopOfThePlan(t *testing.T) {
	f := newBuildFixture(t)
	f.writePlan(t, "# Greenhouse tracker\n\nintro\n\n## Overview\n\nSomething the agent made up.\n\n"+
		"## Feature 1: A\n\nx\n")
	gate := gateCardID(f.slug, 1)
	f.writeState(t, State{Status: statusAwaiting, Feature: 1, GateCardID: gate})
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{
		ID: gate, Kind: cardKind, Title: "Greenhouse tracker",
	}); err != nil {
		t.Fatal(err)
	}
	// The gate is untouched, so the tick does nothing to the build itself.
	if _, err := f.cfg.tick(f.slug, false); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(filepath.Join(f.dir, planName))
	if err != nil {
		t.Fatal(err)
	}
	plan := string(data)
	if !strings.Contains(plan, "The greenhouse is a mystery.") {
		t.Fatalf("the idea did not go back into the plan:\n%s", plan)
	}
	if strings.Contains(plan, "Something the agent made up.") {
		t.Fatalf("the agent's overview survived the tick:\n%s", plan)
	}
	if !strings.Contains(plan, "## Feature 1: A") {
		t.Fatalf("re-asserting the overview damaged the plan:\n%s", plan)
	}
	// And it is what /build reports, which is what the phone shows above the features.
	if ov := f.cfg.response(f.slug, State{Slug: f.slug}).Overview; !strings.Contains(ov, "The greenhouse is a mystery.") {
		t.Fatalf("the response's overview = %q", ov)
	}
}

// TestTickOverviewSurvivesARetiredIdea: the idea card is dismissed, not deleted,
// precisely so the plan can keep being re-asserted from it for the whole life of
// the build — not just up to the first step card.
func TestTickOverviewSurvivesARetiredIdea(t *testing.T) {
	f := newBuildFixture(t)
	f.writePlan(t, "# Greenhouse tracker\n\n## Feature 2: B\n\ny\n")
	gate := gateCardID(f.slug, 2)
	f.writeState(t, State{Status: statusAwaiting, Feature: 2, GateCardID: gate})
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{ID: gate, Kind: cardKind}); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.UpdateCard(f.mcpDir, f.source, "idea-4f2a", func(c *store.Card) { c.Dismissed = true }); !ok {
		t.Fatal("could not retire the idea card")
	}

	if _, err := f.cfg.tick(f.slug, false); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(f.dir, planName))
	if !strings.Contains(string(data), "The greenhouse is a mystery.") {
		t.Fatalf("a retired idea stopped reaching the plan:\n%s", data)
	}
}
