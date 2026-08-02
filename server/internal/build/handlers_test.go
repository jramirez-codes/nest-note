package build

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nestnote/server/internal/cron"
	"nestnote/server/internal/session"
	"nestnote/server/internal/store"
)

// TestBuildStartSchedulesForLater: the handler path. A start time in the future
// leaves the build waiting with no run in flight, and arms both crontab lines.
func TestBuildStartSchedulesForLater(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	at := time.Now().Add(9 * time.Hour).UTC().Round(time.Minute)

	body := fmt.Sprintf(`{"card_id":"idea-4f2a","source":"greenhouse","project":"Greenhouse Tracker","start_at":%q}`,
		at.Format(time.RFC3339))
	req := httptest.NewRequest(http.MethodPost, "/build/start", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	StartHandler(token, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}

	var got Response
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != statusScheduled {
		t.Fatalf("status = %q, want %q", got.Status, statusScheduled)
	}
	if got.StartAt != at.Format(time.RFC3339) {
		t.Fatalf("start_at = %q, want %q", got.StartAt, at.Format(time.RFC3339))
	}
	if f.cfg.Reg.Get(sessionID(f.slug, 0)) != nil {
		t.Fatal("a scheduled build started its planning run immediately")
	}
	if !strings.Contains(ct.content, cron.LineAt(f.root, f.slug, at)) {
		t.Fatalf("the exact-minute line was not installed:\n%s", ct.content)
	}
	if !strings.Contains(ct.content, "*/30 * * * *") {
		t.Fatalf("the recurring safety net was not installed:\n%s", ct.content)
	}

	// And the idea card carries the schedule, so the phone can say when it starts
	// without fetching the build.
	card, ok := store.LoadCard(f.mcpDir, f.source, "idea-4f2a")
	if !ok {
		t.Fatal("idea card vanished")
	}
	stamp, _ := card.Payload["build"].(map[string]any)
	if stamp["status"] != statusScheduled || stamp["start_at"] != at.Format(time.RFC3339) {
		t.Fatalf("idea stamp = %+v, want the scheduled status and start time", stamp)
	}
}

// TestBuildStartTreatsAnImminentTimeAsNow: phone and server clocks disagree by
// seconds, and "now" arrives from the phone as an actual timestamp. Anything
// inside startSoon takes the immediate path rather than pinning a cron entry
// for a minute that may already have gone.
func TestBuildStartTreatsAnImminentTimeAsNow(t *testing.T) {
	const token = "secret"
	for _, when := range []time.Duration{-time.Hour, 0, 20 * time.Second} {
		t.Run(when.String(), func(t *testing.T) {
			f := newBuildFixture(t)
			// Pre-registered so the handler takes the immediate path without actually
			// spawning an agent — the status is the assertion, not the run.
			f.cfg.Reg.FindOrCreateForRun(sessionID(f.slug, 0), session.KindBuild)
			body := fmt.Sprintf(`{"card_id":"idea-4f2a","source":"greenhouse","project":"Greenhouse Tracker","start_at":%q}`,
				time.Now().Add(when).UTC().Format(time.RFC3339))
			req := httptest.NewRequest(http.MethodPost, "/build/start", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			StartHandler(token, f.cfg).ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
			}
			st, _ := loadState(f.cfg.buildDir(f.slug))
			if st.Status != statusPlanning {
				t.Fatalf("status = %q, want %q — an imminent start is just now", st.Status, statusPlanning)
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
	StartHandler(token, f.cfg).ServeHTTP(rec, req)
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
	ScheduleHandler(token, f.cfg).ServeHTTP(rec, req)
	return rec
}

// TestBuildRescheduleMovesTheStartTime: the user changed their mind about when.
// The state, the crontab pair and the idea's stamp all have to land on the new
// time — a build whose card still advertises the old one would have the phone
// telling the user something the server no longer believes.
func TestBuildRescheduleMovesTheStartTime(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	was := time.Now().Add(2 * time.Hour).UTC().Round(time.Minute)
	now := time.Now().Add(30 * time.Hour).UTC().Round(time.Minute)
	f.writeState(t, State{Status: statusScheduled, StartAt: was.Format(time.RFC3339)})

	rec := f.scheduleReq(t, token, now)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	var got Response
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != statusScheduled || got.StartAt != now.Format(time.RFC3339) {
		t.Fatalf("response = %q at %q, want %q at %q", got.Status, got.StartAt, statusScheduled, now.Format(time.RFC3339))
	}
	st, _ := loadState(f.cfg.buildDir(f.slug))
	if st.StartAt != now.Format(time.RFC3339) {
		t.Fatalf("state start_at = %q, want %q", st.StartAt, now.Format(time.RFC3339))
	}
	if strings.Contains(ct.content, cron.LineAt(f.root, f.slug, was)) {
		t.Fatalf("the old exact-minute line survived:\n%s", ct.content)
	}
	if !strings.Contains(ct.content, cron.LineAt(f.root, f.slug, now)) {
		t.Fatalf("the new exact-minute line was not installed:\n%s", ct.content)
	}
	if !strings.Contains(ct.content, "*/30 * * * *") {
		t.Fatalf("the recurring safety net was dropped:\n%s", ct.content)
	}
	card, ok := store.LoadCard(f.mcpDir, f.source, "idea-4f2a")
	if !ok {
		t.Fatal("idea card vanished")
	}
	stamp, _ := card.Payload["build"].(map[string]any)
	if stamp["start_at"] != now.Format(time.RFC3339) {
		t.Fatalf("idea stamp = %+v, want the new start time", stamp)
	}
	if f.cfg.Reg.Get(sessionID(f.slug, 0)) != nil {
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
			ct := &fakeCrontab{}
			f.cfg.Cron = ct.io()
			was := time.Now().Add(9 * time.Hour).UTC().Round(time.Minute)
			f.writeState(t, State{Status: statusScheduled, StartAt: was.Format(time.RFC3339)})
			// Pre-registered so the immediate path doesn't actually spawn an agent —
			// the transition is the assertion, not the run.
			f.cfg.Reg.FindOrCreateForRun(sessionID(f.slug, 0), session.KindBuild)

			var at time.Time
			if when != 0 {
				at = time.Now().Add(when).UTC()
			}
			rec := f.scheduleReq(t, token, at)
			if rec.Code != http.StatusOK {
				t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
			}
			st, _ := loadState(f.cfg.buildDir(f.slug))
			if st.Status != statusPlanning {
				t.Fatalf("status = %q, want %q", st.Status, statusPlanning)
			}
			if st.StartAt != "" {
				t.Fatalf("start_at = %q, want it spent", st.StartAt)
			}
			// The dated line has done its job and must not be left to come back
			// around in a year.
			if strings.Contains(ct.content, cron.LineAt(f.root, f.slug, was)) {
				t.Fatalf("the dated line survived the start:\n%s", ct.content)
			}
			if !strings.Contains(ct.content, "*/30 * * * *") {
				t.Fatalf("the recurring line was not left behind:\n%s", ct.content)
			}
		})
	}
}

// TestBuildRescheduleRefusesAStartedBuild: a build with no next run to place has
// no start time to move. Planning and building are already running; done and
// halted have nothing left to run. (awaiting-validation is the exception — it is
// parked on a step with a next feature behind it, and gets its own tests below.)
func TestBuildRescheduleRefusesAStartedBuild(t *testing.T) {
	const token = "secret"
	for _, status := range []string{statusPlanning, statusBuilding, statusDone, statusHalted} {
		t.Run(status, func(t *testing.T) {
			f := newBuildFixture(t)
			f.writeState(t, State{Status: status, Feature: 1})
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
	f.writeState(t, State{
		Status:  statusScheduled,
		StartAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
	})
	req := httptest.NewRequest(http.MethodPost, "/build/schedule",
		strings.NewReader(`{"slug":"greenhouse-tracker","start_at":"saturday-ish"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	ScheduleHandler(token, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d (%s), want 400", rec.Code, rec.Body.String())
	}
}

// TestBuildReviseRunsAndGatesAgain is the whole point of a step being something
// you can talk to: "nearly, but the header is wrong" has to reach the agent that
// built it, and land the user back at the same decision afterwards — not at the
// next feature, and not at a build that has quietly moved on.
func TestBuildReviseRunsAndGatesAgain(t *testing.T) {
	const token = "secret"
	stubClaude(t)
	f := newBuildFixture(t)
	f.writePlan(t, "## Feature 1: A\nx\n\n## Feature 2: B\ny\n")
	gate := f.awaitingAStep(t, 1)
	// Signed off and scheduled — then thought better of. Both have to come undone,
	// or a tick would build feature 2 on top of a feature being revised.
	if _, ok := store.UpdateCard(f.mcpDir, f.source, gate, func(c *store.Card) { c.Done = true }); !ok {
		t.Fatal("could not validate the step")
	}
	f.writeState(t, State{
		Status: statusAwaiting, Feature: 1, GateCardID: gate,
		StartAt: time.Now().Add(4 * time.Hour).UTC().Format(time.RFC3339),
	})

	rec := f.reviseReq(t, token, "The header is the wrong colour — make it match the plan.")
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	var got Response
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != statusBuilding || got.Feature != 1 {
		t.Fatalf("response = %q feature %d, want building feature 1", got.Status, got.Feature)
	}
	if got.StartAt != "" {
		t.Fatalf("start_at = %q, want the pending next feature withdrawn", got.StartAt)
	}
	if card, _ := store.LoadCard(f.mcpDir, f.source, gate); card.Done {
		t.Fatal("the step is still signed off while it is being revised")
	}

	// The run is real (a stub `claude`), so wait for the re-gate its callback does.
	deadline := time.Now().Add(30 * time.Second)
	var st State
	for time.Now().Before(deadline) {
		st, _ = loadState(f.cfg.buildDir(f.slug))
		if st.Status == statusAwaiting {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if st.Status != statusAwaiting || st.Feature != 1 {
		t.Fatalf("state after the revision = %q feature %d, want it back at the same step", st.Status, st.Feature)
	}
	if !strings.Contains(st.Note, "revised at your request") {
		t.Fatalf("note = %q, want it to say the revision landed", st.Note)
	}
	// Back to an open decision on the same card, not a new one.
	card, ok := store.LoadCard(f.mcpDir, f.source, gate)
	if !ok || card.Done || card.Dismissed {
		t.Fatalf("step card = %+v, want it asking again", card)
	}
}

// TestBuildReviseRefusesWhenNothingIsPaused: revising means editing a tree an
// agent may be working in. Outside the gate there is either a run in flight or
// nothing paused to talk about, and either way a second agent in that directory is
// the one thing the whole design refuses.
func TestBuildReviseRefusesWhenNothingIsPaused(t *testing.T) {
	const token = "secret"
	for _, status := range []string{statusScheduled, statusPlanning, statusBuilding, statusDone, statusHalted} {
		t.Run(status, func(t *testing.T) {
			f := newBuildFixture(t)
			f.writeState(t, State{Status: status, Feature: 1, GateCardID: gateCardID(f.slug, 1)})
			rec := f.reviseReq(t, token, "make the header blue")
			if rec.Code != http.StatusConflict {
				t.Fatalf("got %d (%s), want 409", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestBuildReviseRefusesAnEmptyNote: an empty box is not an instruction, and
// sending one would spend a run asking an agent to do nothing in particular.
func TestBuildReviseRefusesAnEmptyNote(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	f.awaitingAStep(t, 1)
	rec := f.reviseReq(t, token, "   \n ")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d (%s), want 400", rec.Code, rec.Body.String())
	}
}

// TestBuildReviseRefusesASecondRun: the gate is the only quiet moment in a build,
// and two revisions racing would put two agents in one working tree.
func TestBuildReviseRefusesASecondRun(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	f.awaitingAStep(t, 1)
	// A registered session whose process hasn't exited — what a live run leaves.
	f.cfg.Reg.FindOrCreateForRun(sessionID(f.slug, 1), session.KindBuild)

	rec := f.reviseReq(t, token, "one more thing")
	if rec.Code != http.StatusConflict {
		t.Fatalf("got %d (%s), want 409", rec.Code, rec.Body.String())
	}
	st, _ := loadState(f.cfg.buildDir(f.slug))
	if st.Status != statusAwaiting {
		t.Fatalf("status = %q, want the refused revision to have changed nothing", st.Status)
	}
}

// ---------------------------------------------------------------------------
// Scheduling the next feature
// ---------------------------------------------------------------------------

// awaitingAStep parks the fixture's build on a step card the user hasn't answered
// yet — the state the idea page offers "build the next feature" from.
func (f *buildFixture) awaitingAStep(t *testing.T, feature int) string {
	t.Helper()
	gate := gateCardID(f.slug, feature)
	f.writeState(t, State{Status: statusAwaiting, Feature: feature, GateCardID: gate})
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{
		ID: gate, Kind: cardKind, Priority: "high", Title: "Validate: feature 1",
		Body: "Feature 1 of **greenhouse-tracker** is built and waiting on you.",
	}); err != nil {
		t.Fatal(err)
	}
	return gate
}

// TestBuildScheduleNextFeatureAtATime: picking a time on a step card is how the
// user says "yes, and build the next one then". Both halves have to land — the
// step marked validated, and the minute cron will act on — because either alone
// is a build that stops: a validated step with no line never starts feature 2, and
// a line with no validation ticks into a gate that is still closed.
func TestBuildScheduleNextFeatureAtATime(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	if err := cron.InstallLine(ct.io(), f.slug, cron.LineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	f.writePlan(t, "## Feature 1: A\nx\n\n## Feature 2: B\ny\n")
	gate := f.awaitingAStep(t, 1)
	at := time.Now().Add(5 * time.Hour).UTC().Round(time.Minute)

	rec := f.scheduleReq(t, token, at)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	var got Response
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != statusAwaiting || got.StartAt != at.Format(time.RFC3339) {
		t.Fatalf("response = %q at %q, want %q at %q",
			got.Status, got.StartAt, statusAwaiting, at.Format(time.RFC3339))
	}
	if card, _ := store.LoadCard(f.mcpDir, f.source, gate); !card.Done {
		t.Fatal("the step was not validated, so the time would come round on a closed gate")
	}
	if !strings.Contains(ct.content, cron.LineAt(f.root, f.slug, at)) {
		t.Fatalf("no exact-minute line for the next feature:\n%s", ct.content)
	}
	if !strings.Contains(ct.content, "*/30 * * * *") {
		t.Fatalf("the recurring safety net was dropped:\n%s", ct.content)
	}
	// Both cards say the same thing, so the page reads right whichever one the user
	// opened — the step they were looking at, or the idea behind it.
	for _, id := range []string{gate, "idea-4f2a"} {
		card, ok := store.LoadCard(f.mcpDir, f.source, id)
		if !ok {
			t.Fatalf("card %s vanished", id)
		}
		stamp, _ := card.Payload["build"].(map[string]any)
		if stamp == nil || stamp["status"] != statusAwaiting || stamp["start_at"] != at.Format(time.RFC3339) {
			t.Fatalf("%s stamp = %+v, want awaiting at %s", id, stamp, at.Format(time.RFC3339))
		}
	}
	if f.cfg.Reg.Get(sessionID(f.slug, 2)) != nil {
		t.Fatal("scheduling the next feature started it")
	}
}

// TestBuildScheduleNextFeatureNowStartsIt: "Now" is the picker's default, and it
// has to mean the same here as everywhere else — the next feature starts on this
// request rather than at the next half-hourly tick.
func TestBuildScheduleNextFeatureNowStartsIt(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	f.writePlan(t, "## Feature 1: A\nx\n\n## Feature 2: B\ny\n")
	gate := f.awaitingAStep(t, 1)
	// Pre-registered so the transition is asserted without spawning an agent.
	f.cfg.Reg.FindOrCreateForRun(sessionID(f.slug, 2), session.KindBuild)

	rec := f.scheduleReq(t, token, time.Time{})
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	st, _ := loadState(f.cfg.buildDir(f.slug))
	if st.Status != statusBuilding || st.Feature != 2 {
		t.Fatalf("state = %q feature %d, want building feature 2", st.Status, st.Feature)
	}
	if st.StartAt != "" {
		t.Fatalf("start_at = %q, want nothing pending", st.StartAt)
	}
	if card, _ := store.LoadCard(f.mcpDir, f.source, gate); !card.Done {
		t.Fatal("the step was not validated")
	}
	// The step the build has moved past keeps its place on the dashboard, and its
	// stamp follows the build rather than freezing on the state it was settled from
	// — a settled step still advertising "awaiting, due at 21:00" would have the
	// page offering to schedule a feature that is already running.
	card, _ := store.LoadCard(f.mcpDir, f.source, gate)
	if card.Dismissed {
		t.Fatal("starting the next feature dismissed the step before it")
	}
	if !strings.HasPrefix(card.Body, "> Validated. The build has moved on to feature 2.") {
		t.Fatalf("step card body = %q, want the outcome quoted at the top", card.Body)
	}
	stamp, _ := card.Payload["build"].(map[string]any)
	if stamp == nil || stamp["status"] != statusBuilding || stamp["start_at"] != nil {
		t.Fatalf("step card stamp = %+v, want building with nothing pending", stamp)
	}
}

// TestBuildScheduleRefusesARejectedStep: dismissing a step card rejects the
// feature and stops the build. Scheduling the next one off that same card would
// resurrect a build the user just turned down — and would answer the phone with a
// start time nothing will ever honour.
func TestBuildScheduleRefusesARejectedStep(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	gate := f.awaitingAStep(t, 1)
	if _, ok := store.UpdateCard(f.mcpDir, f.source, gate, func(c *store.Card) { c.Dismissed = true }); !ok {
		t.Fatal("could not dismiss the step card")
	}
	rec := f.scheduleReq(t, token, time.Now().Add(3*time.Hour))
	if rec.Code != http.StatusConflict {
		t.Fatalf("got %d (%s), want 409", rec.Code, rec.Body.String())
	}
	st, _ := loadState(f.cfg.buildDir(f.slug))
	if st.StartAt != "" {
		t.Fatalf("start_at = %q, want the refusal to have changed nothing", st.StartAt)
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
// Resuming a stopped build
// ---------------------------------------------------------------------------

func (f *buildFixture) resumeReq(t *testing.T, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/build/resume",
		strings.NewReader(fmt.Sprintf(`{"slug":%q}`, f.slug)))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	ResumeHandler(token, f.cfg).ServeHTTP(rec, req)
	return rec
}

// TestBuildResumePutsTheBuildBackAtItsStep walks the whole round trip a user
// makes when they change their mind about stopping: stop a build parked on a
// step, then resume it. Everything the stop took away has to come back — the
// status, the crontab line, and above all the step card's question — because a
// resumed build that ticks into a settled card just halts again.
func TestBuildResumePutsTheBuildBackAtItsStep(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	if err := cron.InstallLine(ct.io(), f.slug, cron.LineFor(f.root, f.slug)); err != nil {
		t.Fatal(err)
	}
	f.writePlan(t, "## Feature 1: A\nx\n\n## Feature 2: B\ny\n")
	gate := f.awaitingAStep(t, 1)

	req := httptest.NewRequest(http.MethodPost, "/build/stop", strings.NewReader(`{"slug":"greenhouse-tracker"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	StopHandler(token, f.cfg).ServeHTTP(httptest.NewRecorder(), req)
	if st, _ := loadState(f.cfg.buildDir(f.slug)); st.Status != statusHalted {
		t.Fatalf("status after the stop = %q, want %q", st.Status, statusHalted)
	}

	rec := f.resumeReq(t, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	var got Response
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != statusAwaiting || got.Feature != 1 {
		t.Fatalf("response = %q at feature %d, want %q at feature 1", got.Status, got.Feature, statusAwaiting)
	}
	if got.StartAt != "" {
		t.Fatalf("start_at = %q, want the next run left for the user to place", got.StartAt)
	}
	st, _ := loadState(f.cfg.buildDir(f.slug))
	if st.Status != statusAwaiting {
		t.Fatalf("state = %+v, want %q", st, statusAwaiting)
	}
	if !strings.Contains(ct.content, marker(f.slug)) {
		t.Fatalf("a resumed build has no crontab line, so nothing will ever carry it on:\n%s", ct.content)
	}
	// The card is the whole approve/reject loop, so this is the assertion that
	// matters most: it has to be asking again, not sitting settled at the bottom
	// of the list with a "this build was stopped" line on it.
	card, ok := store.LoadCard(f.mcpDir, f.source, gate)
	if !ok {
		t.Fatal("the step card vanished")
	}
	if card.Dismissed || card.Done {
		t.Fatalf("step card = done %v / dismissed %v, want it asking again", card.Done, card.Dismissed)
	}
	if card.Priority != "high" {
		t.Fatalf("step card priority = %q, want it back among the decisions waiting", card.Priority)
	}
	if strings.HasPrefix(strings.TrimSpace(card.Body), ">") {
		t.Fatalf("the step card still leads with the stop's outcome:\n%s", card.Body)
	}
	stamp, _ := card.Payload["build"].(map[string]any)
	if stamp == nil || stamp["status"] != statusAwaiting {
		t.Fatalf("step card build stamp = %+v, want status %q", stamp, statusAwaiting)
	}
	// And the tick agrees: a resumed build waits on the user rather than halting
	// on the card the stop left behind.
	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "wait" {
		t.Fatalf("tick after resuming = %+v, want it waiting on the user", res)
	}
}

// TestBuildResumeAfterARejectedFeature: rejecting a feature is the other way a
// build halts, and it halts *because* the step card was dismissed. Resuming has
// to undo that dismissal, or the build comes back only to be stopped again by the
// very next tick reading the same no.
func TestBuildResumeAfterARejectedFeature(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	ct := &fakeCrontab{}
	f.cfg.Cron = ct.io()
	f.writePlan(t, "## Feature 1: A\nx\n\n## Feature 2: B\ny\n")
	gate := gateCardID(f.slug, 2)
	f.writeState(t, State{Status: statusHalted, Feature: 2, GateCardID: gate, Note: "feature 2 was rejected"})
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{
		ID: gate, Kind: cardKind, Priority: "low", Title: "Greenhouse tracker",
		Body: "> This build was stopped — feature 2 was rejected.\n\nFeature 2 is built.",
		// Dismissing IS the rejection, and the file stays on disk afterwards.
		Dismissed: true,
	}); err != nil {
		t.Fatal(err)
	}

	if rec := f.resumeReq(t, token); rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	card, ok := store.LoadCard(f.mcpDir, f.source, gate)
	if !ok {
		t.Fatal("the step card vanished")
	}
	if card.Dismissed {
		t.Fatal("the rejection survived the resume, so the next tick will halt the build again")
	}
	res, err := f.cfg.tick(f.slug, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != "wait" {
		t.Fatalf("tick after resuming a rejection = %+v, want it waiting on the user", res)
	}
}

// TestBuildResumeRefusesAnythingButAStop: resume is the counterpart of halt and
// nothing else. A live build has nothing to resume, and a done one has no step
// left to go back to — "build more" there is a new plan's job, not this one's.
func TestBuildResumeRefusesAnythingButAStop(t *testing.T) {
	const token = "secret"
	for _, status := range []string{statusScheduled, statusPlanning, statusBuilding, statusAwaiting, statusDone} {
		t.Run(status, func(t *testing.T) {
			f := newBuildFixture(t)
			f.writeState(t, State{Status: status, Feature: 1, GateCardID: gateCardID(f.slug, 1)})
			if rec := f.resumeReq(t, token); rec.Code != http.StatusConflict {
				t.Fatalf("got %d (%s), want 409", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestBuildResumeRefusesABuildThatNeverBuiltAnything: a build halted while still
// scheduled — or by a planning run that left no usable plan — has no step card to
// reopen. Its idea is unlocked and still on the dashboard, so the honest answer is
// "start it again", not a build parked at feature 0 that no tick can advance.
func TestBuildResumeRefusesABuildThatNeverBuiltAnything(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	f.writeState(t, State{Status: statusHalted, Feature: 0, Note: "the planning run ended without leaving a usable plan"})
	if rec := f.resumeReq(t, token); rec.Code != http.StatusConflict {
		t.Fatalf("got %d (%s), want 409", rec.Code, rec.Body.String())
	}
}

// TestBuildResumeUnknownProject: nothing to pick back up.
func TestBuildResumeUnknownProject(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	if rec := f.resumeReq(t, token); rec.Code != http.StatusNotFound {
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
		call func(cfg Config) *httptest.ResponseRecorder
	}{
		{"GET /build", func(cfg Config) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodGet, "/build?slug=greenhouse-tracker", nil)
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			StateHandler(token, cfg).ServeHTTP(rec, req)
			return rec
		}},
		{"POST /build/start", func(cfg Config) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPost, "/build/start",
				strings.NewReader(`{"card_id":"idea-4f2a","source":"greenhouse","project":"Greenhouse Tracker"}`))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			StartHandler(token, cfg).ServeHTTP(rec, req)
			return rec
		}},
		{"POST /build/schedule", func(cfg Config) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPost, "/build/schedule",
				strings.NewReader(`{"slug":"greenhouse-tracker","start_at":"2030-01-01T09:00:00Z"}`))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			ScheduleHandler(token, cfg).ServeHTTP(rec, req)
			return rec
		}},
		{"POST /build/revise", func(cfg Config) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPost, "/build/revise",
				strings.NewReader(`{"slug":"greenhouse-tracker","note":"the header colour is wrong"}`))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			ReviseHandler(token, cfg).ServeHTTP(rec, req)
			return rec
		}},
		{"POST /build/stop", func(cfg Config) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPost, "/build/stop", strings.NewReader(`{"slug":"greenhouse-tracker"}`))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			StopHandler(token, cfg).ServeHTTP(rec, req)
			return rec
		}},
		{"POST /build/resume", func(cfg Config) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPost, "/build/resume", strings.NewReader(`{"slug":"greenhouse-tracker"}`))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			ResumeHandler(token, cfg).ServeHTTP(rec, req)
			return rec
		}},
		{"POST /build/tick", func(cfg Config) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodPost, "/build/tick", strings.NewReader(`{"slug":"greenhouse-tracker"}`))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			TickHandler(token, cfg).ServeHTTP(rec, req)
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
				f.writeState(t, State{Status: statusAwaiting, Feature: 1})
				cfg := f.cfg
				cfg.Enabled = g.allowCode && g.allowExec
				if !g.withRoot {
					cfg.Root = ""
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
		f.writeState(t, State{Status: statusAwaiting, Feature: 1})
		rec := endpoints[0].call(f.cfg)
		if rec.Code != http.StatusOK {
			t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
		}
		var got Response
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
		StateHandler(token, f.cfg).ServeHTTP(rec, req)
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
	f.writeState(t, State{Status: statusBuilding, Feature: 1})

	req := httptest.NewRequest(http.MethodPost, "/build/start",
		strings.NewReader(`{"card_id":"idea-4f2a","source":"greenhouse","project":"Greenhouse Tracker"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	StartHandler(token, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("got %d (%s), want 409", rec.Code, rec.Body.String())
	}
}
