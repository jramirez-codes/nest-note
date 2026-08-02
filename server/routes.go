package main

import (
	"fmt"
	"net/http"

	"nestnote/server/internal/agent"
	"nestnote/server/internal/build"
	"nestnote/server/internal/dashboard"
	"nestnote/server/internal/exec"
	"nestnote/server/internal/pairing"
	"nestnote/server/internal/run"
	"nestnote/server/internal/scaffold"
	"nestnote/server/internal/search"
	"nestnote/server/internal/session"
	"nestnote/server/internal/update"
	"nestnote/server/internal/view"
	"time"
)

// deps is everything the route table needs, assembled once in main. It exists so
// newMux below can stay a readable list of endpoints rather than a wall of
// argument threading.
type deps struct {
	token   string
	root    string
	workdir string
	// codeBase is the projects dir /code, /projects and builds all work under:
	// <root>/projects when -root is set, else <workdir>/projects.
	codeBase   string
	runDir     string
	repoDir    string
	threshold  int
	runTimeout time.Duration
	allowExec  bool
	allowCode  bool
	allowView  bool

	boot     scaffold.Setup
	sessions *session.Registry
	builds   build.Config
	pair     *pairing.Pairing
	views    *view.Manager
}

// newMux is the server's whole HTTP surface, one line per endpoint. Read it as
// the map of the codebase: each route names the package that answers it, so a
// new developer can go from "what does /build/revise do" to the right file in one
// hop.
func newMux(d deps) *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, "ok")
	})

	// Pairing: the one endpoint that needs no bearer token, because it is the one
	// that issues it — reachable only over the pinned TLS connection the phone
	// established from the QR, and only with the matching one-time code.
	mux.HandleFunc("/pair", pairing.Handler(d.pair))

	// One Claude turn against the scaffolded MCP world. Re-scaffolds per request so
	// a server the orchestrator queued last turn is callable this turn.
	mux.HandleFunc("/run", run.Handler(d.token, d.workdir, d.root, d.threshold, d.runTimeout, d.boot, d.sessions))

	// Direct shell channel for /run <cmd> — streams stdout/stderr live, no Claude.
	// Runs in the same base workdir Claude uses. Gated behind -allow-exec.
	mux.HandleFunc("/exec", exec.Handler(d.token, d.runDir, d.allowExec, d.sessions))

	// Persistent Claude Code agent session for /code <name>, in projects/<slug>
	// (created if missing). Gated behind -allow-code.
	mux.HandleFunc("/code", agent.Handler(d.token, d.codeBase, d.allowCode, d.sessions))
	// Read-only listing of projects/<name> dirs so the phone can autocomplete
	// `/code <name>`. Same base and enable flag as /code; empty list when off.
	mux.HandleFunc("/projects", agent.ProjectsHandler(d.token, d.codeBase, d.allowCode))
	// Destructive counterpart: POST a project name to remove its folder. It also
	// drops any scheduled build's crontab line for that project.
	mux.HandleFunc("/projects/delete", agent.DeleteProjectHandler(d.token, d.codeBase, d.allowCode, d.builds.Cron))

	// Scheduled idea builds. /build/start turns an idea card into a project folder
	// with a plan and a crontab entry, /build/tick is what that entry pokes, and
	// each feature pauses on a dashboard card until the user validates it. Gated on
	// -allow-code AND -allow-exec together — a build step is exactly those two
	// capabilities run unattended, so it needs no flag of its own — plus -root,
	// since the gate cards live in the scaffold. See internal/build.
	mux.HandleFunc("/build", build.StateHandler(d.token, d.builds))
	mux.HandleFunc("/build/start", build.StartHandler(d.token, d.builds))
	// When the build's next run happens: the start time of one that hasn't begun,
	// or the next feature of one paused at a step (which signs that step off).
	mux.HandleFunc("/build/schedule", build.ScheduleHandler(d.token, d.builds))
	// What the user said about the feature they were just shown — a change to it,
	// or to the plan — run in the project and gated again afterwards.
	mux.HandleFunc("/build/revise", build.ReviseHandler(d.token, d.builds))
	mux.HandleFunc("/build/stop", build.StopHandler(d.token, d.builds))
	// The way back from a stop: a halted build goes back to the step it reached,
	// with its step card asking for a decision again. Nothing runs until the user
	// places the next feature.
	mux.HandleFunc("/build/resume", build.ResumeHandler(d.token, d.builds))
	mux.HandleFunc("/build/tick", build.TickHandler(d.token, d.builds))

	// Read-only dashboard state and the per-notebook/per-page fetches behind it.
	// All of these only touch the scaffold's data files, so they need no Claude run.
	mux.HandleFunc("/state", dashboard.StateHandler(d.token, d.root))
	mux.HandleFunc("/notebook", dashboard.NotebookHandler(d.token, d.root))
	mux.HandleFunc("/page", dashboard.PageHandler(d.token, d.root))
	// /action also carries the build config: dismissing a card is how an idea is
	// deleted, and deleting an idea stops the build it started rather than leaving
	// cron ticking at it.
	mux.HandleFunc("/action", dashboard.ActionHandler(d.token, d.root, d.builds))

	// Read-only full-text search across every notebook's pages, backing the
	// editor's `/search <query>` autocomplete.
	mux.HandleFunc("/search", search.Handler(d.token, d.root))

	// On-demand page-preview proxies for /view: an authed /viewstart spins up (or
	// reuses) a dedicated plaintext LAN listener per dev-server port and tells the
	// phone which port to point its iframe at.
	mux.HandleFunc("/viewstart", view.StartHandler(d.token, d.allowView, d.views))

	// Self-update: check out a branch (main by default), rebuild this binary, and
	// restart into it. Driven by a note's `/update server [branch]`. Always enabled
	// — it runs one fixed recipe (never caller-supplied commands, only a validated
	// branch name), gated by the pinned tunnel + token like everything else.
	mux.HandleFunc("/update", update.Handler(d.token, d.root, d.repoDir))

	return mux
}
