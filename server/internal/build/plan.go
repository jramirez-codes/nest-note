package build

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"nestnote/server/internal/store"
)

// planFeatureRe matches a plan's "## Feature N: title" headings. The separator is
// loose (colon, dash, em dash, or nothing) because the heading is written by an
// agent, and a build shouldn't stall on punctuation.
var planFeatureRe = regexp.MustCompile(`^##\s+Feature\s+(\d+)\s*[:.\-—]?\s*(.*)$`)

// planSectionRe matches a top-level ("#") or section-level ("##") heading, which
// ends whatever feature section preceded it. Deeper headings do not: a finished
// run appends a "### Built" note inside its own feature's section, and that note
// belongs to the feature.
var planSectionRe = regexp.MustCompile(`^#{1,2}(\s|$)`)

// PlanFeature is one "## Feature N" section of PROJECT_PLAN.md, with the status
// the build state implies for it. This is what the idea overlay's progress toggle
// renders.
type PlanFeature struct {
	Num    int    `json:"num"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	Status string `json:"status"` // done | building | awaiting-validation | pending
}

// parsePlanFeatures splits a PROJECT_PLAN.md body into its numbered feature
// sections, in file order. Anything before the first heading (the plan's preamble)
// is not a feature and is dropped here; readers who want it read the file.
func parsePlanFeatures(md string) []PlanFeature {
	var out []PlanFeature
	var cur *PlanFeature
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
			cur = &PlanFeature{Num: n, Title: title}
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
	data, err := os.ReadFile(filepath.Join(projectDir, planName))
	if err != nil {
		return ""
	}
	return string(data)
}

// readPlan reads and parses the project's plan, stamping each feature with the
// status the build state implies: everything below the current feature is built
// and validated, the current one is whatever the build is doing to it, and the
// rest are pending.
func readPlan(projectDir string, st State) []PlanFeature {
	doc := readPlanDoc(projectDir)
	if doc == "" {
		return []PlanFeature{}
	}
	feats := parsePlanFeatures(doc)
	for i := range feats {
		switch {
		case feats[i].Num < st.Feature:
			feats[i].Status = statusDone
		case feats[i].Num == st.Feature:
			feats[i].Status = st.Status
		default:
			feats[i].Status = "pending"
		}
		// A finished build has validated everything, including the last feature.
		if st.Status == statusDone {
			feats[i].Status = statusDone
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
func ideaOverview(c store.Card) string {
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
func ensurePlanOverview(projectDir, mcpDir string, st State) {
	doc := readPlanDoc(projectDir)
	if doc == "" {
		return
	}
	// The idea card is loaded even after it has been retired: dismissing is how the
	// dashboard deletes a card, and the file stays on disk. That is what keeps this
	// working for the whole life of a build, not just up to the first step card.
	idea, ok := store.LoadCard(mcpDir, st.Source, st.CardID)
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
	if err := os.WriteFile(filepath.Join(projectDir, planName), []byte(next), 0o644); err != nil {
		log.Printf("build: %s plan overview: %v", st.Slug, err)
	}
}
