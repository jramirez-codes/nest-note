package build

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"nestnote/server/internal/store"
)

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
	if err := os.WriteFile(filepath.Join(dir, planName), []byte(plan), 0o644); err != nil {
		t.Fatal(err)
	}
	feats := readPlan(dir, State{Feature: 2, Status: statusAwaiting})
	want := []string{statusDone, statusAwaiting, "pending"}
	for i, w := range want {
		if feats[i].Status != w {
			t.Fatalf("feature %d status = %q, want %q", i+1, feats[i].Status, w)
		}
	}
	// A finished build has validated everything, last feature included.
	for i, f := range readPlan(dir, State{Feature: 3, Status: statusDone}) {
		if f.Status != statusDone {
			t.Fatalf("finished build: feature %d = %q, want done", i+1, f.Status)
		}
	}
}

// ---------------------------------------------------------------------------
// The plan's Overview — where the idea ends up
// ---------------------------------------------------------------------------

// TestIdeaOverviewFollowsTheTemplate: an idea filed against the "## Problem /
// ## Idea" template becomes an overview built from exactly those two sections, at
// a heading depth that can't be mistaken for one of the plan's own.
func TestIdeaOverviewFollowsTheTemplate(t *testing.T) {
	got := ideaOverview(store.Card{
		Title: "Greenhouse tracker",
		Body: "## Problem\n\nThe greenhouse is a mystery.\n\n## Idea\n\nA sensor and a chart.\n\n" +
			"## Project plan\n\nSomething long.\n\n## Next steps\n\nAsk Dad.\n",
	})
	for _, want := range []string{
		"## Overview", "**Greenhouse tracker**",
		"### Problem", "The greenhouse is a mystery.",
		"### Idea", "A sensor and a chart.",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("overview is missing %q:\n%s", want, got)
		}
	}
	// The idea's own plan and next steps are not the project's plan — the features
	// below the overview are. Carrying them up here would be two plans in one file.
	if strings.Contains(got, "Something long.") || strings.Contains(got, "Ask Dad.") {
		t.Fatalf("overview swallowed the rest of the idea:\n%s", got)
	}
	// Nothing to say about an idea with nothing in it.
	if got := ideaOverview(store.Card{}); got != "" {
		t.Fatalf("empty idea produced %q, want an empty overview", got)
	}
}

// TestIdeaOverviewKeepsAnUntemplatedIdea: an idea written without the template's
// headings still has to reach the plan. Better a long overview than a project
// whose plan can't say what it is for.
func TestIdeaOverviewKeepsAnUntemplatedIdea(t *testing.T) {
	got := ideaOverview(store.Card{Title: "Greenhouse tracker", Body: "Just a hunch about humidity."})
	if !strings.Contains(got, "Just a hunch about humidity.") {
		t.Fatalf("overview dropped an untemplated idea:\n%s", got)
	}
}

// TestSetPlanOverviewSitsUnderTheTitle: the overview goes below the plan's "#"
// title and above its first "##" section, and replacing one leaves the plan
// otherwise byte-identical — which is what makes re-asserting it on every tick
// free for a plan nobody touched.
func TestSetPlanOverviewSitsUnderTheTitle(t *testing.T) {
	plan := "# Greenhouse tracker\n\nA thing for a greenhouse.\n\n## Feature 1: Skeleton\n\nx\n"
	block := "## Overview\n\n**Greenhouse tracker**\n\n### Problem\n\nA mystery.\n"

	out := setPlanOverview(plan, block)
	title := strings.Index(out, "# Greenhouse tracker")
	overview := strings.Index(out, "## Overview")
	feature := strings.Index(out, "## Feature 1")
	if !(title < overview && overview < feature) {
		t.Fatalf("overview is in the wrong place:\n%s", out)
	}

	// Re-asserting the same block changes nothing at all.
	if again := setPlanOverview(out, block); again != out {
		t.Fatalf("setting the same overview twice rewrote the plan:\n%s", again)
	}
	// A reworded overview is replaced, not stacked, and the features are untouched.
	reworded := strings.Replace(out, "A mystery.", "The agent's own words.", 1)
	back := setPlanOverview(reworded, block)
	if strings.Contains(back, "The agent's own words.") {
		t.Fatalf("a reworded overview survived:\n%s", back)
	}
	if strings.Count(back, "## Overview") != 1 || !strings.Contains(back, "## Feature 1: Skeleton") {
		t.Fatalf("replacing the overview damaged the plan:\n%s", back)
	}
	if parsePlanOverview(back) != parsePlanOverview(out) {
		t.Fatalf("overview did not round-trip:\n%s", back)
	}
}

// TestParsePlanOverviewStopsAtTheFirstFeature: the overview's own "###"
// sub-headings belong to it; the plan's "##" sections do not.
func TestParsePlanOverviewStopsAtTheFirstFeature(t *testing.T) {
	got := parsePlanOverview("# P\n\n## Overview\n\n### Problem\n\nA mystery.\n\n## Feature 1: A\n\nx\n")
	if !strings.Contains(got, "### Problem") || !strings.Contains(got, "A mystery.") {
		t.Fatalf("overview lost its own body: %q", got)
	}
	if strings.Contains(got, "Feature 1") || strings.Contains(got, "x") {
		t.Fatalf("overview ran into the plan: %q", got)
	}
	if got := parsePlanOverview("# P\n\n## Feature 1: A\n\nx\n"); got != "" {
		t.Fatalf("a plan with no overview parsed as %q", got)
	}
}
