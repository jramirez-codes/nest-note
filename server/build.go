package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Scheduled idea builds turn an idea card into a real project folder that a
// cron-triggered agent builds one feature at a time, pausing after each feature
// until the user validates it from the dashboard.
//
// The shape is deliberately boring: everything durable is a file under
// projects/<slug>/.nestnote/, the approve/reject loop rides the dashboard's
// existing complete/dismiss verbs on an ordinary card (see gate cards below), and
// cron does nothing but poke this server — see buildTickHandler for why the run
// itself must never happen in cron's own environment.
//
// Gating: -allow-code AND -allow-exec, both required. A build step is exactly
// those two capabilities run unattended — /code's agent-in-a-project plus /exec's
// arbitrary shell — so it needs no flag of its own, and the combination is the
// security boundary (see CLAUDE.md, "Server flags: do not add new ones").

const (
	// buildDirName is the per-project bookkeeping folder. It is gitignored (see
	// ensureGitignore): these project folders become real repos the user pushes,
	// and run logs and local card ids have no business in one.
	buildDirName = ".nestnote"
	// buildStateName is the build's state file inside that folder.
	buildStateName = "build.json"
	// buildPlanName is the plan of record — one "## Feature N" section per run.
	buildPlanName = "PROJECT_PLAN.md"

	// buildTickMinutes is how often cron pokes a live build. It has to be
	// comfortably longer than one feature run or every other tick is a no-op, and
	// short enough that validating a feature doesn't leave the project idle for an
	// afternoon. 30 minutes clears the run ceiling (-run-timeout, 8m by default)
	// several times over. It's a constant rather than a flag because it doesn't
	// vary by machine — a faster host doesn't want a different cadence, it just
	// finishes each feature sooner and waits at the same gate.
	buildTickMinutes = 30

	// buildCardKind is the gate card's kind. The dashboard is kind-agnostic and
	// renders unknown kinds through its generic fallback, so this needs no UI work.
	buildCardKind = "build-step"

	// buildFirstFeature is the feature whose step card the idea itself moves onto.
	// The first step card a build files is the point where the idea stops being a
	// card in the Ideas section and becomes this project: it takes the idea's name,
	// body and tags, and the idea card is retired behind it (see writeGateCard).
	buildFirstFeature = 1
)

// Build statuses, in the order a healthy build walks them.
const (
	buildScheduled = "scheduled"           // start time is in the future; nothing has run yet
	buildPlanning  = "planning"            // the planning agent is writing PROJECT_PLAN.md
	buildBuilding  = "building"            // a feature run is in flight
	buildAwaiting  = "awaiting-validation" // a gate card is up; nothing proceeds until the user answers
	buildDone      = "done"                // every feature validated
	buildHalted    = "halted"              // the user rejected a feature, or stopped the build
)

// buildActive reports whether a status means "this build still wants ticks". Both
// terminal states (done, halted) give up their crontab line.
func buildActive(status string) bool {
	return status == buildScheduled || status == buildPlanning ||
		status == buildBuilding || status == buildAwaiting
}

// buildState is projects/<slug>/.nestnote/build.json — everything needed to
// resume a build from a cold server. It is small and hand-readable on purpose:
// when a build misbehaves, this file plus the run logs beside it are the whole
// story.
type buildState struct {
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

// buildConfig is what every /build handler needs, assembled once in main.
type buildConfig struct {
	projectsBase string // <root>/projects — where project folders live
	root         string // -root; empty means the scaffold (and so cards) is disabled
	stateDir     string // -dir; holds the token the cron driver reads
	listenAddr   string // host:port the driver curls back to
	runTimeout   time.Duration
	enabled      bool // -allow-code AND -allow-exec
	reg          *sessionRegistry
	cron         crontabIO
}

func (cfg buildConfig) buildDir(slug string) string {
	return filepath.Join(cfg.projectsBase, slug, buildDirName)
}

// gateRequest applies the shared auth + capability gate to a /build request,
// writing the response and reporting false when the caller must stop. The three
// conditions are checked in the order they matter: who you are, then what the
// operator allowed, then whether there's a scaffold to keep cards in.
func (cfg buildConfig) gateRequest(w http.ResponseWriter, r *http.Request, token string) bool {
	if !authOK(r, token) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	if !cfg.enabled {
		http.Error(w, "builds disabled (start the server with -allow-code and -allow-exec)", http.StatusForbidden)
		return false
	}
	if cfg.root == "" {
		// Matches how /action reports a server started without -root: there is no
		// mcp scaffold, so there is nowhere to put the gate cards a build needs.
		http.Error(w, "mcp disabled", http.StatusNotFound)
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// State on disk
// ---------------------------------------------------------------------------

func loadBuild(dir string) (buildState, bool) {
	data, err := os.ReadFile(filepath.Join(dir, buildStateName))
	if err != nil {
		return buildState{}, false
	}
	var st buildState
	if json.Unmarshal(data, &st) != nil || st.Slug == "" {
		return buildState{}, false
	}
	return st, true
}

// startAtTime parses a scheduled build's start time. Reports false when there
// isn't one, or when it doesn't parse — both of which mean "no reason to keep
// waiting", so a build can never be stranded in `scheduled` by a bad timestamp.
func startAtTime(st buildState) (time.Time, bool) {
	if st.StartAt == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, st.StartAt)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

func saveBuild(dir string, st buildState) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, buildStateName), append(data, '\n'), 0o600)
}

// ---------------------------------------------------------------------------
// .gitignore — re-asserted, not seeded
// ---------------------------------------------------------------------------

// gitignoreRule is the exact line that keeps .nestnote/ out of the user's repo.
const gitignoreRule = ".nestnote/"

const gitignoreBlock = "# NestNote build bookkeeping — local to this machine\n" + gitignoreRule + "\n"

// ensureGitignore makes sure dir/.gitignore ignores .nestnote/, creating the file
// if absent and appending the rule if it's missing, byte-for-byte preserving
// everything already there.
//
// Seeding this once at project creation is not enough. The first thing a
// feature-building agent usually does is scaffold a framework, and
// `npx create-next-app`, `cargo new` and their kin write their *own* .gitignore
// over the top — a one-shot seed silently disappears on feature 1, and by feature
// 3 the user is pushing a lock file and local card ids to a public repo. So this
// runs at creation AND at the top of every tick: it's a file read and a substring
// check, cheap enough to do unconditionally, and it self-heals a project whose
// .gitignore got replaced two features ago.
func ensureGitignore(dir string) error {
	path := filepath.Join(dir, ".gitignore")
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		return os.WriteFile(path, []byte(gitignoreBlock), 0o644)
	}
	if gitignoreHasRule(string(data)) {
		return nil
	}
	out := string(data)
	// Don't glue the rule onto an unterminated last line — that would silently
	// change the meaning of the user's own final pattern.
	if out != "" && !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	return os.WriteFile(path, []byte(out+gitignoreBlock), 0o644)
}

// gitignoreHasRule reports whether a .gitignore body already carries the exact
// .nestnote/ rule. Deliberately strict: a commented-out "#.nestnote/" ignores
// nothing, and ".nestnote" without the slash is a different (weaker) pattern, so
// neither counts as present and the real rule is still appended.
func gitignoreHasRule(body string) bool {
	for _, line := range strings.Split(body, "\n") {
		if strings.TrimSpace(line) == gitignoreRule {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

// seedProjectClaudeMD writes the project's own CLAUDE.md, which is how each
// unattended run learns the rules it is working under: build one feature, stop,
// and leave .nestnote/ alone. That last part is guidance, not enforcement — the
// re-assertion in ensureGitignore is what actually holds the line — but an agent
// told why a directory is off limits is much less likely to "tidy" it away.
//
// Only written when absent: after feature 1 this is the user's file to edit.
func seedProjectClaudeMD(dir, title string) error {
	body := fmt.Sprintf(`# %s

Built by NestNote, one feature at a time, from `+"`"+buildPlanName+"`"+`.

## How this project is built

- `+"`"+buildPlanName+"`"+` is the plan of record. Each `+"`"+`## Feature N`+"`"+` section is one
  unattended agent run: build only the feature you were asked for, then stop.
- After each feature the build pauses until the user validates it from the
  NestNote dashboard, so leave the repo in a state someone can read and run.
- Commit your work. The user pushes these repos.

## `+"`"+buildDirName+"/`"+` is off limits

`+"`"+buildDirName+"/`"+` is NestNote's own build state — the build's status and run logs,
plus card ids that mean nothing outside this machine. Never edit it, never commit it, and
never drop its entry from `+"`"+`.gitignore`+"`"+`: if a framework generator overwrites that
file, the `+"`"+gitignoreRule+"`"+` rule has to go back in.
`, title)
	return writeIfMissing(filepath.Join(dir, "CLAUDE.md"), body)
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

// planFeatureRe matches a plan's "## Feature N: title" headings. The separator is
// loose (colon, dash, em dash, or nothing) because the heading is written by an
// agent, and a build shouldn't stall on punctuation.
var planFeatureRe = regexp.MustCompile(`^##\s+Feature\s+(\d+)\s*[:.\-—]?\s*(.*)$`)

// planSectionRe matches a top-level ("#") or section-level ("##") heading, which
// ends whatever feature section preceded it. Deeper headings do not: a finished
// run appends a "### Built" note inside its own feature's section, and that note
// belongs to the feature.
var planSectionRe = regexp.MustCompile(`^#{1,2}(\s|$)`)

// planFeature is one "## Feature N" section of PROJECT_PLAN.md, with the status
// the build state implies for it. This is what the idea overlay's progress toggle
// renders.
type planFeature struct {
	Num    int    `json:"num"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	Status string `json:"status"` // done | building | awaiting-validation | pending
}

// parsePlanFeatures splits a PROJECT_PLAN.md body into its numbered feature
// sections, in file order. Anything before the first heading (the plan's preamble)
// is not a feature and is dropped here; readers who want it read the file.
func parsePlanFeatures(md string) []planFeature {
	var out []planFeature
	var cur *planFeature
	var body []string
	flush := func() {
		if cur != nil {
			cur.Body = strings.TrimSpace(strings.Join(body, "\n"))
			out = append(out, *cur)
		}
		cur, body = nil, nil
	}
	scan := bufio.NewScanner(strings.NewReader(md))
	scan.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scan.Scan() {
		line := scan.Text()
		if m := planFeatureRe.FindStringSubmatch(line); m != nil {
			flush()
			n, _ := strconv.Atoi(m[1])
			title := strings.TrimSpace(m[2])
			if title == "" {
				title = fmt.Sprintf("Feature %d", n)
			}
			cur = &planFeature{Num: n, Title: title}
			continue
		}
		if planSectionRe.MatchString(line) {
			// Some other section ("## Notes", "## Open questions") — the previous
			// feature's body ends here rather than swallowing the rest of the plan.
			flush()
			continue
		}
		if cur != nil {
			body = append(body, line)
		}
	}
	flush()
	return out
}

// readPlanDoc reads PROJECT_PLAN.md, or "" when there isn't one yet — which is
// the normal state of a build that hasn't planned anything, not an error.
func readPlanDoc(projectDir string) string {
	data, err := os.ReadFile(filepath.Join(projectDir, buildPlanName))
	if err != nil {
		return ""
	}
	return string(data)
}

// readPlan reads and parses the project's plan, stamping each feature with the
// status the build state implies: everything below the current feature is built
// and validated, the current one is whatever the build is doing to it, and the
// rest are pending.
func readPlan(projectDir string, st buildState) []planFeature {
	doc := readPlanDoc(projectDir)
	if doc == "" {
		return []planFeature{}
	}
	feats := parsePlanFeatures(doc)
	for i := range feats {
		switch {
		case feats[i].Num < st.Feature:
			feats[i].Status = buildDone
		case feats[i].Num == st.Feature:
			feats[i].Status = st.Status
		default:
			feats[i].Status = "pending"
		}
		// A finished build has validated everything, including the last feature.
		if st.Status == buildDone {
			feats[i].Status = buildDone
		}
	}
	return feats
}

// ---------------------------------------------------------------------------
// The plan's Overview — where the idea ends up
// ---------------------------------------------------------------------------

// The plan opens with an "## Overview" section holding the idea the project was
// started from: the problem it's for, and the idea itself, in the user's own
// words. It is the reason an idea card can be taken off the dashboard at all —
// between this and the build's first step card, nothing about the idea is lost.
//
// It is the server's section, not the agent's. Every tick re-asserts it from the
// idea card (see ensurePlanOverview), for the same reason .gitignore is
// re-asserted: a run that rewrites the plan — and a revision run is allowed to —
// would otherwise quietly paraphrase the idea away, one feature at a time.
const planOverviewTitle = "Overview"

// planOverviewRe matches the Overview section's own heading, and planLevel2Re any
// "## " heading — the level the plan's sections sit at. The "# <project>" title
// above them deliberately doesn't match: the Overview goes under it, not over it.
var (
	planOverviewRe = regexp.MustCompile(`(?i)^##\s+` + planOverviewTitle + `\s*$`)
	planLevel2Re   = regexp.MustCompile(`^##(\s|$)`)
)

// parsePlanOverview returns the body of the plan's Overview section, or "" when
// the plan has none. This is what the phone renders above the features.
func parsePlanOverview(md string) string {
	var body []string
	in := false
	scan := bufio.NewScanner(strings.NewReader(md))
	scan.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scan.Scan() {
		line := scan.Text()
		if planOverviewRe.MatchString(line) {
			in = true
			continue
		}
		if !in {
			continue
		}
		// A "#" or "##" heading ends it. Deeper ones don't: the Problem/Idea
		// sub-headings inside the overview are "###" precisely so they can't.
		if planSectionRe.MatchString(line) {
			break
		}
		body = append(body, line)
	}
	return strings.TrimSpace(strings.Join(body, "\n"))
}

// ideaOverview renders the Overview section for an idea card: its name, the
// problem it's for, and the idea itself, taken from the "## Problem" and "## Idea"
// sections of the template Claude files ideas against (see IDEA_TEMPLATE in the
// app). An idea written without those headings keeps its whole body instead —
// better a slightly long overview than a project whose plan can't say what it's
// for. Returns "" when there is nothing to say, so an empty idea inserts nothing.
func ideaOverview(c dashCard) string {
	problem := mdSection(c.Body, "Problem")
	idea := mdSection(c.Body, "Idea")

	out := []string{"## " + planOverviewTitle, ""}
	if title := strings.TrimSpace(c.Title); title != "" {
		out = append(out, "**"+title+"**", "")
	}
	switch {
	case problem == "" && idea == "":
		body := strings.TrimSpace(c.Body)
		if body == "" && strings.TrimSpace(c.Title) == "" {
			return ""
		}
		if body != "" {
			out = append(out, body, "")
		}
	default:
		if problem != "" {
			out = append(out, "### Problem", "", problem, "")
		}
		if idea != "" {
			out = append(out, "### Idea", "", idea, "")
		}
	}
	return strings.TrimRight(strings.Join(out, "\n"), "\n")
}

// mdSection returns the body of the first "## <name>" section of a Markdown
// document, trimmed, or "" when there isn't one.
func mdSection(md, name string) string {
	head := regexp.MustCompile(`(?i)^##\s+` + regexp.QuoteMeta(name) + `\s*:?\s*$`)
	var body []string
	in := false
	scan := bufio.NewScanner(strings.NewReader(md))
	scan.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scan.Scan() {
		line := scan.Text()
		if head.MatchString(line) {
			in = true
			continue
		}
		if !in {
			continue
		}
		if planSectionRe.MatchString(line) {
			break
		}
		body = append(body, line)
	}
	return strings.TrimSpace(strings.Join(body, "\n"))
}

// setPlanOverview returns the plan with `block` as its Overview section: any
// existing one is dropped and the new one inserted above the plan's first "## "
// section, so the overview sits under the project title and over Feature 1.
//
// Replace rather than leave-alone, deliberately. The idea card is locked for the
// life of the build, so this section has exactly one correct content — and an
// agent that rewrote the plan and reworded the overview on the way past would be
// editing the one part of the file that isn't its to edit.
func setPlanOverview(md, block string) string {
	blockLines := strings.Split(block, "\n")
	var out []string
	skipping, inserted := false, false
	for _, line := range strings.Split(md, "\n") {
		if planOverviewRe.MatchString(line) {
			skipping = true
			continue
		}
		if skipping {
			if !planSectionRe.MatchString(line) {
				continue
			}
			skipping = false
		}
		if !inserted && planLevel2Re.MatchString(line) {
			out = append(out, blockLines...)
			out = append(out, "")
			inserted = true
		}
		out = append(out, line)
	}
	if !inserted {
		// A plan with no sections at all (a preamble the planner never finished, or
		// one whose headings the last run mangled). The overview still belongs in
		// the file, so it goes on the end rather than nowhere.
		if len(out) > 0 && strings.TrimSpace(out[len(out)-1]) != "" {
			out = append(out, "")
		}
		out = append(out, blockLines...)
	}
	return strings.Join(out, "\n")
}

// ensurePlanOverview puts the idea back at the top of the plan, and is called on
// every tick for the same reason ensureGitignore is: the plan is a file agents
// write to, and this section is the project's only record of what it is for once
// the idea card has come off the dashboard.
//
// It writes only when the file would actually change, so an untouched plan costs
// one read. A build with no plan yet (still `scheduled`) has nothing to put an
// overview in, and a missing idea card leaves whatever is already there alone.
func ensurePlanOverview(projectDir, mcpDir string, st buildState) {
	doc := readPlanDoc(projectDir)
	if doc == "" {
		return
	}
	// The idea card is loaded even after it has been retired: dismissing is how the
	// dashboard deletes a card, and the file stays on disk. That is what keeps this
	// working for the whole life of a build, not just up to the first step card.
	idea, ok := loadCard(mcpDir, st.Source, st.CardID)
	if !ok {
		return
	}
	block := ideaOverview(idea)
	if block == "" {
		return
	}
	next := setPlanOverview(doc, block)
	if next == doc {
		return
	}
	if err := os.WriteFile(filepath.Join(projectDir, buildPlanName), []byte(next), 0o644); err != nil {
		log.Printf("build: %s plan overview: %v", st.Slug, err)
	}
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

// loadCard reads one card by id from a known notebook.
func loadCard(mcpDir, source, id string) (dashCard, bool) {
	data, err := os.ReadFile(filepath.Join(cardsDirFor(mcpDir, source), id+".json"))
	if err != nil {
		return dashCard{}, false
	}
	var c dashCard
	if json.Unmarshal(data, &c) != nil || c.ID == "" {
		return dashCard{}, false
	}
	return c, true
}

// writeCard writes one card under mcp/<source>/cards/<id>.json, preserving the
// original created_at if the card already exists. Same shape and permissions the
// orchestrator's upsert_card uses, so the dashboard can't tell the difference.
func writeCard(mcpDir, source string, c dashCard) error {
	dir := cardsDirFor(mcpDir, source)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if existing, ok := loadCard(mcpDir, source, c.ID); ok && existing.CreatedAt != "" {
		c.CreatedAt = existing.CreatedAt
	}
	if c.CreatedAt == "" {
		c.CreatedAt = nowStamp()
	}
	c.UpdatedAt = nowStamp()
	c.Source = source
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, c.ID+".json"), append(data, '\n'), 0o644)
}

// gateCardID is the id of the card that gates feature n. It is a validSlug (the
// project slug is already [a-z0-9-]), so the dashboard's own complete/dismiss
// verbs accept it without any special-casing.
func gateCardID(slug string, n int) string {
	return fmt.Sprintf("build-%s-%d", slug, n)
}

// writeGateCard puts up the card that asks the user to validate feature n.
//
// This is the whole approve/reject loop: an ordinary card, written to the idea's
// own notebook, that the dashboard's existing "complete" and "dismiss" buttons
// already mutate. Ticking it off means "build the next feature"; dismissing it
// means "stop". No new endpoint, no new action verb, no new dashboard UI — resist
// adding a bespoke approve path here.
//
// It is also where an idea stops being an idea. A step card is named after the
// idea, not after the feature, because the idea is what the user recognises the
// project by — and the *first* one a build files takes the idea's body and tags
// as well, after which the idea card is retired from the dashboard (see
// retireIdeaCard). From then on the project lives in exactly two places: this
// card, and the plan's Overview section. Nothing is duplicated onto the later
// steps: what feature 6's card is about is feature 6.
func writeGateCard(mcpDir string, st buildState, feat planFeature, projectDir string) error {
	// The idea card, loaded whether or not it has been retired — dismissing leaves
	// the file on disk (see retireIdeaCard), so its tags stay available to every
	// step this build files, and the tag filter keeps working on a project's steps.
	idea, hasIdea := loadCard(mcpDir, st.Source, st.CardID)

	title := strings.TrimSpace(st.Idea)
	if title == "" {
		// A build started before the idea's title was recorded, or one whose idea had
		// none. The folder name is a poor name for a project but it is a true one.
		title = st.Slug
	}
	what := fmt.Sprintf("Feature %d", st.Feature)
	if feat.Title != "" {
		what = fmt.Sprintf("Feature %d — %s", st.Feature, feat.Title)
	}
	body := strings.Join([]string{
		fmt.Sprintf("**%s** of **%s** is built and waiting on you.", what, st.Slug),
		"",
		fmt.Sprintf("`%s`", projectDir),
		"",
		"Check it over, then **complete** this card to start the next feature — or **dismiss** it to stop the build here.",
	}, "\n")
	if feat.Body != "" {
		body += "\n\n---\n\n" + feat.Body
	}
	if st.Feature == buildFirstFeature && hasIdea && strings.TrimSpace(idea.Body) != "" {
		body += "\n\n---\n\n## The idea\n\n" + strings.TrimSpace(idea.Body)
	}

	var tags []string
	if hasIdea {
		tags = idea.Tags
	}
	if err := writeCard(mcpDir, st.Source, dashCard{
		ID:       st.GateCardID,
		Kind:     buildCardKind,
		Priority: "high",
		Title:    title,
		Body:     body,
		Tags:     tags,
		Payload: map[string]any{
			"build": buildStamp(st),
			// What this step is about, kept apart from the build stamp on purpose.
			// The stamp travels with the build — a settled step card is re-stamped
			// with the state the build has moved *to* — while this is the step's own
			// identity, and a card that said it was about feature 5 last week has to
			// still say so next week.
			"step": stepStamp(st, feat),
		},
	}); err != nil {
		return err
	}
	// The idea now lives here and in the plan's Overview, so it comes off the
	// dashboard. Last, and only on success: an idea retired behind a step card that
	// failed to write would be an idea nothing is showing anywhere.
	if st.Feature == buildFirstFeature {
		retireIdeaCard(mcpDir, st)
	}
	return nil
}

// stepStamp is payload.step: which feature a step card is asking about, and what
// that feature is called. It is what the dashboard row reads to say what is being
// validated under the idea's name, and it never changes after the card is filed.
func stepStamp(st buildState, feat planFeature) map[string]any {
	stamp := map[string]any{"feature": st.Feature}
	if feat.Title != "" {
		stamp["title"] = feat.Title
	}
	return stamp
}

// retireIdeaCard takes the idea off the dashboard once its content has moved onto
// the build's first step card. There is nowhere for an idea card to sit after
// that: the step card carries its name, body and tags, the plan's Overview
// carries the problem and the idea, and a second copy in the Ideas section would
// be a stale one the moment the project moved on.
//
// Dismissing is what "delete" means for a card here (see actionHandler): the file
// stays on disk, which is what keeps the idea readable to later step cards and to
// ensurePlanOverview, and what makes the dashboard's own restore work if this
// turns out to have been wrong.
//
// Deliberately not routed through the /action dismiss path: that is the *user*
// throwing an idea away, which stops the build (stopBuildsForCard). This is the
// build moving the idea somewhere better, and it must not stop anything.
func retireIdeaCard(mcpDir string, st buildState) {
	if st.CardID == "" || !validSlug(st.CardID) {
		return
	}
	if _, ok := updateCard(mcpDir, st.Source, st.CardID, func(c *dashCard) {
		c.Dismissed = true
	}); !ok {
		log.Printf("build: %s could not retire idea card %s/%s", st.Slug, st.Source, st.CardID)
	}
}

// buildStamp is the payload.build object every card the build touches carries —
// the idea it came from and each step card it files. One shape for both, because
// the phone reads them with one parser and shows the same state from either: a
// step card whose stamp said nothing left the page guessing, and it guessed
// "nothing is running here" until /build answered.
func buildStamp(st buildState) map[string]any {
	stamp := map[string]any{
		"slug":    st.Slug,
		"status":  st.Status,
		"feature": st.Feature,
		"card_id": st.CardID,
	}
	// The idea's name, so a step card can be titled by the project the user knows
	// rather than by the folder it was slugged into — the idea card it would
	// otherwise be read off is gone by the time the second step is filed.
	if st.Idea != "" {
		stamp["idea"] = st.Idea
	}
	// Carried so a page can say when the next run is due from the card alone,
	// before it has fetched the build itself. It means the same thing in both
	// statuses that can hold one: the minute cron will act on.
	if st.StartAt != "" {
		stamp["start_at"] = st.StartAt
	}
	return stamp
}

// stampIdeaCard records the build on the idea card it came from. The app derives
// the idea page's lock from this — not from local state — so the lock survives an
// app restart and is true on every device.
func stampIdeaCard(mcpDir string, st buildState) {
	stampCard(mcpDir, st.Source, st.CardID, st)
}

// stampGateCard puts the same record on the step card that is currently asking
// for a decision, so opening it shows what the build is actually doing rather
// than an empty stamp the page has to fill in from a fetch.
func stampGateCard(mcpDir string, st buildState) {
	stampCard(mcpDir, st.Source, st.GateCardID, st)
}

func stampCard(mcpDir, source, cardID string, st buildState) {
	if cardID == "" || !validSlug(cardID) {
		return
	}
	_, _ = updateCard(mcpDir, source, cardID, func(c *dashCard) {
		if c.Payload == nil {
			c.Payload = map[string]any{}
		}
		c.Payload["build"] = buildStamp(st)
	})
}

// ---------------------------------------------------------------------------
// Running a build step
// ---------------------------------------------------------------------------

// buildSessionID keys a build run in the session registry. Feature 0 is the
// planning run. The phone can watch either live by connecting to /code with
// resumeOnly and this id — the frames are byte-identical to a /code session's, so
// the existing transcript UI needs no changes.
func buildSessionID(slug string, feature int) string {
	if feature <= 0 {
		return fmt.Sprintf("build-%s-plan", slug)
	}
	return fmt.Sprintf("build-%s-%d", slug, feature)
}

// startBuildProcess runs one unattended Claude turn in the project directory and
// calls done when it exits.
//
// It mirrors startAgentProcess — same bypassPermissions, same "cc" frames into a
// durable session so a watcher gets the live transcript — with two differences
// that matter for an unattended run:
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
// the server instead of running the agent itself — see buildTickHandler.
func startBuildProcess(sess *session, dir, logPath, prompt string, timeout time.Duration, done func(error)) {
	ctx, cancelRun := context.WithTimeout(context.Background(), timeout)
	sess.setCancel(cancelRun)

	cmd := exec.CommandContext(ctx, "claude",
		"-p", prompt,
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--permission-mode", "bypassPermissions",
		"--model", "sonnet",
	)
	cmd.Dir = dir
	setProcGroup(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		sess.emit(mustJSON(map[string]any{"type": "error", "message": "stdout pipe: " + err.Error()}))
		sess.emit(mustJSON(map[string]any{"type": "exit"}))
		sess.markDone()
		cancelRun()
		done(err)
		return
	}
	var stderr boundedBuffer
	stderr.limit = 64 * 1024
	cmd.Stderr = &stderr

	// The prompt goes into the transcript before the run starts, the same way
	// /code echoes a user turn, so a phone that attaches late sees what was asked.
	sess.emit(mustJSON(map[string]any{"type": "userprompt", "text": prompt}))

	if err := cmd.Start(); err != nil {
		sess.emit(mustJSON(map[string]any{"type": "error", "message": err.Error()}))
		sess.emit(mustJSON(map[string]any{"type": "exit"}))
		sess.markDone()
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
			sess.emit(mustJSON(map[string]any{"type": "cc", "msg": json.RawMessage(raw)}))
		}

		waitErr := cmd.Wait()
		killGroup(cmd)
		log.Printf("build: run %s finished in %s (err=%v)", sess.id, time.Since(start).Round(time.Millisecond), waitErr)

		if waitErr != nil {
			if msg := strings.TrimSpace(stderr.String()); msg != "" {
				sess.emit(mustJSON(map[string]any{"type": "error", "message": msg}))
				waitErr = fmt.Errorf("%w: %s", waitErr, msg)
			}
		}
		sess.emit(mustJSON(map[string]any{"type": "exit"}))
		sess.markDone()
		done(waitErr)
	}()
}

// runInFlight reports whether a build step for this slug/feature is still going.
// A finished session lingers briefly so a late reconnect can replay its result,
// which is why "exists in the registry" isn't the same question.
func (cfg buildConfig) runInFlight(slug string, feature int) bool {
	sess := cfg.reg.get(buildSessionID(slug, feature))
	return sess != nil && sess.running()
}

// planningPrompt asks for a plan and nothing else. The hard constraint is the
// heading grammar — "## Feature N" is what parsePlanFeatures splits on and what
// every later run is addressed by, so it's stated twice and shown once.
func planningPrompt(title, idea string) string {
	return fmt.Sprintf(`You are setting up a new software project from an idea, and writing its plan. Do not write any application code in this run.

The idea, as it was filed:

---
# %s

%s
---

Write %s in this directory, and create no other files. It must:

- open with a "# <project title>" heading and a short paragraph saying what is being built and for whom;
- then break the work into 3-8 sections, each headed exactly "## Feature N: <short title>", numbered from 1, in the order they should be built;
- give each feature a couple of sentences of scope, a short bullet list of what "done" looks like, and any decision it depends on;
- make Feature 1 something that stands up end to end — a thin running skeleton, not scaffolding nobody can see;
- keep each feature small enough to build and review in one sitting.

The "## Feature N" headings are load-bearing: a separate unattended run later builds each one on its own, addressed by that number, and pauses for the user to validate it before the next. Write the plan so that is possible — each feature independently reviewable, and no feature depending on work from a later one.

Do not write an "## Overview" section. NestNote adds one above your first feature holding the idea above, in the user's own words, and it will replace anything you put under that heading.`,
		title, strings.TrimSpace(idea), buildPlanName)
}

// featurePrompt asks for exactly one feature. "Then stop" is the load-bearing
// instruction: the hard-block gate means at most one feature is ever built
// unwatched, and an agent that helpfully carries on to feature 4 defeats it.
func featurePrompt(n int) string {
	prior := "This is the first feature — the repository is empty."
	if n > 1 {
		prior = fmt.Sprintf("Features 1 to %d are already built and validated. Treat that code as existing work to extend, not to rewrite.", n-1)
	}
	return fmt.Sprintf(`You are building ONE feature of this project, and then stopping.

Read %s in this directory and build **Feature %d** — only that feature. %s

Before you finish:

- make it actually run: build it, run it, and fix what breaks;
- commit your work with git (run "git init" first if this is not a repository yet);
- append a short "### Built" note inside that feature's own section of %s saying what you did and anything the user should check.

The plan's "## Overview" section is the idea this project came from, in the user's own words. Read it — it is what the features are for — but leave it exactly as it is.

Do not start the next feature — the user validates this one first. Do not edit, remove, or commit the %s/ directory: it is NestNote's own bookkeeping and it is gitignored deliberately. If a generator you run overwrites .gitignore, put the "%s" line back.`,
		buildPlanName, n, prior, buildPlanName, buildDirName, gitignoreRule)
}

// revisionPrompt carries what the user said about the feature they were just
// shown, and is the reason a build step is a conversation rather than a yes/no.
//
// Two shapes of ask arrive through it and both are legitimate, so neither is
// privileged: "the header is the wrong colour" (fix the code) and "actually,
// feature 4 should come before 3" (fix the plan). The run is told it may edit
// PROJECT_PLAN.md, because a plan the user has changed their mind about is worth
// more than a plan that was written before they saw anything working.
//
// What it must not do is run on: this lands the user back at the same step card,
// looking at the same feature, deciding again. That is the whole gate.
func revisionPrompt(n int, note string) string {
	return fmt.Sprintf(`You are revising ONE feature of this project that the user has just reviewed, and then stopping.

They were shown **Feature %d** of %s, as built, and said:

---
%s
---

Do what they asked, in this directory. Read %s first for the context the feature was built in.

- If it is a change to the feature, make it, and make it actually run: build it, run it, and fix what breaks.
- If what they are asking for changes the plan itself — this feature's scope, or the features after it — edit %s to match, and say so in your reply. Keep the "## Feature N" heading grammar exactly as it is: later runs are addressed by those numbers. Leave the "## Overview" section alone — it is the idea this project came from, in the user's own words, and NestNote puts it back.
- Commit your work with git (run "git init" first if this is not a repository yet).
- Append a short "### Revised" note inside Feature %d's own section of %s saying what you changed.

Do not start the next feature — the user validates this one again first. Do not edit, remove, or commit the %s/ directory: it is NestNote's own bookkeeping and it is gitignored deliberately.`,
		n, buildPlanName, note, buildPlanName, buildPlanName, n, buildPlanName, buildDirName)
}

// ---------------------------------------------------------------------------
// Tick — the state machine
// ---------------------------------------------------------------------------

// tickResult is what one tick did, returned to the cron driver (and to a dry run,
// where Prompt carries the run that would have started).
type tickResult struct {
	Action  string `json:"action"`
	Status  string `json:"status"`
	Feature int    `json:"feature"`
	Detail  string `json:"detail,omitempty"`
	Prompt  string `json:"prompt,omitempty"`
}

// tick advances one build by at most one step, and is the only place a build ever
// moves forward. It is called by cron (every buildTickMinutes) and by hand during
// development; running it twice in a row is safe, because every transition is
// keyed off state that the transition itself changes.
//
// dryRun answers "what would you do" without touching anything but the .gitignore
// re-assertion — the escape hatch that makes debugging a misbehaving build
// something other than a 30-minute-per-iteration exercise.
func (cfg buildConfig) tick(slug string, dryRun bool) (tickResult, error) {
	if !validSlug(slug) {
		return tickResult{}, fmt.Errorf("bad slug")
	}
	projectDir := filepath.Join(cfg.projectsBase, slug)
	dir := cfg.buildDir(slug)
	st, ok := loadBuild(dir)
	if !ok {
		return tickResult{}, fmt.Errorf("no build for %q", slug)
	}
	mcpDir, _ := rootDirs(cfg.root)

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

	res := tickResult{Status: st.Status, Feature: st.Feature}

	switch st.Status {
	case buildDone, buildHalted:
		// Terminal. The crontab line should already be gone; removing it again is a
		// no-op, and it's the cheapest possible insurance against a stale entry
		// firing every 30 minutes forever.
		if !dryRun {
			if err := removeCronLine(cfg.cron, slug); err != nil {
				log.Printf("build: %s is %s but its crontab line did not go: %v", slug, st.Status, err)
			}
		}
		res.Action = "none"
		res.Detail = "build is " + st.Status
		return res, nil

	case buildScheduled:
		// The user picked a start time. Two lines in the crontab can bring us here —
		// the exact-minute one and the ordinary recurring one — so the clock, not the
		// line that fired, is what decides whether it's time.
		if due, ok := startAtTime(st); ok && time.Now().Before(due) {
			res.Action = "wait"
			res.Detail = "scheduled to start at " + due.Local().Format(time.RFC3339)
			return res, nil
		}
		return cfg.startPlanning(dir, projectDir, mcpDir, st, dryRun)

	case buildPlanning, buildBuilding:
		if cfg.runInFlight(slug, st.Feature) {
			res.Action = "busy"
			res.Detail = "a run is already in flight"
			return res, nil
		}
		// No live session but the state says a run was going: the server restarted
		// mid-run (or the run died without its callback landing). Recover rather
		// than sitting in "building" forever — planning goes back to the start line,
		// a half-built feature goes to the gate so a human decides.
		if st.Status == buildPlanning {
			if len(readPlan(projectDir, st)) == 0 {
				// Nothing to build from, and re-running the planner unattended would
				// just burn the same tokens on the same idea. Stop and say why — the
				// note reaches the phone through the build state.
				res.Action = "halt"
				res.Detail = "the planning run ended without a usable plan"
				res.Status = buildHalted
				if dryRun {
					return res, nil
				}
				st.Note = "the planning run ended without leaving a usable " + buildPlanName
				st.Status = buildHalted
				_ = saveBuild(dir, st)
				if err := removeCronLine(cfg.cron, slug); err != nil {
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

	case buildAwaiting:
		card, found := loadCard(mcpDir, st.Source, st.GateCardID)
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
func (cfg buildConfig) startPlanning(dir, projectDir, mcpDir string, st buildState, dryRun bool) (tickResult, error) {
	res := tickResult{Status: st.Status, Feature: 0}

	idea, ok := loadCard(mcpDir, st.Source, st.CardID)
	if !ok || idea.Dismissed {
		// The idea was deleted between scheduling the build and its start time —
		// only possible on the scheduled path, since the handler loads the card
		// first. There is nothing to write a plan from, so stop and say why rather
		// than run the planner against an empty prompt.
		//
		// A dismissed card counts as deleted: dismissing IS how an idea is deleted
		// from the dashboard, and the card file stays on disk afterwards. Deleting
		// the idea already stops the build directly (see stopBuildsForCard), so
		// reaching here means the dismissal came through some other door — the
		// orchestrator's own dismiss_card tool, or a server that was down at the
		// time — and this is the backstop that keeps a thrown-away idea from being
		// built anyway.
		res.Action = "halt"
		res.Detail = "the idea card is gone"
		res.Status = buildHalted
		if dryRun {
			return res, nil
		}
		return res, cfg.halt(dir, mcpDir, st, "the idea was deleted before the build started")
	}

	prompt := planningPrompt(idea.Title, idea.Body)
	res.Action = "plan"
	res.Status = buildPlanning
	res.Detail = "writing the project plan"
	if dryRun {
		res.Prompt = prompt
		return res, nil
	}

	wasScheduled := st.StartAt != ""
	st.Status = buildPlanning
	st.Feature = 0
	st.LastRun = nowStamp()
	st.StartAt = "" // spent — from here on the build's own status says where it is
	st.Note = ""
	if err := saveBuild(dir, st); err != nil {
		return res, err
	}
	if wasScheduled {
		// Collapse the scheduled pair down to the recurring line: the exact-minute
		// one has done its job, and a date-pinned crontab entry left behind would
		// come back around in a year. Logged rather than fatal — the build has
		// started, and refusing to advance it now would be the worse outcome.
		if err := installCronLine(cfg.cron, st.Slug, cronLineFor(cfg.root, st.Slug)); err != nil {
			log.Printf("build: %s cron: %v", st.Slug, err)
		}
	}
	stampIdeaCard(mcpDir, st)

	sess, created := cfg.reg.findOrCreateForRun(buildSessionID(st.Slug, 0), sessionKindBuild)
	if !created {
		res.Action = "busy"
		res.Detail = "the planning run is already in flight"
		return res, nil
	}
	logPath := filepath.Join(dir, "runs", "plan.log")
	startBuildProcess(sess, projectDir, logPath, prompt, cfg.runTimeout, func(err error) {
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
func (cfg buildConfig) startFeature(dir, projectDir, mcpDir string, st buildState, n int, dryRun bool) (tickResult, error) {
	res := tickResult{Status: st.Status, Feature: n}
	feats := readPlan(projectDir, st)

	var target planFeature
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
		res.Status = buildDone
		if dryRun {
			return res, nil
		}
		st.Status = buildDone
		st.Note = ""
		st.StartAt = "" // spent: there is no next feature for it to have gated
		if err := saveBuild(dir, st); err != nil {
			return res, err
		}
		if err := removeCronLine(cfg.cron, st.Slug); err != nil {
			log.Printf("build: %s finished but its crontab line did not go: %v", st.Slug, err)
		}
		stampIdeaCard(mcpDir, st)
		settleGateCard(mcpDir, st, "Every feature in the plan is built and validated. Nothing further runs for this project.")
		return res, nil
	}

	prompt := featurePrompt(n)
	res.Action = "feature"
	res.Status = buildBuilding
	res.Detail = fmt.Sprintf("building feature %d: %s", n, target.Title)
	if dryRun {
		res.Prompt = prompt
		return res, nil
	}

	prevGate, prevFeature := st.GateCardID, st.Feature
	wasScheduled := st.StartAt != ""
	st.Feature = n
	st.Status = buildBuilding
	st.GateCardID = gateCardID(st.Slug, n)
	st.LastRun = nowStamp()
	st.Note = ""
	st.StartAt = "" // spent — from here on the build's own status says where it is
	if err := saveBuild(dir, st); err != nil {
		return res, err
	}
	if wasScheduled {
		// The same collapse startPlanning does: the exact-minute line the user's
		// chosen start installed has fired, and a date-pinned entry left in the
		// crontab would come back around in a year.
		if err := installCronLine(cfg.cron, st.Slug, cronLineFor(cfg.root, st.Slug)); err != nil {
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

	sess, created := cfg.reg.findOrCreateForRun(buildSessionID(st.Slug, n), sessionKindBuild)
	if !created {
		res.Action = "busy"
		res.Detail = "a run for this feature is already in flight"
		return res, nil
	}
	logPath := filepath.Join(dir, "runs", fmt.Sprintf("%d.log", n))
	startBuildProcess(sess, projectDir, logPath, prompt, cfg.runTimeout, func(err error) {
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
func (cfg buildConfig) gateFeature(dir, projectDir, mcpDir string, prev buildState, note string) error {
	st, ok := loadBuild(dir)
	if !ok {
		return fmt.Errorf("build state vanished for %q", prev.Slug)
	}
	// A stop (or a rejection) landed while the run was going: honour it and don't
	// resurrect the build with a fresh gate card.
	if !buildActive(st.Status) {
		return nil
	}
	st.Status = buildAwaiting
	st.LastRun = nowStamp()
	st.Note = note
	if st.GateCardID == "" {
		st.GateCardID = gateCardID(st.Slug, st.Feature)
	}
	if err := saveBuild(dir, st); err != nil {
		return err
	}

	var feat planFeature
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
func (cfg buildConfig) halt(dir, mcpDir string, st buildState, reason string) error {
	st.Status = buildHalted
	st.Note = reason
	st.StartAt = "" // nothing is due any more, and a time left here would say otherwise
	saveErr := saveBuild(dir, st)
	if err := removeCronLine(cfg.cron, st.Slug); err != nil {
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

// stopBuild is the whole "this build is over" sequence, in the order that leaves
// the least behind: kill whatever run is in flight, halt the state (which takes
// the crontab line out), and settle the step card that was asking the user for a
// decision about a build that no longer exists.
//
// Both doors into it — the stop button on the idea page, and deleting the idea
// itself — go through here, so a build stopped either way leaves the same
// nothing behind.
func (cfg buildConfig) stopBuild(dir, mcpDir string, st buildState, reason string) error {
	if cfg.reg != nil {
		if sess := cfg.reg.get(buildSessionID(st.Slug, st.Feature)); sess != nil {
			sess.kill()
			cfg.reg.remove(sess.id)
		}
	}
	if err := cfg.halt(dir, mcpDir, st, reason); err != nil {
		return err
	}
	st.Status = buildHalted
	st.StartAt = ""
	settleGateCard(mcpDir, st, "This build was stopped — "+reason+". Nothing further runs, and the code already built stays where it is.")
	return nil
}

// stopBuildsForCard stops every live build that the dismissed card was driving,
// and is what dismissing a card on the dashboard calls. Two kinds of card lead
// here, and both end a build:
//
//   - The idea card. The build only ever existed to turn that idea into a
//     project, so an idea the user threw away must not leave a crontab line
//     ticking a build behind it.
//   - The gate card of the feature waiting to be validated. Dismissing it is how
//     the user rejects a feature, which stops the build — and stopping it has to
//     happen here, on the dismissal itself. The tick reads the same field, but
//     only when it next comes round: leaving it to that means "stop" takes effect
//     up to buildTickMinutes later, with the crontab line still armed in between.
//
// It scans the project folders rather than reading the build stamp off the card,
// because the stamp is a convenience for the phone (it's how the idea page knows
// its lock) and it lives in a payload that a later orchestrator write could
// replace. build.json is the record. The scan is a directory read and a small
// JSON file per project — cheap enough to do on a card dismissal, and the only
// version of this that can't leave an entry behind.
//
// Deliberately not gated on cfg.enabled: a server started without -allow-code
// and -allow-exec can't start builds, but the crontab lines an earlier run armed
// are still there, and this is the one thing that should still clean them up.
func (cfg buildConfig) stopBuildsForCard(mcpDir, source, cardID string) {
	if cfg.projectsBase == "" || cardID == "" {
		return
	}
	entries, err := os.ReadDir(cfg.projectsBase)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := cfg.buildDir(e.Name())
		st, ok := loadBuild(dir)
		if !ok || st.Source != source || !buildActive(st.Status) {
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
		case st.GateCardID == cardID && st.Status == buildAwaiting:
			reason = "feature " + strconv.Itoa(st.Feature) + " was rejected"
			why = "feature " + strconv.Itoa(st.Feature) + " was rejected on the dashboard"
		default:
			continue
		}
		if err := cfg.stopBuild(dir, mcpDir, st, reason); err != nil {
			log.Printf("build: %s stop after a card was dismissed: %v", st.Slug, err)
			continue
		}
		log.Printf("build: stopped %s — %s", st.Slug, why)
	}
}

// settleGateCard closes a step card out where it stands: the stamp goes to the
// build's real state and the body says what became of the decision, so a card
// that can no longer be acted on stops asking to be.
//
// It does NOT dismiss the card. A step card is the user's own record of a feature
// — the one place the dashboard says feature 3 was built and what happened to it
// — and clearing it is the user's call, made by dragging it off like any other
// card. The server retiring them by hand meant stopping a build made the step you
// were looking at vanish, which reads as data loss rather than as a stop.
func settleGateCard(mcpDir string, st buildState, outcome string) {
	if st.GateCardID == "" || !validSlug(st.GateCardID) {
		return
	}
	_, _ = updateCard(mcpDir, st.Source, st.GateCardID, func(c *dashCard) {
		if c.Payload == nil {
			c.Payload = map[string]any{}
		}
		c.Payload["build"] = buildStamp(st)
		c.Body = "> " + outcome + "\n\n" + stripOutcome(c.Body)
		// It is no longer a decision waiting on anyone, so it stops sitting at the
		// top of the list next to the ones that are.
		c.Priority = "low"
	})
}

// stripOutcome removes the blockquote a previous settle put at the top of a step
// card's body, so a card settled twice (validated, then the build stopped) reads
// as what happened last rather than as a stack of outcomes.
//
// The leading blockquote is ours by construction: writeGateCard opens with a plain
// sentence, and everything below it is the plan's own text, which this never
// reaches — it stops at the first line that isn't quoted.
func stripOutcome(body string) string {
	lines := strings.Split(body, "\n")
	i := 0
	for i < len(lines) && strings.HasPrefix(lines[i], ">") {
		i++
	}
	if i == 0 {
		return body
	}
	for i < len(lines) && strings.TrimSpace(lines[i]) == "" {
		i++
	}
	return strings.Join(lines[i:], "\n")
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type buildStartRequest struct {
	CardID  string `json:"card_id"`
	Source  string `json:"source"`
	Project string `json:"project"`
	// StartAt is when the user wants the build to begin, RFC3339. Empty — or a time
	// that has effectively already arrived — means now, which is the default the
	// phone offers and by far the common case.
	StartAt string `json:"start_at,omitempty"`
}

// buildStartSoon is how near a requested start has to be to simply be "now". It
// absorbs the clock skew between a phone and the server, and stops a start time
// a few seconds out from pinning a crontab entry that would fire before the
// crontab write had even settled. A constant, not a flag: it's a property of
// clocks, not of the machine this runs on.
const buildStartSoon = 90 * time.Second

// buildResponse is the shape /build, /build/start and /build/stop all answer with,
// so the phone parses one thing.
type buildResponse struct {
	buildState
	Project string `json:"project"` // absolute project dir, for the "where is it" line
	// Overview is the plan's Overview section — the idea this project came from, in
	// the user's own words. The phone shows it above the features, which is where
	// the idea is read now that its card has come off the dashboard.
	Overview string        `json:"overview,omitempty"`
	Features []planFeature `json:"features"` // the parsed plan, statuses stamped
	Session  string        `json:"session"`  // session id to watch this build's current run on /code
}

func (cfg buildConfig) response(slug string, st buildState) buildResponse {
	projectDir := filepath.Join(cfg.projectsBase, slug)
	return buildResponse{
		buildState: st,
		Project:    projectDir,
		Overview:   parsePlanOverview(readPlanDoc(projectDir)),
		Features:   readPlan(projectDir, st),
		Session:    buildSessionID(slug, st.Feature),
	}
}

// buildStartHandler turns an idea card into a project folder with a plan, and
// arms the cron line that will build it.
//
// The planning run happens on the durable-session machinery the rest of the
// server uses, so the phone can watch the plan being written with the /code
// transcript UI it already has, and so a dropped socket doesn't kill it.
func buildStartHandler(token string, cfg buildConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !cfg.gateRequest(w, r, token) {
			return
		}
		var req buildStartRequest
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		name := strings.TrimSpace(req.Project)
		if name == "" {
			http.Error(w, "empty project name", http.StatusBadRequest)
			return
		}
		if !validSlug(req.CardID) || !validSlug(req.Source) {
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
			if time.Until(t) > buildStartSoon {
				startAt = t
			}
		}
		mcpDir, _ := rootDirs(cfg.root)
		idea, ok := loadCard(mcpDir, req.Source, req.CardID)
		if !ok {
			http.Error(w, "card not found", http.StatusNotFound)
			return
		}

		projectDir, slug, err := resolveProjectDir(cfg.projectsBase, name)
		if err != nil {
			http.Error(w, "bad project name", http.StatusBadRequest)
			return
		}
		dir := cfg.buildDir(slug)
		if existing, ok := loadBuild(dir); ok && buildActive(existing.Status) {
			// Two builds in one folder would have two agents editing the same tree.
			http.Error(w, "that project already has a build running", http.StatusConflict)
			return
		}

		st := buildState{
			Slug:   slug,
			CardID: req.CardID,
			Source: req.Source,
			// Captured now, while the idea is certainly still on the dashboard: from
			// the first step card onwards this is the only name the build has for it.
			Idea:    strings.TrimSpace(idea.Title),
			Status:  buildPlanning,
			Feature: 0,
			LastRun: nowStamp(),
		}
		if !startAt.IsZero() {
			// Nothing has run and nothing will until the start time, so the build
			// waits in `scheduled` with no last-run to report. The idea stays the
			// user's to keep editing until then — the plan hasn't been written from
			// it yet.
			st.Status = buildScheduled
			st.StartAt = startAt.UTC().Format(time.RFC3339)
			st.LastRun = ""
		}
		if err := saveBuild(dir, st); err != nil {
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
		if err := writeTickDriver(cfg); err != nil {
			http.Error(w, "could not write the tick driver: "+err.Error(), http.StatusInternalServerError)
			return
		}
		// A scheduled build takes its exact-minute line and the recurring one; an
		// immediate build just the recurring one.
		line := cronLineFor(cfg.root, slug)
		if !startAt.IsZero() {
			line = scheduledCronLines(cfg.root, slug, startAt)
		}
		if err := installCronLine(cfg.cron, slug, line); err != nil {
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
			if fresh, ok := loadBuild(dir); ok {
				st = fresh
			}
			log.Printf("build: started %s from card %s/%s", slug, req.Source, req.CardID)
		} else {
			log.Printf("build: scheduled %s from card %s/%s for %s", slug, req.Source, req.CardID, st.StartAt)
		}
		writeJSON(w, cfg.response(slug, st))
	}
}

// buildScheduleRequest sets when a build's next run happens.
type buildScheduleRequest struct {
	Slug string `json:"slug"`
	// StartAt is the new start, RFC3339. Absent — or near enough to now to be
	// indistinguishable from it — means "start it now", the same choice the
	// picker offers on /build/start, so it has to mean the same thing here.
	StartAt string `json:"start_at,omitempty"`
}

// buildScheduleHandler says when a build's next run happens. Two states can
// answer that question, and it is the same question in both:
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
func buildScheduleHandler(token string, cfg buildConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !cfg.gateRequest(w, r, token) {
			return
		}
		var req buildScheduleRequest
		if json.NewDecoder(r.Body).Decode(&req) != nil || !validSlug(req.Slug) {
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
			if time.Until(t) > buildStartSoon {
				startAt = t
			}
		}
		dir := cfg.buildDir(req.Slug)
		st, ok := loadBuild(dir)
		if !ok {
			http.Error(w, "no build for that project", http.StatusNotFound)
			return
		}
		if st.Status != buildScheduled && st.Status != buildAwaiting {
			http.Error(w, "that build has no next run to schedule", http.StatusConflict)
			return
		}
		mcpDir, _ := rootDirs(cfg.root)

		if st.Status == buildAwaiting {
			cfg.scheduleNextFeature(w, dir, mcpDir, st, startAt)
			return
		}

		if startAt.IsZero() {
			// Brought forward to now. This is precisely the transition a due tick
			// makes, so take that path rather than keep a second copy of it: same
			// cron collapse, same lock landing on the idea, same planning run the
			// phone can watch.
			projectDir := filepath.Join(cfg.projectsBase, req.Slug)
			if _, perr := cfg.startPlanning(dir, projectDir, mcpDir, st, false); perr != nil {
				log.Printf("build: %s planning: %v", req.Slug, perr)
			}
			if fresh, ok := loadBuild(dir); ok {
				st = fresh
			}
			log.Printf("build: %s brought forward to now", req.Slug)
			writeJSON(w, cfg.response(req.Slug, st))
			return
		}

		// State before crontab, deliberately. The tick checks the clock against
		// StartAt on disk, so the saved time is what actually gates the start: if
		// the crontab write then fails, the worst case is a build that starts late
		// off the recurring line, never one that starts earlier than was just
		// asked for — with the idea still being edited.
		st.StartAt = startAt.UTC().Format(time.RFC3339)
		if err := saveBuild(dir, st); err != nil {
			http.Error(w, "could not save the new start time", http.StatusInternalServerError)
			return
		}
		if err := installCronLine(cfg.cron, req.Slug, scheduledCronLines(cfg.root, req.Slug, startAt)); err != nil {
			http.Error(w, "could not reschedule the build: "+err.Error(), http.StatusInternalServerError)
			return
		}
		stampIdeaCard(mcpDir, st)
		log.Printf("build: rescheduled %s for %s", req.Slug, st.StartAt)
		writeJSON(w, cfg.response(req.Slug, st))
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
func (cfg buildConfig) scheduleNextFeature(w http.ResponseWriter, dir, mcpDir string, st buildState, startAt time.Time) {
	if st.GateCardID == "" || !validSlug(st.GateCardID) {
		http.Error(w, "that build has no step waiting to be validated", http.StatusConflict)
		return
	}
	card, found := loadCard(mcpDir, st.Source, st.GateCardID)
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
	if err := saveBuild(dir, st); err != nil {
		http.Error(w, "could not save the new start time", http.StatusInternalServerError)
		return
	}
	if _, ok := updateCard(mcpDir, st.Source, st.GateCardID, func(c *dashCard) { c.Done = true }); !ok {
		http.Error(w, "could not validate that step", http.StatusInternalServerError)
		return
	}

	if !startAt.IsZero() {
		if err := installCronLine(cfg.cron, st.Slug, scheduledCronLines(cfg.root, st.Slug, startAt)); err != nil {
			http.Error(w, "could not schedule the next feature: "+err.Error(), http.StatusInternalServerError)
			return
		}
		stampIdeaCard(mcpDir, st)
		stampGateCard(mcpDir, st)
		log.Printf("build: %s feature %d validated; feature %d due %s",
			st.Slug, st.Feature, st.Feature+1, st.StartAt)
		writeJSON(w, cfg.response(st.Slug, st))
		return
	}

	// Now. The tick is the one place a build moves forward, so hand it over rather
	// than start the feature from here: same recovery, same gate card handling, same
	// path the dashboard's complete button reaches half an hour later.
	if _, err := cfg.tick(st.Slug, false); err != nil {
		log.Printf("build: %s tick after validating feature %d: %v", st.Slug, st.Feature, err)
	}
	if fresh, ok := loadBuild(dir); ok {
		st = fresh
	}
	log.Printf("build: %s feature %d validated; next feature started", st.Slug, st.Feature)
	writeJSON(w, cfg.response(st.Slug, st))
}

// buildReviseRequest is what the user typed on a step card: a change they want
// made to the feature they were just shown, before they'll sign it off.
type buildReviseRequest struct {
	Slug string `json:"slug"`
	Note string `json:"note"`
}

// buildReviseNoteMax bounds what one message can carry. It is generous — several
// paragraphs of "here's what's wrong with it" — and exists only so a runaway
// client can't hand an unbounded argv to a process. A constant, not a flag: it's a
// property of the prompt, not of the machine.
const buildReviseNoteMax = 4000

// buildReviseHandler takes the user's word back into the project: it starts a run
// in the project directory that does what they asked, then lands them back at the
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
func buildReviseHandler(token string, cfg buildConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !cfg.gateRequest(w, r, token) {
			return
		}
		var req buildReviseRequest
		if json.NewDecoder(r.Body).Decode(&req) != nil || !validSlug(req.Slug) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		note := strings.TrimSpace(req.Note)
		if note == "" {
			http.Error(w, "empty note", http.StatusBadRequest)
			return
		}
		if len(note) > buildReviseNoteMax {
			note = note[:buildReviseNoteMax]
		}
		dir := cfg.buildDir(req.Slug)
		st, ok := loadBuild(dir)
		if !ok {
			http.Error(w, "no build for that project", http.StatusNotFound)
			return
		}
		if st.Status != buildAwaiting {
			http.Error(w, "that build isn't paused at a step, so there is nothing to revise", http.StatusConflict)
			return
		}
		if cfg.runInFlight(req.Slug, st.Feature) {
			http.Error(w, "a run for this feature is already in flight", http.StatusConflict)
			return
		}
		mcpDir, _ := rootDirs(cfg.root)
		projectDir := filepath.Join(cfg.projectsBase, req.Slug)
		if err := ensureGitignore(projectDir); err != nil {
			log.Printf("build: %s gitignore: %v", req.Slug, err)
		}

		st.Status = buildBuilding
		st.LastRun = nowStamp()
		st.Note = "revising feature " + strconv.Itoa(st.Feature) + ": " + shortNote(note)
		// Any time the user had put on the next feature is withdrawn with the sign-off
		// it came with — they've asked for changes to this one instead. The dated
		// crontab line can stay: it fires into a build that says "wait", which is what
		// every spent line does.
		st.StartAt = ""
		if err := saveBuild(dir, st); err != nil {
			http.Error(w, "could not start the revision", http.StatusInternalServerError)
			return
		}
		// A step being revised is not a step that was signed off, so the tick can't
		// read a stale yes off it and move on while the run is still going.
		_, _ = updateCard(mcpDir, st.Source, st.GateCardID, func(c *dashCard) { c.Done = false })
		stampIdeaCard(mcpDir, st)
		stampGateCard(mcpDir, st)

		// Same session id as the feature's own run, so the phone watches a revision
		// on /code exactly as it watches the build that produced it.
		sess, created := cfg.reg.findOrCreateForRun(buildSessionID(st.Slug, st.Feature), sessionKindBuild)
		if !created {
			http.Error(w, "a run for this feature is already in flight", http.StatusConflict)
			return
		}
		logPath := filepath.Join(dir, "runs", fmt.Sprintf("%d-revise-%d.log", st.Feature, time.Now().Unix()))
		startBuildProcess(sess, projectDir, logPath, revisionPrompt(st.Feature, note), cfg.runTimeout, func(err error) {
			outcome := "revised at your request: " + shortNote(note)
			if err != nil {
				outcome = "the revision run reported: " + err.Error()
			}
			if gerr := cfg.gateFeature(dir, projectDir, mcpDir, st, outcome); gerr != nil {
				log.Printf("build: %s re-gate after revising feature %d: %v", st.Slug, st.Feature, gerr)
			}
		})
		log.Printf("build: %s revising feature %d", st.Slug, st.Feature)
		writeJSON(w, cfg.response(req.Slug, st))
	}
}

// shortNote trims a user's message down to something that reads as one line where
// the build's state is shown. The full text goes to the run; this is the label.
func shortNote(note string) string {
	flat := strings.Join(strings.Fields(note), " ")
	if len(flat) <= 140 {
		return flat
	}
	return flat[:139] + "…"
}

// buildStateHandler answers GET /build?slug= with the build's state and its parsed
// plan — what the idea overlay's progress toggle renders.
func buildStateHandler(token string, cfg buildConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !cfg.gateRequest(w, r, token) {
			return
		}
		slug := r.URL.Query().Get("slug")
		if !validSlug(slug) {
			http.Error(w, "bad slug", http.StatusBadRequest)
			return
		}
		st, ok := loadBuild(cfg.buildDir(slug))
		if !ok {
			http.Error(w, "no build for that project", http.StatusNotFound)
			return
		}
		writeJSON(w, cfg.response(slug, st))
	}
}

// buildStopHandler halts a build: the crontab line goes, the status goes to
// halted, and the idea card's lock clears so the user can talk about the idea
// again. Any run currently in flight is killed — a stop the user has to wait
// eight minutes for isn't a stop.
func buildStopHandler(token string, cfg buildConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !cfg.gateRequest(w, r, token) {
			return
		}
		var req struct {
			Slug string `json:"slug"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || !validSlug(req.Slug) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		dir := cfg.buildDir(req.Slug)
		st, ok := loadBuild(dir)
		if !ok {
			// No build state, but there may well still be a crontab line: the state
			// file lives in the project folder, so anything that removed .nestnote/
			// (or the folder's contents) by hand leaves the schedule armed and this
			// the only request that will ever ask about that slug. Sweep it, then
			// answer honestly that there was no build here.
			if err := removeCronLine(cfg.cron, req.Slug); err != nil {
				log.Printf("build: stop %s left its crontab line: %v", req.Slug, err)
			}
			http.Error(w, "no build for that project", http.StatusNotFound)
			return
		}
		mcpDir, _ := rootDirs(cfg.root)
		if err := cfg.stopBuild(dir, mcpDir, st, "stopped from the idea page"); err != nil {
			http.Error(w, "could not stop the build", http.StatusInternalServerError)
			return
		}
		st, _ = loadBuild(dir)
		log.Printf("build: stopped %s", req.Slug)
		writeJSON(w, cfg.response(req.Slug, st))
	}
}

// buildTickHandler is what the cron driver pokes. It is authed like everything
// else — it starts an unattended agent run, so a bearer token and the same
// -allow-code + -allow-exec + -root gate apply — and localhost-only only by
// convention, never by trust.
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
func buildTickHandler(token string, cfg buildConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !cfg.gateRequest(w, r, token) {
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
		writeJSON(w, res)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
