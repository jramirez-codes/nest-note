// Package build turns an idea card into a real project folder that a
// cron-triggered agent builds one feature at a time, pausing after each feature
// until the user validates it from the dashboard.
//
// The shape is deliberately boring: everything durable is a file under
// projects/<slug>/.nestnote/, the approve/reject loop rides the dashboard's
// existing complete/dismiss verbs on an ordinary card (see cards.go), and cron
// does nothing but poke this server — see TickHandler for why the run itself must
// never happen in cron's own environment.
//
// Gating: -allow-code AND -allow-exec, both required. A build step is exactly
// those two capabilities run unattended — /code's agent-in-a-project plus /exec's
// arbitrary shell — so it needs no flag of its own, and the combination is the
// security boundary (see CLAUDE.md, "Server flags: do not add new ones").
//
// The package is laid out in the order a build moves through it:
//
//	state.go     build.json — the durable state, and the config every handler needs
//	project.go   the project folder: .gitignore and its CLAUDE.md
//	plan.go      PROJECT_PLAN.md — parsing features, and the idea's Overview section
//	cards.go     gate cards: the approve/reject loop and the stamps it writes
//	prompts.go   the three prompts an unattended run can be given
//	engine.go    tick — the state machine, and the only place a build moves forward
//	handlers.go  the /build/* HTTP surface
package build

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"nestnote/server/internal/cron"
	"nestnote/server/internal/httpx"
	"nestnote/server/internal/session"
)

const (
	// dirName is the per-project bookkeeping folder. It is gitignored (see
	// ensureGitignore): these project folders become real repos the user pushes,
	// and run logs and local card ids have no business in one.
	dirName = ".nestnote"
	// stateFileName is the build's state file inside that folder.
	stateFileName = "build.json"
	// planName is the plan of record — one "## Feature N" section per run.
	planName = "PROJECT_PLAN.md"

	// cardKind is the gate card's kind. The dashboard is kind-agnostic and
	// renders unknown kinds through its generic fallback, so this needs no UI work.
	cardKind = "build-step"

	// firstFeature is the feature whose step card the idea itself moves onto.
	// The first step card a build files is the point where the idea stops being a
	// card in the Ideas section and becomes this project: it takes the idea's name,
	// body and tags, and the idea card is retired behind it (see writeGateCard).
	firstFeature = 1
)

// Build statuses, in the order a healthy build walks them.
const (
	statusScheduled = "scheduled"           // start time is in the future; nothing has run yet
	statusPlanning  = "planning"            // the planning agent is writing PROJECT_PLAN.md
	statusBuilding  = "building"            // a feature run is in flight
	statusAwaiting  = "awaiting-validation" // a gate card is up; nothing proceeds until the user answers
	statusDone      = "done"                // every feature validated
	statusHalted    = "halted"              // the user rejected a feature, or stopped the build
)

// activeStatus reports whether a status means "this build still wants ticks". Both
// terminal states (done, halted) give up their crontab line.
func activeStatus(status string) bool {
	return status == statusScheduled || status == statusPlanning ||
		status == statusBuilding || status == statusAwaiting
}

// State is projects/<slug>/.nestnote/build.json — everything needed to
// resume a build from a cold server. It is small and hand-readable on purpose:
// when a build misbehaves, this file plus the run logs beside it are the whole
// story.
type State struct {
	Slug   string `json:"slug"`
	CardID string `json:"card_id"` // the idea card this build came from
	Source string `json:"source"`  // that card's notebook slug
	// Idea is that card's title, captured when the build was started. The idea
	// itself moves onto the build's first step card and comes off the dashboard, so
	// this is what every later step card is named by — without it a build's steps
	// would have nothing but the slug to say which project they belong to, and a
	// slug is a folder name, not the thing the user called their idea.
	Idea       string `json:"idea,omitempty"`
	Status     string `json:"status"`
	Feature    int    `json:"feature"` // the feature being built or validated (1-based; 0 while planning)
	GateCardID string `json:"gate_card_id,omitempty"`
	LastRun    string `json:"last_run,omitempty"`
	// StartAt is when the planning run is due, RFC3339, for a build the user
	// scheduled rather than started now. Cleared once planning actually begins, so
	// it always reads as "still to come" rather than as history.
	StartAt string `json:"start_at,omitempty"`
	// Note carries the last thing that went wrong (a crashed run, a missing plan)
	// so the phone can show why a build stalled instead of just sitting at a status.
	Note string `json:"note,omitempty"`
}

// Config is what every /build handler needs, assembled once in main.
type Config struct {
	ProjectsBase string // <root>/projects — where project folders live
	Root         string // -root; empty means the scaffold (and so cards) is disabled
	StateDir     string // -dir; holds the token the cron driver reads
	ListenAddr   string // host:port the driver curls back to
	RunTimeout   time.Duration
	Enabled      bool // -allow-code AND -allow-exec
	Reg          *session.Registry
	Cron         cron.IO
}

func (cfg Config) buildDir(slug string) string {
	return filepath.Join(cfg.ProjectsBase, slug, dirName)
}

// gate applies the shared auth + capability gate to a /build request, writing the
// response and reporting false when the caller must stop. The three conditions
// are checked in the order they matter: who you are, then what the operator
// allowed, then whether there's a scaffold to keep cards in.
func (cfg Config) gate(w http.ResponseWriter, r *http.Request, token string) bool {
	if !httpx.Guard(w, r, token) {
		return false
	}
	if !cfg.Enabled {
		http.Error(w, "builds disabled (start the server with -allow-code and -allow-exec)", http.StatusForbidden)
		return false
	}
	if cfg.Root == "" {
		// Matches how /action reports a server started without -root: there is no
		// mcp scaffold, so there is nowhere to put the gate cards a build needs.
		http.Error(w, "mcp disabled", http.StatusNotFound)
		return false
	}
	return true
}

func loadState(dir string) (State, bool) {
	data, err := os.ReadFile(filepath.Join(dir, stateFileName))
	if err != nil {
		return State{}, false
	}
	var st State
	if json.Unmarshal(data, &st) != nil || st.Slug == "" {
		return State{}, false
	}
	return st, true
}

// startAtTime parses a scheduled build's start time. Reports false when there
// isn't one, or when it doesn't parse — both of which mean "no reason to keep
// waiting", so a build can never be stranded in `scheduled` by a bad timestamp.
func startAtTime(st State) (time.Time, bool) {
	if st.StartAt == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, st.StartAt)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

func saveState(dir string, st State) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, stateFileName), append(data, '\n'), 0o600)
}
