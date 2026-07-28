# Idea Builds — project plan

Turn an idea card into a real project folder that a scheduled agent builds one
feature at a time, pausing after each feature until the user validates it from
the dashboard.

**Status:** design only — nothing here is implemented yet. Derived from the
original hand-drawn system diagram, which is not in the repo.

Line references to existing code were accurate as of `6390d3d`; re-check them
before relying on one.

---

## 1. What already exists

Most of the diagram's boxes map onto machinery that is already in the repo. Only
the scheduler is genuinely net-new.

| Diagram box | Today |
|---|---|
| "Idea Overlay button to start" | `src/components/notepage/IdeaPageOverlay.tsx` — full-screen idea page, read-only body + chat composer. No action buttons beyond Undo. |
| "Project Folder /project/{PN}" | `resolveProjectDir()` in `server/agent.go:396` already creates `projects/<slug>` from a human name, slugged to `[a-z0-9-]` so it can't traverse. |
| "Agentic Script" | `startAgentProcess()` in `server/agent.go:146` already runs a durable `claude` process in a project dir with `bypassPermissions`. |
| "Update dashboard to Validate next Step" | Cards are flat JSON at `mcp/<slug>/cards/<id>.json`; the backend is deliberately kind-agnostic (`server/dashboard.go:75`) and the UI renders unknown kinds through a generic fallback (`humanizeKind`, `cardModel.ts:299`). |
| **"CRON Scheduler"** | **Nothing.** The only `time.Ticker` in the server is the session reaper (`server/session.go:275`). This is the piece to build. |

Two consequences worth stating up front:

- A new card kind needs **no** backend work — write the JSON, it shows up.
- The validation gate needs **no new action verb**. See §4.

---

## 2. Decisions taken

| Decision | Choice |
|---|---|
| Scheduler | **Real system crontab entries**, one per active build |
| Validation gate | **Hard block** — nothing proceeds until the user approves the last feature |
| Project target | **New empty folder** under `projects/<slug>` |
| Validation UI | **Dashboard card + a progress toggle in the idea overlay** |

Standing constraint: **no new server flags** (`CLAUDE.md`, "Server flags: do not
add new ones"). The server is updated remotely without access to the start
script that launches it, so a new flag is a flag nobody passes — the capability
would silently never turn on.

Concretely, per the rule's own worked example:

- **Gating: `-allow-code` AND `-allow-exec`, both required.** A build step is
  exactly those two capabilities run unattended — `/code`'s agent-in-a-project
  plus `/exec`'s arbitrary shell (the driver shells out to `claude`, `git`, and
  whatever a feature's toolchain needs). A third flag would gate nothing new.
  Missing either one → 403, same as `/code` and `/exec` do today.
- **Tuning values are constants**, each with a comment saying why it doesn't need
  to vary by machine: the tick interval, the flock timeout, the run ceiling.
- Nothing in this design needs a capability the existing flags can't express. If
  implementation turns one up, that's a **stop-and-ask**, not a new flag.

---

## 3. On-disk shape

```
<root>/projects/<slug>/
  CLAUDE.md              # seeded; links to PROJECT_PLAN.md
  PROJECT_PLAN.md        # the plan, one "## Feature N" section each
  .gitignore             # seeded with .nestnote/ — see below
  .nestnote/
    build.json           # build state (below)
    tick.lock            # flock target — one tick at a time
    runs/<n>.log         # per-feature agent transcript
<root>/bin/nestnote-tick # ONE shared driver script, slug passed as argv
```

`build.json`:

```json
{
  "slug": "greenhouse-tracker",
  "card_id": "idea-4f2a",
  "source": "greenhouse",
  "status": "awaiting-validation",
  "feature": 3,
  "gate_card_id": "build-greenhouse-tracker-3",
  "last_run": "2026-07-27T14:02:11Z"
}
```

`status` is one of `planning` → `building` → `awaiting-validation` →
(`building` | `done` | `halted`).

**One shared driver script, not one per project.** A bug in a per-project copy
would have to be fixed in every project folder that already exists; the crontab
line is `<root>/bin/nestnote-tick <slug>`, so the logic is patched in one place
and every build picks it up on its next tick.

### `.nestnote/` must never reach GitHub

These project folders become real repos — the agent will `git init` them, and the
user will push them. `.nestnote/` is build bookkeeping: local paths, run logs, a
lock file, and card ids that mean nothing outside this machine. None of it
belongs in a public repo, and `tick.lock` in particular would be actively
harmful to commit.

So the project gets a `.gitignore` containing:

```
# NestNote build bookkeeping — local to this machine
.nestnote/
```

**Seeding it once at project creation is not sufficient.** The first thing a
feature-building agent does is often scaffold a framework, and
`npx create-next-app`, `cargo new`, `go mod init`-adjacent generators and their
kin all write their *own* `.gitignore`, clobbering or replacing whatever was
there. A one-shot seed silently disappears on feature 1.

The rule is therefore **idempotent re-assertion**, in a helper both callers share:

- read `.gitignore` if it exists (create it if not)
- if no line matches `.nestnote/` exactly, append the block above
- write back, preserving everything else byte-for-byte

Called at project creation **and at the top of every tick**, before the agent
runs. It's a file read and a substring check — cheap enough to do unconditionally,
and it self-heals a project whose `.gitignore` got replaced two features ago.

Belt and braces: the seeded `CLAUDE.md` tells the agent that `.nestnote/` is
NestNote's own state, must stay ignored, and must never be edited or committed.
That's guidance, not enforcement — the re-assertion is what actually holds the
line.

---

## 4. The validation gate rides on `done`

The gate card is an ordinary card written to `mcp/<source>/cards/<id>.json` with
a distinct kind (`build-step`). The driver polls that file:

- `done: true` → the user ticked it off on the dashboard → build the next feature
- `dismissed: true` → the user rejected it → set `status: halted`, stop ticking
- neither → do nothing this tick, exit 0

The dashboard's existing `complete` / `dismiss` verbs already write exactly those
two fields (`server/dashboard.go:380-410`), and the phone already has buttons
wired to them. So the entire approve/reject loop needs **no new endpoint, no new
action verb, and no new dashboard UI** — only a card kind the UI has never seen,
which it already handles.

This is the single biggest simplification available and it's worth protecting in
review: resist adding a bespoke `/action approve` path.

---

## 5. Who writes the crontab

The user chose real crontab entries. The risk with that choice is state living
outside the repo that outlives whatever created it, so:

**The Go server owns every crontab mutation — never the agent.** An agent with
`bypassPermissions` editing the host's crontab is both untestable and the worst
possible blast radius. Instead a small `server/cron.go` does an idempotent
block rewrite:

1. `crontab -l` (empty output on "no crontab for user" is not an error)
2. Drop every line tagged `# nestnote:<slug>`
3. Append the new line, if installing
4. Pipe the whole thing back through `crontab -`

Every managed line carries its marker:

```
*/30 * * * * <root>/bin/nestnote-tick greenhouse-tracker  # nestnote:greenhouse-tracker
```

That marker makes the entries greppable, individually removable, and safe
alongside the user's own crontab lines, which are passed through untouched.

**Overlap safety:** the driver takes `flock` on `.nestnote/tick.lock` and exits
immediately if held. A feature that takes longer than the interval must never
get a second agent in the same directory.

**Cleanup is mandatory, not a nicety.** `deleteProjectHandler`
(`server/agent.go:343`) currently just `RemoveAll`s the folder. It must also
remove the project's crontab line, or deleting a project leaves cron firing every
30 minutes at a directory that no longer exists. Same on `status: halted` and
`status: done`.

---

## 5a. Environment parity — the tick must run with the server's env

**This is the failure mode most likely to sink the feature on first contact.**

What `/run` gets today (`server/exec.go:130`):

```go
cmd := exec.CommandContext(ctx, "bash", "-lc", cmdStr)
```

Two things are happening, and both matter:

1. `cmd.Env` is nil, so Go hands the child **the server process's entire
   environment** — including everything the operator's start script exported.
   (Every command site in the server does this; `runUpdateStep` is the only one
   that sets `Env` at all, and it's `os.Environ()` plus extras.)
2. `-lc` is a **login** shell, so it also sources the user's profile — which is
   where nvm, `~/.local/bin`, and toolchain paths usually come from.

What cron gets: `PATH=/usr/bin:/bin`, `HOME`, `LOGNAME`, `SHELL`, and nothing
else. No profile. So `claude` very likely isn't even on `PATH` (npm/nvm installs
land outside those two dirs), and any credentials or config the server was
started with are simply absent. A cron-driven build would fail at the first
command with a confusing "not found".

### Recommended: cron is a trigger, the server does the work

Rather than reconstructing the environment, **don't leave the server process at
all**. The crontab line becomes a thin authenticated poke:

```
*/30 * * * * <root>/bin/nestnote-tick greenhouse-tracker  # nestnote:greenhouse-tracker
```

…where the driver's whole job is: read the token from `<dir>/token` (already
there, mode 0600 — `server/auth.go:19`), `curl` a new `POST /build/tick` on
localhost, exit. The server receives it and spawns the feature run the same way
`startAgentProcess` already does.

Env parity is then **exact by construction**, not by careful copying. And it
comes with three things the standalone driver would each need solving:

- No env snapshot file on disk — nothing duplicating API keys or tokens
- The run reuses `sessionRegistry`, so it inherits the run-timeout ceiling and
  the reconnect/buffering behavior, and **the phone can watch a scheduled build
  stream live** with the transcript UI it already has
- `flock` is replaced by the registry's own "session already exists for this id"
  check — one less concurrency primitive

Cost: a tick while the server is down does nothing. That's acceptable — a build
whose server is down can't post gate cards or be watched anyway, and the next
tick picks up.

### Fallback: env snapshot, if the driver must stand alone

If the driver has to work with the server down, then the server writes a snapshot
at boot and the driver sources it:

- `os.Environ()` → `<root>/.nestnote/server.env`, mode **0600**, rewritten on
  every server start so a restart with changed env refreshes it
- Each line `export KEY='value'` with `'` → `'\''` escaping; skip names that
  aren't valid shell identifiers (values legitimately contain spaces, quotes and
  newlines — naive writing produces a file that fails to source)
- The driver runs under `bash -lc` for profile parity, then sources the snapshot
  **after** the profile, so the server's env wins on conflicts — it's the ground
  truth for how this server was actually started

Critically, that file lives under `<root>/.nestnote/`, **not** inside
`projects/<slug>/`. It holds secrets and the project folders become pushable git
repos (§3).

## 6. Server endpoints

Three new handlers in a new `server/build.go`, all gated on `-allow-code` **and**
`-allow-exec` (see §2) **and** `-root` (cards need the scaffold), registered in
`server/main.go` beside `/code`:

| Endpoint | Does |
|---|---|
| `POST /build/start` | `{card_id, source, project}` → create `projects/<slug>`, seed `CLAUDE.md` + `PROJECT_PLAN.md`, run the planning agent, install the crontab line, stamp `payload.build` on the idea card |
| `GET /build?slug=` | build state + parsed `PROJECT_PLAN.md` sections — feeds the overlay's progress toggle |
| `POST /build/stop` | remove the crontab line, set `status: halted`, clear the idea card's lock |
| `POST /build/tick` | `{slug}` → what the cron driver pokes (§5a): check the gate card, and if approved, run the next feature **in the server's own environment** |

`/build/tick` is localhost-only in practice but authed like everything else — it
starts an unattended agent run, so it gets the same bearer-token check, and the
same `-allow-code` + `-allow-exec` + `-root` gate.

The planning run reuses the existing durable-session machinery (`sessionRegistry`,
`startAgentProcess`) rather than growing a second way to run Claude — the phone
can then watch the planning stream with the transcript UI it already has.

---

## 7. App side

**Start button.** In `IdeaPageOverlay`'s header row, beside the priority pill.
Confirms via the existing `ConfirmDialog` (this starts an unattended agent — it
should feel deliberate), then calls `/build/start`.

**The lock.** The diagram's "Idea Page is Locked": once a build exists, the chat
composer is disabled, because the idea body is now the input to `PROJECT_PLAN.md`
and further chat edits would silently diverge from what's being built. Derive the
lock from `card.payload.build` — **not** local component state — so it survives an
app restart and is true on every device.

**Progress toggle.** Tapping the header swaps the body between the idea markdown
and the plan's feature list with per-feature status. Both render through the same
`NotePage` editor the page already uses, so a rendered `PROJECT_PLAN.md` needs no
new renderer — only a second `note` object built from the `/build` response.

---

## 8. Phasing

Each phase is independently useful and independently reviewable.

1. **Folder + plan.** `/build/start` creates the project, seeds `CLAUDE.md`,
   `PROJECT_PLAN.md` and `.gitignore`, runs the planning agent. No cron yet —
   verify by hand that a good plan lands in a good folder.
2. **Tick endpoint + driver.** `POST /build/tick` does the gate-card poll, the
   `.gitignore` re-assertion, and the feature run, in-process. `nestnote-tick`
   is the thin token-reading `curl` wrapper. Drive it manually
   (`nestnote-tick <slug>`) — the whole loop is testable before cron is ever
   involved. **Verify env parity here**, by having a feature run something that
   only resolves via the login profile (e.g. `which claude`, `node -v`).
3. **Crontab management.** `server/cron.go`, install on start, remove on
   stop/delete/halt/done. This is where the tests concentrate (§9).
4. **Gate cards.** Driver writes the `build-step` card; approving it on the
   dashboard advances the build. End-to-end loop closes here.
5. **App surfaces.** Start button, lock, progress toggle.

---

## 9. Testing

The crontab layer is the part that touches the host, so it carries the test
burden. `server/cron.go` must take its `crontab` invocation as an injectable
function (default: the real binary) so tests exercise block-rewriting against a
fake without ever touching the developer's real crontab. Cases that matter:

- No existing crontab at all (`crontab -l` exits non-zero — must not be fatal)
- User's own unrelated lines survive a round trip byte-for-byte
- Installing twice is idempotent — one line, not two
- Removing a slug leaves other `nestnote:` lines intact
- Removing a slug that was never installed is a no-op, not an error

Plus: a second tick while one is in flight is refused; gate poll reads `done` /
`dismissed` correctly; `deleteProjectHandler` removes the line.

Environment parity (§5a) needs one test that would actually have caught the bug:
spawn the feature run and assert the child's env matches what `/run`'s child
gets — same `PATH`, same inherited vars — rather than asserting the run merely
succeeded on a dev box where `claude` happens to be in `/usr/bin`. If the
snapshot fallback is built instead, add: values containing spaces, single
quotes, and newlines survive a write→source round trip, and the file is 0600.

Gating, one case per endpoint — the combination is the security boundary, so it
gets asserted rather than assumed:

- `-allow-code` set but `-allow-exec` not → 403
- `-allow-exec` set but `-allow-code` not → 403
- Both set but `-root` empty → 404 (matches how `/action` reports "mcp disabled")
- Both set with `-root` → works

The `.gitignore` re-assertion gets its own table, since it runs on every tick
against a file the agent is free to rewrite:

- No `.gitignore` at all → created with the block
- Already contains `.nestnote/` → untouched, byte-for-byte
- Contains unrelated rules → they survive, block is appended
- `.gitignore` replaced by a framework generator → block is restored next tick
- A near-miss like `.nestnote` (no slash) or `#.nestnote/` in a comment → does
  **not** count as present; the real rule is still appended
- Running twice in a row appends once, not twice

An escape hatch worth having from day one: a `NESTNOTE_TICK_DRY_RUN` env var that
makes the driver log the prompt it *would* send and exit. Debugging a misbehaving
build otherwise means waiting 30 minutes per iteration.

---

## 10. Docs (required in the same PR)

Per `CLAUDE.md`, this is not done until these land:

| Change | Docs |
|---|---|
| New endpoints, `server/build.go`, `server/cron.go` | `server/setup.md`, `architecture/overview.md`, `architecture/protocol.md` |
| `-allow-code` + `-allow-exec` together now also authorize scheduled unattended runs | `server/flags.md` — **no new flag**, but both flags' meaning widened, and that is a security-relevant change. State that the combination is what unlocks builds |
| `deleteProjectHandler` also removes cron | `commands/projects.mdx` |
| New `build-step` card kind | `commands/dashboard.mdx` |
| Start button, lock, progress toggle | `start/the-pad.md` |
| The feature itself | New page — no existing page covers scheduled builds |

The new page must be `.mdx` with `requiresServer` + `requiresFlag: allow-code` in
frontmatter rendering the shared `<Requires />` component (hand-written `-allow-*`
warnings are forbidden — a stale one is a security problem). If it goes under
*Companion server* it also needs a sidebar line in `site/astro.config.mjs`.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Unattended agent with `bypassPermissions` on a timer — the sharpest edge in the whole design | Hard-block gate means at most one feature runs unwatched; already gated behind `-allow-code` + `-allow-exec`, both of which independently mean "arbitrary code as this user"; `/build/stop` kills it |
| Cron entries outliving the server or the project | Marker-tagged block rewrite, removal on delete/stop/halt/done, all server-owned |
| User edits `PROJECT_PLAN.md` while a run is mid-feature | Driver re-reads the file at tick start; the flock keeps the agent single-writer |
| A feature loops or burns tokens | Same `run-timeout` ceiling the rest of the server uses |
| **Cron's minimal env breaks every run** — no profile, `PATH=/usr/bin:/bin`, `claude` unresolvable | Cron only triggers; the run happens in-server with the identical env `/run` gets (§5a) |
| `.nestnote/` bookkeeping pushed to a public GitHub repo | `.gitignore` block re-asserted every tick, not just at creation, so a framework generator can't quietly drop it |
| Cron fires while the machine is asleep / server down | Driver is standalone and only touches the filesystem, so it works regardless; a missed tick just means the next one picks up |

---

## 12. Open questions

1. **Interval.** 30 minutes is a guess. It must be comfortably longer than a
   feature run, or every other tick is a no-op under flock. It ships as a
   **constant** with a comment justifying the number — not a flag, and not
   something that varies by machine. Worth settling before phase 3, since it's
   baked into every crontab line written.
2. **Notification.** A gate card appears silently on the dashboard. Is that
   enough, or should a validated feature push to the phone?
3. **Definition of done.** When the last feature is validated — archive the idea
   card, or leave the project open for more features to be appended?
