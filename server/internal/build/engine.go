package build

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"nestnote/server/internal/cron"
	"nestnote/server/internal/procio"
	"nestnote/server/internal/session"
	"nestnote/server/internal/store"
)

// ---------------------------------------------------------------------------
// Running a build step
// ---------------------------------------------------------------------------

// sessionID keys a build run in the session registry. Feature 0 is the planning
// run. The phone can watch either live by connecting to /code with resumeOnly and
// this id — the frames are byte-identical to a /code session's, so the existing
// transcript UI needs no changes.
func sessionID(slug string, feature int) string {
	if feature <= 0 {
		return fmt.Sprintf("build-%s-plan", slug)
	}
	return fmt.Sprintf("build-%s-%d", slug, feature)
}

// startProcess runs one unattended Claude turn in the project directory and
// calls done when it exits.
//
// It mirrors the /code agent's process — same bypassPermissions, same "cc" frames
// into a durable session so a watcher gets the live transcript — with two
// differences that matter for an unattended run:
//
//  1. One-shot. The prompt is an argv, not a stream-json stdin message, so Claude
//     exits when the turn ends. A /code session stays open waiting for the next
//     human prompt; a build step has no human, and needs a terminal event to hang
//     the gate card off.
//  2. Bounded. The run carries the server's -run-timeout ceiling, so a feature
//     that loops can't burn tokens until someone notices.
//
// Crucially the child inherits this process's environment (cmd.Env stays nil),
// exactly as /run and /exec's children do. That is the whole reason cron pokes
// the server instead of running the agent itself — see TickHandler.
func startProcess(sess *session.Session, dir, logPath, prompt string, timeout time.Duration, done func(error)) {
	ctx, cancelRun := context.WithTimeout(context.Background(), timeout)
	sess.SetCancel(cancelRun)

	cmd := exec.CommandContext(ctx, "claude",
		"-p", prompt,
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--permission-mode", "bypassPermissions",
		"--model", "sonnet",
	)
	cmd.Dir = dir
	procio.SetGroup(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		sess.Emit(session.MustJSON(map[string]any{"type": "error", "message": "stdout pipe: " + err.Error()}))
		sess.Emit(session.MustJSON(map[string]any{"type": "exit"}))
		sess.MarkDone()
		cancelRun()
		done(err)
		return
	}
	var stderr procio.BoundedBuffer
	stderr.Limit = 64 * 1024
	cmd.Stderr = &stderr

	// The prompt goes into the transcript before the run starts, the same way
	// /code echoes a user turn, so a phone that attaches late sees what was asked.
	sess.Emit(session.MustJSON(map[string]any{"type": "userprompt", "text": prompt}))

	if err := cmd.Start(); err != nil {
		sess.Emit(session.MustJSON(map[string]any{"type": "error", "message": err.Error()}))
		sess.Emit(session.MustJSON(map[string]any{"type": "exit"}))
		sess.MarkDone()
		cancelRun()
		done(err)
		return
	}

	go func() {
		defer cancelRun()
		start := time.Now()

		// Every frame is both streamed to whoever is watching and appended to
		// .nestnote/runs/<n>.log. Nobody is watching a 3am build, so the log is the
		// only record of what it did; the session ring is bounded and gets reaped.
		var logFile *os.File
		if logPath != "" {
			if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err == nil {
				logFile, _ = os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
			}
		}
		if logFile != nil {
			defer logFile.Close()
		}

		scan := bufio.NewScanner(stdout)
		scan.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
		for scan.Scan() {
			raw := append([]byte(nil), scan.Bytes()...)
			if logFile != nil {
				_, _ = logFile.Write(append(raw, '\n'))
			}
			sess.Emit(session.MustJSON(map[string]any{"type": "cc", "msg": json.RawMessage(raw)}))
		}

		waitErr := cmd.Wait()
		procio.KillGroup(cmd)
		log.Printf("build: run %s finished in %s (err=%v)", sess.ID(), time.Since(start).Round(time.Millisecond), waitErr)

		if waitErr != nil {
			if msg := strings.TrimSpace(stderr.String()); msg != "" {
				sess.Emit(session.MustJSON(map[string]any{"type": "error", "message": msg}))
				waitErr = fmt.Errorf("%w: %s", waitErr, msg)
			}
		}
		sess.Emit(session.MustJSON(map[string]any{"type": "exit"}))
		sess.MarkDone()
		done(waitErr)
	}()
}

// runInFlight reports whether a build step for this slug/feature is still going.
// A finished session lingers briefly so a late reconnect can replay its result,
// which is why "exists in the registry" isn't the same question.
func (cfg Config) runInFlight(slug string, feature int) bool {
	sess := cfg.Reg.Get(sessionID(slug, feature))
	return sess != nil && sess.Running()
}

// ---------------------------------------------------------------------------
// Tick — the state machine
// ---------------------------------------------------------------------------

// TickResult is what one tick did, returned to the cron driver (and to a dry run,
// where Prompt carries the run that would have started).
type TickResult struct {
	Action  string `json:"action"`
	Status  string `json:"status"`
	Feature int    `json:"feature"`
	Detail  string `json:"detail,omitempty"`
	Prompt  string `json:"prompt,omitempty"`
}

// tick advances one build by at most one step, and is the only place a build ever
// moves forward. It is called by cron (every cron.TickMinutes) and by hand during
// development; running it twice in a row is safe, because every transition is
// keyed off state that the transition itself changes.
//
// dryRun answers "what would you do" without touching anything but the .gitignore
// re-assertion — the escape hatch that makes debugging a misbehaving build
// something other than a 30-minute-per-iteration exercise.
func (cfg Config) tick(slug string, dryRun bool) (TickResult, error) {
	if !store.ValidSlug(slug) {
		return TickResult{}, fmt.Errorf("bad slug")
	}
	projectDir := filepath.Join(cfg.ProjectsBase, slug)
	dir := cfg.buildDir(slug)
	st, ok := loadState(dir)
	if !ok {
		return TickResult{}, fmt.Errorf("no build for %q", slug)
	}
	mcpDir, _ := store.RootDirs(cfg.Root)

	// Before anything else, and on every single tick: put the .nestnote/ rule back
	// if the last feature's run replaced .gitignore with a generator's.
	if err := ensureGitignore(projectDir); err != nil {
		log.Printf("build: %s gitignore: %v", slug, err)
	}
	// On the same principle, and for a stronger reason: put the idea back at the
	// top of the plan if a run dropped or reworded it. Once the first step card is
	// filed the idea is off the dashboard, and this section is the only place the
	// project still says what problem it was for.
	if !dryRun {
		ensurePlanOverview(projectDir, mcpDir, st)
	}

	res := TickResult{Status: st.Status, Feature: st.Feature}

	switch st.Status {
	case statusDone, statusHalted:
		// Terminal. The crontab line should already be gone; removing it again is a
		// no-op, and it's the cheapest possible insurance against a stale entry
		// firing every 30 minutes forever.
		if !dryRun {
			if err := cron.RemoveLine(cfg.Cron, slug); err != nil {
				log.Printf("build: %s is %s but its crontab line did not go: %v", slug, st.Status, err)
			}
		}
		res.Action = "none"
		res.Detail = "build is " + st.Status
		return res, nil

	case statusScheduled:
		// The user picked a start time. Two lines in the crontab can bring us here —
		// the exact-minute one and the ordinary recurring one — so the clock, not the
		// line that fired, is what decides whether it's time.
		if due, ok := startAtTime(st); ok && time.Now().Before(due) {
			res.Action = "wait"
			res.Detail = "scheduled to start at " + due.Local().Format(time.RFC3339)
			return res, nil
		}
		return cfg.startPlanning(dir, projectDir, mcpDir, st, dryRun)

	case statusPlanning, statusBuilding:
		if cfg.runInFlight(slug, st.Feature) {
			res.Action = "busy"
			res.Detail = "a run is already in flight"
			return res, nil
		}
		// No live session but the state says a run was going: the server restarted
		// mid-run (or the run died without its callback landing). Recover rather
		// than sitting in "building" forever — planning goes back to the start line,
		// a half-built feature goes to the gate so a human decides.
		if st.Status == statusPlanning {
			if len(readPlan(projectDir, st)) == 0 {
				// Nothing to build from, and re-running the planner unattended would
				// just burn the same tokens on the same idea. Stop and say why — the
				// note reaches the phone through the build state.
				res.Action = "halt"
				res.Detail = "the planning run ended without a usable plan"
				res.Status = statusHalted
				if dryRun {
					return res, nil
				}
				st.Note = "the planning run ended without leaving a usable " + planName
				st.Status = statusHalted
				_ = saveState(dir, st)
				if err := cron.RemoveLine(cfg.Cron, slug); err != nil {
					log.Printf("build: %s halted but its crontab line did not go: %v", slug, err)
				}
				stampIdeaCard(mcpDir, st)
				res.Status = st.Status
				return res, nil
			}
			// A plan landed: fall through into "start feature 1". startFeature owns
			// every field it needs to set, so nothing is provisionally set here.
			return cfg.startFeature(dir, projectDir, mcpDir, st, 1, dryRun)
		}
		res.Action = "recovered"
		res.Detail = "the feature run ended without finalizing (server restart?); gating it for review"
		if dryRun {
			return res, nil
		}
		return res, cfg.gateFeature(dir, projectDir, mcpDir, st, "the run ended without reporting; check what it left behind")

	case statusAwaiting:
		card, found := store.LoadCard(mcpDir, st.Source, st.GateCardID)
		switch {
		case !found:
			// The user deleted the gate card outright. Treat that as "stop asking me"
			// rather than silently rebuilding a feature they just threw away.
			res.Action = "halt"
			res.Detail = "the gate card is gone"
			if dryRun {
				return res, nil
			}
			return res, cfg.halt(dir, mcpDir, st, "the gate card was deleted")
		case card.Dismissed:
			res.Action = "halt"
			res.Detail = "the user dismissed the gate card"
			if dryRun {
				return res, nil
			}
			return res, cfg.halt(dir, mcpDir, st, "feature "+strconv.Itoa(st.Feature)+" was rejected")
		case card.Done:
			// Validated, but with a start time on it: the user said when the next
			// feature should run, so the clock decides here exactly as it does for a
			// build waiting on its first run. Checked after the two ways out above —
			// a rejected or deleted step ends the build whatever time was picked.
			if due, ok := startAtTime(st); ok && time.Now().Before(due) {
				res.Action = "wait"
				res.Detail = "feature " + strconv.Itoa(st.Feature+1) +
					" is due to start at " + due.Local().Format(time.RFC3339)
				return res, nil
			}
			return cfg.startFeature(dir, projectDir, mcpDir, st, st.Feature+1, dryRun)
		default:
			res.Action = "wait"
			res.Detail = "waiting on the user to validate feature " + strconv.Itoa(st.Feature)
			return res, nil
		}
	}

	res.Action = "none"
	res.Detail = "unknown status " + st.Status
	return res, nil
}

// startPlanning kicks off the planning run — the first thing that actually
// happens to a build, and the point at which the idea it came from locks.
//
// Two paths reach it: straight from /build/start when the user took the default
// "now", and from a tick once a scheduled build's start time has come round. One
// function either way, so a build that waited until Saturday morning behaves
// exactly like one started on the spot.
func (cfg Config) startPlanning(dir, projectDir, mcpDir string, st State, dryRun bool) (TickResult, error) {
	res := TickResult{Status: st.Status, Feature: 0}

	idea, ok := store.LoadCard(mcpDir, st.Source, st.CardID)
	if !ok || idea.Dismissed {
		// The idea was deleted between scheduling the build and its start time —
		// only possible on the scheduled path, since the handler loads the card
		// first. There is nothing to write a plan from, so stop and say why rather
		// than run the planner against an empty prompt.
		//
		// A dismissed card counts as deleted: dismissing IS how an idea is deleted
		// from the dashboard, and the card file stays on disk afterwards. Deleting
		// the idea already stops the build directly (see StopForCard), so reaching
		// here means the dismissal came through some other door — the orchestrator's
		// own dismiss_card tool, or a server that was down at the time — and this is
		// the backstop that keeps a thrown-away idea from being built anyway.
		res.Action = "halt"
		res.Detail = "the idea card is gone"
		res.Status = statusHalted
		if dryRun {
			return res, nil
		}
		return res, cfg.halt(dir, mcpDir, st, "the idea was deleted before the build started")
	}

	prompt := planningPrompt(idea.Title, idea.Body)
	res.Action = "plan"
	res.Status = statusPlanning
	res.Detail = "writing the project plan"
	if dryRun {
		res.Prompt = prompt
		return res, nil
	}

	wasScheduled := st.StartAt != ""
	st.Status = statusPlanning
	st.Feature = 0
	st.LastRun = store.NowStamp()
	st.StartAt = "" // spent — from here on the build's own status says where it is
	st.Note = ""
	if err := saveState(dir, st); err != nil {
		return res, err
	}
	if wasScheduled {
		// Collapse the scheduled pair down to the recurring line: the exact-minute
		// one has done its job, and a date-pinned crontab entry left behind would
		// come back around in a year. Logged rather than fatal — the build has
		// started, and refusing to advance it now would be the worse outcome.
		if err := cron.InstallLine(cfg.Cron, st.Slug, cron.LineFor(cfg.Root, st.Slug)); err != nil {
			log.Printf("build: %s cron: %v", st.Slug, err)
		}
	}
	stampIdeaCard(mcpDir, st)

	sess, created := cfg.Reg.FindOrCreateForRun(sessionID(st.Slug, 0), session.KindBuild)
	if !created {
		res.Action = "busy"
		res.Detail = "the planning run is already in flight"
		return res, nil
	}
	logPath := filepath.Join(dir, "runs", "plan.log")
	startProcess(sess, projectDir, logPath, prompt, cfg.RunTimeout, func(err error) {
		if err != nil {
			log.Printf("build: %s planning run: %v", st.Slug, err)
		}
		// The plan is on disk (or isn't) — either way the next tick decides what to
		// do about it, using exactly the same recovery path a server restart would
		// take. One code path, exercised on every build.
		if r, terr := cfg.tick(st.Slug, false); terr != nil {
			log.Printf("build: %s post-planning tick: %v", st.Slug, terr)
		} else {
			log.Printf("build: %s post-planning tick: %s (%s)", st.Slug, r.Action, r.Detail)
		}
	})
	return res, nil
}

// startFeature begins feature n, or finishes the build when the plan has run out
// of features. The step card for the feature just validated is left exactly where
// it is: a step card is the user's record of that decision, and only the user
// takes one off the dashboard (see settleGateCard).
func (cfg Config) startFeature(dir, projectDir, mcpDir string, st State, n int, dryRun bool) (TickResult, error) {
	res := TickResult{Status: st.Status, Feature: n}
	feats := readPlan(projectDir, st)

	var target PlanFeature
	for _, f := range feats {
		if f.Num == n {
			target = f
		}
	}
	if target.Num == 0 {
		// Nothing numbered n in the plan: every feature is validated, so we're done.
		res.Action = "finished"
		res.Feature = st.Feature
		res.Detail = "every feature in the plan is built and validated"
		res.Status = statusDone
		if dryRun {
			return res, nil
		}
		st.Status = statusDone
		st.Note = ""
		st.StartAt = "" // spent: there is no next feature for it to have gated
		if err := saveState(dir, st); err != nil {
			return res, err
		}
		if err := cron.RemoveLine(cfg.Cron, st.Slug); err != nil {
			log.Printf("build: %s finished but its crontab line did not go: %v", st.Slug, err)
		}
		stampIdeaCard(mcpDir, st)
		settleGateCard(mcpDir, st, "Every feature in the plan is built and validated. Nothing further runs for this project.")
		return res, nil
	}

	prompt := featurePrompt(n)
	res.Action = "feature"
	res.Status = statusBuilding
	res.Detail = fmt.Sprintf("building feature %d: %s", n, target.Title)
	if dryRun {
		res.Prompt = prompt
		return res, nil
	}

	prevGate, prevFeature := st.GateCardID, st.Feature
	wasScheduled := st.StartAt != ""
	st.Feature = n
	st.Status = statusBuilding
	st.GateCardID = gateCardID(st.Slug, n)
	st.LastRun = store.NowStamp()
	st.Note = ""
	st.StartAt = "" // spent — from here on the build's own status says where it is
	if err := saveState(dir, st); err != nil {
		return res, err
	}
	if wasScheduled {
		// The same collapse startPlanning does: the exact-minute line the user's
		// chosen start installed has fired, and a date-pinned entry left in the
		// crontab would come back around in a year.
		if err := cron.InstallLine(cfg.Cron, st.Slug, cron.LineFor(cfg.Root, st.Slug)); err != nil {
			log.Printf("build: %s cron: %v", st.Slug, err)
		}
	}
	stampIdeaCard(mcpDir, st)
	// The previous feature's step card keeps its place in the list — the decision it
	// records really was made — but it stops asking for one, and takes the state the
	// build has just moved *to*. Settled after that move, not before: stamped with
	// what was true a moment ago it would sit on the dashboard advertising a start
	// time that has already been spent.
	if prevGate != "" && prevFeature != n {
		prev := st
		prev.GateCardID = prevGate
		settleGateCard(mcpDir, prev, "Validated. The build has moved on to feature "+strconv.Itoa(n)+".")
	}

	sess, created := cfg.Reg.FindOrCreateForRun(sessionID(st.Slug, n), session.KindBuild)
	if !created {
		res.Action = "busy"
		res.Detail = "a run for this feature is already in flight"
		return res, nil
	}
	logPath := filepath.Join(dir, "runs", fmt.Sprintf("%d.log", n))
	startProcess(sess, projectDir, logPath, prompt, cfg.RunTimeout, func(err error) {
		detail := ""
		if err != nil {
			detail = "the run reported: " + err.Error()
		}
		if gerr := cfg.gateFeature(dir, projectDir, mcpDir, st, detail); gerr != nil {
			log.Printf("build: %s gate feature %d: %v", st.Slug, n, gerr)
		}
	})
	return res, nil
}

// gateFeature closes a feature run: re-read the state from disk (the run may have
// taken a while and /build/stop may have landed meanwhile), put up the gate card,
// and park the build until the user answers.
func (cfg Config) gateFeature(dir, projectDir, mcpDir string, prev State, note string) error {
	st, ok := loadState(dir)
	if !ok {
		return fmt.Errorf("build state vanished for %q", prev.Slug)
	}
	// A stop (or a rejection) landed while the run was going: honour it and don't
	// resurrect the build with a fresh gate card.
	if !activeStatus(st.Status) {
		return nil
	}
	st.Status = statusAwaiting
	st.LastRun = store.NowStamp()
	st.Note = note
	if st.GateCardID == "" {
		st.GateCardID = gateCardID(st.Slug, st.Feature)
	}
	if err := saveState(dir, st); err != nil {
		return err
	}

	var feat PlanFeature
	for _, f := range readPlan(projectDir, st) {
		if f.Num == st.Feature {
			feat = f
		}
	}
	stampIdeaCard(mcpDir, st)
	return writeGateCard(mcpDir, st, feat, projectDir)
}

// halt stops a build for good: no more ticks, no crontab line, and the idea page
// unlocks so the user can go back to talking about the idea.
//
// The crontab line goes even when the state write failed. A halted build whose
// build.json didn't land is a bug; a crontab line still ticking a build nobody
// can see is a worse one — it would run the state machine off whatever stale
// state is on disk, every half hour, forever.
func (cfg Config) halt(dir, mcpDir string, st State, reason string) error {
	st.Status = statusHalted
	st.Note = reason
	st.StartAt = "" // nothing is due any more, and a time left here would say otherwise
	saveErr := saveState(dir, st)
	if err := cron.RemoveLine(cfg.Cron, st.Slug); err != nil {
		// Not fatal — the build is halted either way and refusing to record that
		// would be worse. But it is the one failure the user would otherwise
		// discover by finding the entry still in their crontab, so it is said out
		// loud rather than dropped.
		log.Printf("build: %s halted but its crontab line did not go: %v", st.Slug, err)
	}
	if saveErr != nil {
		return saveErr
	}
	stampIdeaCard(mcpDir, st)
	return nil
}

// stop is the whole "this build is over" sequence, in the order that leaves the
// least behind: kill whatever run is in flight, halt the state (which takes the
// crontab line out), and settle the step card that was asking the user for a
// decision about a build that no longer exists.
//
// Both doors into it — the stop button on the idea page, and deleting the idea
// itself — go through here, so a build stopped either way leaves the same
// nothing behind.
func (cfg Config) stop(dir, mcpDir string, st State, reason string) error {
	if cfg.Reg != nil {
		if sess := cfg.Reg.Get(sessionID(st.Slug, st.Feature)); sess != nil {
			sess.Kill()
			cfg.Reg.Remove(sess.ID())
		}
	}
	if err := cfg.halt(dir, mcpDir, st, reason); err != nil {
		return err
	}
	st.Status = statusHalted
	st.StartAt = ""
	settleGateCard(mcpDir, st, "This build was stopped — "+reason+". Nothing further runs, and the code already built stays where it is.")
	return nil
}

// StopForCard stops every live build that the dismissed card was driving, and is
// what dismissing a card on the dashboard calls. Two kinds of card lead here, and
// both end a build:
//
//   - The idea card. The build only ever existed to turn that idea into a
//     project, so an idea the user threw away must not leave a crontab line
//     ticking a build behind it.
//   - The gate card of the feature waiting to be validated. Dismissing it is how
//     the user rejects a feature, which stops the build — and stopping it has to
//     happen here, on the dismissal itself. The tick reads the same field, but
//     only when it next comes round: leaving it to that means "stop" takes effect
//     up to cron.TickMinutes later, with the crontab line still armed in between.
//
// It scans the project folders rather than reading the build stamp off the card,
// because the stamp is a convenience for the phone (it's how the idea page knows
// its lock) and it lives in a payload that a later orchestrator write could
// replace. build.json is the record. The scan is a directory read and a small
// JSON file per project — cheap enough to do on a card dismissal, and the only
// version of this that can't leave an entry behind.
//
// Deliberately not gated on cfg.Enabled: a server started without -allow-code
// and -allow-exec can't start builds, but the crontab lines an earlier run armed
// are still there, and this is the one thing that should still clean them up.
func (cfg Config) StopForCard(mcpDir, source, cardID string) {
	if cfg.ProjectsBase == "" || cardID == "" {
		return
	}
	entries, err := os.ReadDir(cfg.ProjectsBase)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := cfg.buildDir(e.Name())
		st, ok := loadState(dir)
		if !ok || st.Source != source || !activeStatus(st.Status) {
			continue
		}
		// The reason is the user's own wording of what they just did, and it is
		// what the idea page shows for a stopped build — so which card was
		// dismissed has to pick it.
		var reason, why string
		switch {
		case st.CardID == cardID:
			reason = "the idea was deleted from the dashboard"
			why = "its idea card " + source + "/" + cardID + " was deleted"
		case st.GateCardID == cardID && st.Status == statusAwaiting:
			reason = "feature " + strconv.Itoa(st.Feature) + " was rejected"
			why = "feature " + strconv.Itoa(st.Feature) + " was rejected on the dashboard"
		default:
			continue
		}
		if err := cfg.stop(dir, mcpDir, st, reason); err != nil {
			log.Printf("build: %s stop after a card was dismissed: %v", st.Slug, err)
			continue
		}
		log.Printf("build: stopped %s — %s", st.Slug, why)
	}
}

// StopForNotebook stops every live build a notebook was driving, and is what
// deleting that notebook from the switcher calls. A build only ever existed to
// turn one of the notebook's idea cards into a project, and deleting the notebook
// takes that card — along with the step card the build files its state onto — with
// it, so a build left running would tick a crontab line behind an idea nobody can
// reach any more.
//
// This is StopForCard's other door: same scan, and the same reason for scanning
// build.json rather than trusting the stamp on a card, but keyed on the owning
// notebook instead of one card id. So a notebook is one directory read however
// many cards it held, and — since the cards are about to be deleted wholesale —
// there is no id left to key on anyway.
//
// Deliberately not gated on cfg.Enabled, for the same reason StopForCard isn't: a
// server that can no longer start builds still has to clean up the crontab lines
// an earlier run armed.
func (cfg Config) StopForNotebook(mcpDir, source string) {
	if cfg.ProjectsBase == "" || source == "" {
		return
	}
	entries, err := os.ReadDir(cfg.ProjectsBase)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := cfg.buildDir(e.Name())
		st, ok := loadState(dir)
		if !ok || st.Source != source || !activeStatus(st.Status) {
			continue
		}
		if err := cfg.stop(dir, mcpDir, st, "its notebook was deleted from the dashboard"); err != nil {
			log.Printf("build: %s stop after its notebook was deleted: %v", st.Slug, err)
			continue
		}
		log.Printf("build: stopped %s — its notebook %s was deleted", st.Slug, source)
	}
}
