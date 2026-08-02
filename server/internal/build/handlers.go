package build

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"nestnote/server/internal/cron"
	"nestnote/server/internal/httpx"
	"nestnote/server/internal/project"
	"nestnote/server/internal/session"
	"nestnote/server/internal/store"
)

type startRequest struct {
	CardID  string `json:"card_id"`
	Source  string `json:"source"`
	Project string `json:"project"`
	// StartAt is when the user wants the build to begin, RFC3339. Empty — or a time
	// that has effectively already arrived — means now, which is the default the
	// phone offers and by far the common case.
	StartAt string `json:"start_at,omitempty"`
}

// startSoon is how near a requested start has to be to simply be "now". It
// absorbs the clock skew between a phone and the server, and stops a start time
// a few seconds out from pinning a crontab entry that would fire before the
// crontab write had even settled. A constant, not a flag: it's a property of
// clocks, not of the machine this runs on.
const startSoon = 90 * time.Second

// Response is the shape /build, /build/start and /build/stop all answer with,
// so the phone parses one thing.
type Response struct {
	State
	Project string `json:"project"` // absolute project dir, for the "where is it" line
	// Overview is the plan's Overview section — the idea this project came from, in
	// the user's own words. The phone shows it above the features, which is where
	// the idea is read now that its card has come off the dashboard.
	Overview string        `json:"overview,omitempty"`
	Features []PlanFeature `json:"features"` // the parsed plan, statuses stamped
	Session  string        `json:"session"`  // session id to watch this build's current run on /code
}

func (cfg Config) response(slug string, st State) Response {
	projectDir := filepath.Join(cfg.ProjectsBase, slug)
	return Response{
		State:    st,
		Project:  projectDir,
		Overview: parsePlanOverview(readPlanDoc(projectDir)),
		Features: readPlan(projectDir, st),
		Session:  sessionID(slug, st.Feature),
	}
}

// StartHandler turns an idea card into a project folder with a plan, and arms the
// cron line that will build it.
//
// The planning run happens on the durable-session machinery the rest of the
// server uses, so the phone can watch the plan being written with the /code
// transcript UI it already has, and so a dropped socket doesn't kill it.
func StartHandler(token string, cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !cfg.gate(w, r, token) {
			return
		}
		var req startRequest
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		name := strings.TrimSpace(req.Project)
		if name == "" {
			http.Error(w, "empty project name", http.StatusBadRequest)
			return
		}
		if !store.ValidSlug(req.CardID) || !store.ValidSlug(req.Source) {
			http.Error(w, "bad card", http.StatusBadRequest)
			return
		}
		// A start far enough ahead to be worth waiting for; anything nearer takes the
		// immediate path. Zero means "now".
		var startAt time.Time
		if s := strings.TrimSpace(req.StartAt); s != "" {
			t, perr := time.Parse(time.RFC3339, s)
			if perr != nil {
				http.Error(w, "bad start time", http.StatusBadRequest)
				return
			}
			if time.Until(t) > startSoon {
				startAt = t
			}
		}
		mcpDir, _ := store.RootDirs(cfg.Root)
		idea, ok := store.LoadCard(mcpDir, req.Source, req.CardID)
		if !ok {
			http.Error(w, "card not found", http.StatusNotFound)
			return
		}

		projectDir, slug, err := project.ResolveDir(cfg.ProjectsBase, name)
		if err != nil {
			http.Error(w, "bad project name", http.StatusBadRequest)
			return
		}
		dir := cfg.buildDir(slug)
		if existing, ok := loadState(dir); ok && activeStatus(existing.Status) {
			// Two builds in one folder would have two agents editing the same tree.
			http.Error(w, "that project already has a build running", http.StatusConflict)
			return
		}

		st := State{
			Slug:   slug,
			CardID: req.CardID,
			Source: req.Source,
			// Captured now, while the idea is certainly still on the dashboard: from
			// the first step card onwards this is the only name the build has for it.
			Idea:    strings.TrimSpace(idea.Title),
			Status:  statusPlanning,
			Feature: 0,
			LastRun: store.NowStamp(),
		}
		if !startAt.IsZero() {
			// Nothing has run and nothing will until the start time, so the build
			// waits in `scheduled` with no last-run to report. The idea stays the
			// user's to keep editing until then — the plan hasn't been written from
			// it yet.
			st.Status = statusScheduled
			st.StartAt = startAt.UTC().Format(time.RFC3339)
			st.LastRun = ""
		}
		if err := saveState(dir, st); err != nil {
			http.Error(w, "could not create the build", http.StatusInternalServerError)
			return
		}
		if err := ensureGitignore(projectDir); err != nil {
			log.Printf("build: %s gitignore: %v", slug, err)
		}
		if err := seedProjectClaudeMD(projectDir, idea.Title); err != nil {
			log.Printf("build: %s CLAUDE.md: %v", slug, err)
		}
		// The driver is rewritten on every start, so a server upgrade patches the
		// one copy every project's crontab line already points at.
		if err := cron.WriteTickDriver(cfg.Root, cfg.StateDir, cfg.ListenAddr); err != nil {
			http.Error(w, "could not write the tick driver: "+err.Error(), http.StatusInternalServerError)
			return
		}
		// A scheduled build takes its exact-minute line and the recurring one; an
		// immediate build just the recurring one.
		line := cron.LineFor(cfg.Root, slug)
		if !startAt.IsZero() {
			line = cron.ScheduledLines(cfg.Root, slug, startAt)
		}
		if err := cron.InstallLine(cfg.Cron, slug, line); err != nil {
			// Without cron this build would never advance past its first gate — and a
			// scheduled one would never start at all — with no way for the user to
			// tell. Fail loudly and leave the folder.
			http.Error(w, "could not schedule the build: "+err.Error(), http.StatusInternalServerError)
			return
		}
		stampIdeaCard(mcpDir, st)

		if startAt.IsZero() {
			if _, perr := cfg.startPlanning(dir, projectDir, mcpDir, st, false); perr != nil {
				log.Printf("build: %s planning: %v", slug, perr)
			}
			// startPlanning owns the transition, so answer with what it left on disk
			// rather than the state assembled up here.
			if fresh, ok := loadState(dir); ok {
				st = fresh
			}
			log.Printf("build: started %s from card %s/%s", slug, req.Source, req.CardID)
		} else {
			log.Printf("build: scheduled %s from card %s/%s for %s", slug, req.Source, req.CardID, st.StartAt)
		}
		httpx.WriteJSON(w, cfg.response(slug, st))
	}
}

// scheduleRequest sets when a build's next run happens.
type scheduleRequest struct {
	Slug string `json:"slug"`
	// StartAt is the new start, RFC3339. Absent — or near enough to now to be
	// indistinguishable from it — means "start it now", the same choice the
	// picker offers on /build/start, so it has to mean the same thing here.
	StartAt string `json:"start_at,omitempty"`
}

// ScheduleHandler says when a build's next run happens. Two states can answer
// that question, and it is the same question in both:
//
//   - `scheduled` — the first run. Nothing has been planned from the idea yet, so
//     moving the time changes only which minute cron fires at.
//   - `awaiting-validation` — the next feature. The build is parked at a step card
//     waiting on the user, and picking a time here is how they say "yes, and build
//     the next one then". It validates the step on the way past: choosing when the
//     next feature runs is an acceptance of the one that just did, and making the
//     user also tick the card off on the dashboard would be asking twice.
//
// Every other status has no next run to place: planning and building are already
// running, and done and halted have nothing left to run. Those answer 409.
func ScheduleHandler(token string, cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !cfg.gate(w, r, token) {
			return
		}
		var req scheduleRequest
		if json.NewDecoder(r.Body).Decode(&req) != nil || !store.ValidSlug(req.Slug) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		// The same tolerance /build/start applies, so "now" means now whichever
		// door it arrives through.
		var startAt time.Time
		if s := strings.TrimSpace(req.StartAt); s != "" {
			t, perr := time.Parse(time.RFC3339, s)
			if perr != nil {
				http.Error(w, "bad start time", http.StatusBadRequest)
				return
			}
			if time.Until(t) > startSoon {
				startAt = t
			}
		}
		dir := cfg.buildDir(req.Slug)
		st, ok := loadState(dir)
		if !ok {
			http.Error(w, "no build for that project", http.StatusNotFound)
			return
		}
		if st.Status != statusScheduled && st.Status != statusAwaiting {
			http.Error(w, "that build has no next run to schedule", http.StatusConflict)
			return
		}
		mcpDir, _ := store.RootDirs(cfg.Root)

		if st.Status == statusAwaiting {
			cfg.scheduleNextFeature(w, dir, mcpDir, st, startAt)
			return
		}

		if startAt.IsZero() {
			// Brought forward to now. This is precisely the transition a due tick
			// makes, so take that path rather than keep a second copy of it: same
			// cron collapse, same lock landing on the idea, same planning run the
			// phone can watch.
			projectDir := filepath.Join(cfg.ProjectsBase, req.Slug)
			if _, perr := cfg.startPlanning(dir, projectDir, mcpDir, st, false); perr != nil {
				log.Printf("build: %s planning: %v", req.Slug, perr)
			}
			if fresh, ok := loadState(dir); ok {
				st = fresh
			}
			log.Printf("build: %s brought forward to now", req.Slug)
			httpx.WriteJSON(w, cfg.response(req.Slug, st))
			return
		}

		// State before crontab, deliberately. The tick checks the clock against
		// StartAt on disk, so the saved time is what actually gates the start: if
		// the crontab write then fails, the worst case is a build that starts late
		// off the recurring line, never one that starts earlier than was just
		// asked for — with the idea still being edited.
		st.StartAt = startAt.UTC().Format(time.RFC3339)
		if err := saveState(dir, st); err != nil {
			http.Error(w, "could not save the new start time", http.StatusInternalServerError)
			return
		}
		if err := cron.InstallLine(cfg.Cron, req.Slug, cron.ScheduledLines(cfg.Root, req.Slug, startAt)); err != nil {
			http.Error(w, "could not reschedule the build: "+err.Error(), http.StatusInternalServerError)
			return
		}
		stampIdeaCard(mcpDir, st)
		log.Printf("build: rescheduled %s for %s", req.Slug, st.StartAt)
		httpx.WriteJSON(w, cfg.response(req.Slug, st))
	}
}

// scheduleNextFeature validates the step the build is parked on and places the
// next feature's run — now, or at the minute the user picked.
//
// Validation goes through the step card's own `done` flag rather than straight
// into the state machine, so this stays the same approve path the dashboard's
// complete button uses: one field, read by one tick. Nothing here decides that
// the next feature may start — the tick does, exactly as it would have if the
// card had been ticked off on the dashboard.
func (cfg Config) scheduleNextFeature(w http.ResponseWriter, dir, mcpDir string, st State, startAt time.Time) {
	if st.GateCardID == "" || !store.ValidSlug(st.GateCardID) {
		http.Error(w, "that build has no step waiting to be validated", http.StatusConflict)
		return
	}
	card, found := store.LoadCard(mcpDir, st.Source, st.GateCardID)
	if !found || card.Dismissed {
		// The step was rejected or deleted, so the build is on its way to halted and
		// there is no next feature to place. The next tick makes that final; saying
		// so here stops the phone from believing it just scheduled one.
		http.Error(w, "that step was rejected, so this build is stopping", http.StatusConflict)
		return
	}

	// State before crontab, as everywhere else: the tick reads StartAt off disk, so
	// a failed crontab write can only make the next feature start late off the
	// recurring line, never earlier than was just asked for.
	st.StartAt = ""
	if !startAt.IsZero() {
		st.StartAt = startAt.UTC().Format(time.RFC3339)
	}
	if err := saveState(dir, st); err != nil {
		http.Error(w, "could not save the new start time", http.StatusInternalServerError)
		return
	}
	if _, ok := store.UpdateCard(mcpDir, st.Source, st.GateCardID, func(c *store.Card) { c.Done = true }); !ok {
		http.Error(w, "could not validate that step", http.StatusInternalServerError)
		return
	}

	if !startAt.IsZero() {
		if err := cron.InstallLine(cfg.Cron, st.Slug, cron.ScheduledLines(cfg.Root, st.Slug, startAt)); err != nil {
			http.Error(w, "could not schedule the next feature: "+err.Error(), http.StatusInternalServerError)
			return
		}
		stampIdeaCard(mcpDir, st)
		stampGateCard(mcpDir, st)
		log.Printf("build: %s feature %d validated; feature %d due %s",
			st.Slug, st.Feature, st.Feature+1, st.StartAt)
		httpx.WriteJSON(w, cfg.response(st.Slug, st))
		return
	}

	// Now. The tick is the one place a build moves forward, so hand it over rather
	// than start the feature from here: same recovery, same gate card handling, same
	// path the dashboard's complete button reaches half an hour later.
	if _, err := cfg.tick(st.Slug, false); err != nil {
		log.Printf("build: %s tick after validating feature %d: %v", st.Slug, st.Feature, err)
	}
	if fresh, ok := loadState(dir); ok {
		st = fresh
	}
	log.Printf("build: %s feature %d validated; next feature started", st.Slug, st.Feature)
	httpx.WriteJSON(w, cfg.response(st.Slug, st))
}

// reviseRequest is what the user typed on a step card: a change they want made to
// the feature they were just shown, before they'll sign it off.
type reviseRequest struct {
	Slug string `json:"slug"`
	Note string `json:"note"`
}

// reviseNoteMax bounds what one message can carry. It is generous — several
// paragraphs of "here's what's wrong with it" — and exists only so a runaway
// client can't hand an unbounded argv to a process. A constant, not a flag: it's a
// property of the prompt, not of the machine.
const reviseNoteMax = 4000

// ReviseHandler takes the user's word back into the project: it starts a run in
// the project directory that does what they asked, then lands them back at the
// same step to decide again.
//
// This is what keeps a build step a conversation rather than a yes/no. Reviewing a
// built feature and being able to say only "yes" or "stop" is not review — most of
// what anyone actually wants to say is "nearly, but…", and the answer to that is
// the agent that built it, standing in the same directory it built it in. The same
// door takes "actually, the plan should change": the run is allowed to edit
// PROJECT_PLAN.md, because a plan the user has revised having *seen* something
// working is worth more than the one written before they had.
//
// Only from `awaiting-validation`. Everywhere else there is either a run already
// going (revising underneath it would have two agents in one tree) or nothing
// paused to talk about.
func ReviseHandler(token string, cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !cfg.gate(w, r, token) {
			return
		}
		var req reviseRequest
		if json.NewDecoder(r.Body).Decode(&req) != nil || !store.ValidSlug(req.Slug) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		note := strings.TrimSpace(req.Note)
		if note == "" {
			http.Error(w, "empty note", http.StatusBadRequest)
			return
		}
		if len(note) > reviseNoteMax {
			note = note[:reviseNoteMax]
		}
		dir := cfg.buildDir(req.Slug)
		st, ok := loadState(dir)
		if !ok {
			http.Error(w, "no build for that project", http.StatusNotFound)
			return
		}
		if st.Status != statusAwaiting {
			http.Error(w, "that build isn't paused at a step, so there is nothing to revise", http.StatusConflict)
			return
		}
		if cfg.runInFlight(req.Slug, st.Feature) {
			http.Error(w, "a run for this feature is already in flight", http.StatusConflict)
			return
		}
		mcpDir, _ := store.RootDirs(cfg.Root)
		projectDir := filepath.Join(cfg.ProjectsBase, req.Slug)
		if err := ensureGitignore(projectDir); err != nil {
			log.Printf("build: %s gitignore: %v", req.Slug, err)
		}

		st.Status = statusBuilding
		st.LastRun = store.NowStamp()
		st.Note = "revising feature " + strconv.Itoa(st.Feature) + ": " + shortNote(note)
		// Any time the user had put on the next feature is withdrawn with the sign-off
		// it came with — they've asked for changes to this one instead. The dated
		// crontab line can stay: it fires into a build that says "wait", which is what
		// every spent line does.
		st.StartAt = ""
		if err := saveState(dir, st); err != nil {
			http.Error(w, "could not start the revision", http.StatusInternalServerError)
			return
		}
		// A step being revised is not a step that was signed off, so the tick can't
		// read a stale yes off it and move on while the run is still going.
		_, _ = store.UpdateCard(mcpDir, st.Source, st.GateCardID, func(c *store.Card) { c.Done = false })
		stampIdeaCard(mcpDir, st)
		stampGateCard(mcpDir, st)

		// Same session id as the feature's own run, so the phone watches a revision
		// on /code exactly as it watches the build that produced it.
		sess, created := cfg.Reg.FindOrCreateForRun(sessionID(st.Slug, st.Feature), session.KindBuild)
		if !created {
			http.Error(w, "a run for this feature is already in flight", http.StatusConflict)
			return
		}
		logPath := filepath.Join(dir, "runs", fmt.Sprintf("%d-revise-%d.log", st.Feature, time.Now().Unix()))
		startProcess(sess, projectDir, logPath, revisionPrompt(st.Feature, note), cfg.RunTimeout, func(err error) {
			outcome := "revised at your request: " + shortNote(note)
			if err != nil {
				outcome = "the revision run reported: " + err.Error()
			}
			if gerr := cfg.gateFeature(dir, projectDir, mcpDir, st, outcome); gerr != nil {
				log.Printf("build: %s re-gate after revising feature %d: %v", st.Slug, st.Feature, gerr)
			}
		})
		log.Printf("build: %s revising feature %d", st.Slug, st.Feature)
		httpx.WriteJSON(w, cfg.response(req.Slug, st))
	}
}

// StateHandler answers GET /build?slug= with the build's state and its parsed
// plan — what the idea overlay's progress toggle renders.
func StateHandler(token string, cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !cfg.gate(w, r, token) {
			return
		}
		slug := r.URL.Query().Get("slug")
		if !store.ValidSlug(slug) {
			http.Error(w, "bad slug", http.StatusBadRequest)
			return
		}
		st, ok := loadState(cfg.buildDir(slug))
		if !ok {
			http.Error(w, "no build for that project", http.StatusNotFound)
			return
		}
		httpx.WriteJSON(w, cfg.response(slug, st))
	}
}

// StopHandler halts a build: the crontab line goes, the status goes to halted, and
// the idea card's lock clears so the user can talk about the idea again. Any run
// currently in flight is killed — a stop the user has to wait eight minutes for
// isn't a stop.
func StopHandler(token string, cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !cfg.gate(w, r, token) {
			return
		}
		var req struct {
			Slug string `json:"slug"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || !store.ValidSlug(req.Slug) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		dir := cfg.buildDir(req.Slug)
		st, ok := loadState(dir)
		if !ok {
			// No build state, but there may well still be a crontab line: the state
			// file lives in the project folder, so anything that removed .nestnote/
			// (or the folder's contents) by hand leaves the schedule armed and this
			// the only request that will ever ask about that slug. Sweep it, then
			// answer honestly that there was no build here.
			if err := cron.RemoveLine(cfg.Cron, req.Slug); err != nil {
				log.Printf("build: stop %s left its crontab line: %v", req.Slug, err)
			}
			http.Error(w, "no build for that project", http.StatusNotFound)
			return
		}
		mcpDir, _ := store.RootDirs(cfg.Root)
		// Not "from the idea page" any more: a build past its first feature has no
		// idea card left, and the stop that reaches here is as likely to have come
		// from one of its step pages.
		if err := cfg.stop(dir, mcpDir, st, "you called it off from the phone"); err != nil {
			http.Error(w, "could not stop the build", http.StatusInternalServerError)
			return
		}
		st, _ = loadState(dir)
		log.Printf("build: stopped %s", req.Slug)
		httpx.WriteJSON(w, cfg.response(req.Slug, st))
	}
}

// ResumeHandler is the way back from a stop. It puts a halted build back at the
// step it was on: the step card asks for its decision again, the crontab line goes
// back in, and the project carries on from the feature it reached.
//
// Stopping had no counterpart, which made it a much bigger decision than it looks
// — the only route back into a project whose build was stopped (or whose feature
// was rejected in a moment of impatience) was to write a fresh idea and let the
// planner start the whole thing again, over a folder that already had the code.
// Nothing about a halt actually destroys anything: the plan, the features and the
// step cards are all still on disk, so "carry on" is a state change and not a
// rebuild.
//
// It resumes into awaiting-validation rather than into a run, for the same reason
// every other door into this build waits: the state a stopped build is put back
// into is the one where the user decides what happens next. Nothing runs until
// they say when the next feature starts — which they do from the same step page,
// through the same picker as always.
//
// The step card is written again rather than un-settled field by field, because
// writeGateCard already *is* the definition of "this feature is waiting on you":
// body, priority and stamp, one copy of it, shared with the run that files it.
func ResumeHandler(token string, cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !cfg.gate(w, r, token) {
			return
		}
		var req struct {
			Slug string `json:"slug"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || !store.ValidSlug(req.Slug) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		dir := cfg.buildDir(req.Slug)
		st, ok := loadState(dir)
		if !ok {
			http.Error(w, "no build for that project", http.StatusNotFound)
			return
		}
		if st.Status != statusHalted {
			// Including done: a build that reached the end of its plan has no step
			// left to go back to, and "build more" there is a new plan's job.
			http.Error(w, "that build isn't stopped, so there is nothing to resume", http.StatusConflict)
			return
		}
		if st.Feature < firstFeature {
			// Halted before it ever built a feature — a planning run that left no
			// usable plan, or a stop while the build was still scheduled. There is no
			// step card to reopen, and re-running the planner over the idea is a new
			// build rather than a resumed one, so it goes through /build/start.
			http.Error(w, "that build stopped before it built anything, so there is no step to go back to", http.StatusConflict)
			return
		}
		mcpDir, _ := store.RootDirs(cfg.Root)
		projectDir := filepath.Join(cfg.ProjectsBase, req.Slug)
		// The same re-assertion every tick makes, for the same reason: this build has
		// been off the ticks for however long it was stopped, and the last run before
		// that may well have been the one that scaffolded a framework over .gitignore.
		if err := ensureGitignore(projectDir); err != nil {
			log.Printf("build: %s gitignore: %v", req.Slug, err)
		}

		st.Status = statusAwaiting
		// Whatever this build was waiting for when it stopped is long spent. The next
		// run is the user's to place from the step, exactly as it is after any other
		// feature lands.
		st.StartAt = ""
		st.Note = "picked back up — feature " + strconv.Itoa(st.Feature) + " is waiting on you again"
		if st.GateCardID == "" {
			// A build halted before step cards carried an id on the state, or one whose
			// id never landed. The id is derived from the slug and the feature, so it
			// is the same one the run would have used.
			st.GateCardID = gateCardID(st.Slug, st.Feature)
		}
		if err := saveState(dir, st); err != nil {
			http.Error(w, "could not resume the build", http.StatusInternalServerError)
			return
		}
		// The recurring line alone: nothing is due at a particular minute yet, and
		// this is the line that carries the build once the user completes the step
		// card from the dashboard rather than through the picker.
		if err := cron.InstallLine(cfg.Cron, req.Slug, cron.LineFor(cfg.Root, req.Slug)); err != nil {
			http.Error(w, "could not reschedule the build: "+err.Error(), http.StatusInternalServerError)
			return
		}
		var feat PlanFeature
		for _, f := range readPlan(projectDir, st) {
			if f.Num == st.Feature {
				feat = f
			}
		}
		if err := writeGateCard(mcpDir, st, feat, projectDir); err != nil {
			http.Error(w, "could not reopen that build step", http.StatusInternalServerError)
			return
		}
		stampIdeaCard(mcpDir, st)
		log.Printf("build: resumed %s at feature %d", req.Slug, st.Feature)
		httpx.WriteJSON(w, cfg.response(req.Slug, st))
	}
}

// TickHandler is what the cron driver pokes. It is authed like everything else —
// it starts an unattended agent run, so a bearer token and the same -allow-code +
// -allow-exec + -root gate apply — and localhost-only only by convention, never by
// trust.
//
// The reason the work happens HERE rather than in the driver is environment
// parity, and it is the failure mode most likely to sink this feature on first
// contact. /run's child inherits the server process's whole environment (cmd.Env
// stays nil) and runs under a login shell that has sourced the operator's profile.
// Cron's child gets PATH=/usr/bin:/bin, HOME, LOGNAME, SHELL and nothing else — no
// profile, so no nvm, no ~/.local/bin, and very likely no `claude` at all. A build
// driven from cron's own environment fails at the first command with a confusing
// "not found". Poking the server instead makes parity exact by construction: the
// agent is started by this process, with this process's environment, the same as
// every other run. It also means no env snapshot on disk duplicating API keys, and
// the phone can watch a scheduled build live through the session registry.
//
// The cost is that a tick fired while the server is down does nothing. That's
// acceptable: a build whose server is down can't post gate cards or be watched
// anyway, and the next tick picks it up.
func TickHandler(token string, cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !cfg.gate(w, r, token) {
			return
		}
		var req struct {
			Slug   string `json:"slug"`
			DryRun bool   `json:"dry_run"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		res, err := cfg.tick(req.Slug, req.DryRun)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		log.Printf("build: tick %s -> %s (%s)", req.Slug, res.Action, res.Detail)
		httpx.WriteJSON(w, res)
	}
}
