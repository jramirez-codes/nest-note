package build

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nestnote/server/internal/store"
)

// TestFirstStepCardTakesTheIdea is the whole move: the first step card a build
// files stops being "validate feature 1" and becomes the idea — its name, its
// body, its tags — and the idea card comes off the dashboard behind it.
func TestFirstStepCardTakesTheIdea(t *testing.T) {
	f := newBuildFixture(t)
	if err := store.WriteCard(f.mcpDir, f.source, store.Card{
		ID:    "idea-4f2a",
		Kind:  "idea",
		Title: "Greenhouse tracker",
		Body:  "## Problem\n\nThe greenhouse is a mystery.\n\n## Idea\n\nA sensor and a chart.\n",
		Tags:  []string{"garden", "hardware"},
	}); err != nil {
		t.Fatal(err)
	}
	st := State{
		Slug: f.slug, Source: f.source, CardID: "idea-4f2a", Idea: "Greenhouse tracker",
		Status: statusAwaiting, Feature: 1, GateCardID: gateCardID(f.slug, 1),
	}
	feat := PlanFeature{Num: 1, Title: "Running skeleton", Body: "A page that renders."}
	if err := writeGateCard(f.mcpDir, st, feat, f.dir); err != nil {
		t.Fatal(err)
	}

	step, ok := store.LoadCard(f.mcpDir, f.source, st.GateCardID)
	if !ok {
		t.Fatal("no step card was filed")
	}
	if step.Title != "Greenhouse tracker" {
		t.Fatalf("step title = %q, want the idea's name", step.Title)
	}
	// Both halves of what the card is: the idea, and the feature under review.
	if !strings.Contains(step.Body, "A sensor and a chart.") {
		t.Fatalf("the idea did not move onto the step card:\n%s", step.Body)
	}
	if !strings.Contains(step.Body, "Feature 1 — Running skeleton") {
		t.Fatalf("the step card does not say what it is validating:\n%s", step.Body)
	}
	if len(step.Tags) != 2 || step.Tags[0] != "garden" {
		t.Fatalf("tags = %v, want the idea's", step.Tags)
	}
	if p := stepPayload(t, step); p["feature"] != float64(1) || p["title"] != "Running skeleton" {
		t.Fatalf("step payload = %#v", p)
	}

	idea, ok := store.LoadCard(f.mcpDir, f.source, "idea-4f2a")
	if !ok {
		t.Fatal("the idea card was deleted from disk, not retired")
	}
	if !idea.Dismissed {
		t.Fatal("the idea is still in the Ideas section next to the step it moved onto")
	}
}

// TestLaterStepCardsAreNamedByTheIdeaButDoNotRepeatIt: every step of a build is
// named after the project, so a list of steps says whose they are — but the idea
// itself is on the first one, not copied onto all six.
func TestLaterStepCardsAreNamedByTheIdeaButDoNotRepeatIt(t *testing.T) {
	f := newBuildFixture(t)
	st := State{
		Slug: f.slug, Source: f.source, CardID: "idea-4f2a", Idea: "Greenhouse tracker",
		Status: statusAwaiting, Feature: 2, GateCardID: gateCardID(f.slug, 2),
	}
	if err := writeGateCard(f.mcpDir, st, PlanFeature{Num: 2, Title: "Sensor ingest"}, f.dir); err != nil {
		t.Fatal(err)
	}
	step, ok := store.LoadCard(f.mcpDir, f.source, st.GateCardID)
	if !ok {
		t.Fatal("no step card was filed")
	}
	if step.Title != "Greenhouse tracker" {
		t.Fatalf("step title = %q, want the idea's name", step.Title)
	}
	if strings.Contains(step.Body, "The greenhouse is a mystery.") {
		t.Fatalf("the idea was copied onto a later step:\n%s", step.Body)
	}
	if p := stepPayload(t, step); p["feature"] != float64(2) {
		t.Fatalf("step payload = %#v, want feature 2", p)
	}
	// The idea only moves once. Feature 2's card is not the place it happens.
	if idea, _ := store.LoadCard(f.mcpDir, f.source, "idea-4f2a"); idea.Dismissed {
		t.Fatal("a later step retired the idea card")
	}
}

// TestStepCardFallsBackToTheSlug: a build started before the idea's title was
// recorded still has to name its steps something. The folder is a poor name for a
// project but a true one.
func TestStepCardFallsBackToTheSlug(t *testing.T) {
	f := newBuildFixture(t)
	st := State{
		Slug: f.slug, Source: f.source, CardID: "idea-4f2a",
		Status: statusAwaiting, Feature: 2, GateCardID: gateCardID(f.slug, 2),
	}
	if err := writeGateCard(f.mcpDir, st, PlanFeature{Num: 2, Title: "Sensor ingest"}, f.dir); err != nil {
		t.Fatal(err)
	}
	step, _ := store.LoadCard(f.mcpDir, f.source, st.GateCardID)
	if step.Title != f.slug {
		t.Fatalf("step title = %q, want the project slug", step.Title)
	}
}

// TestBuildStartRecordsTheIdeasName: the title is captured while the idea is
// certainly still on the dashboard, because from the first step card onwards it
// is the only name the build has for it.
func TestBuildStartRecordsTheIdeasName(t *testing.T) {
	const token = "secret"
	f := newBuildFixture(t)
	at := time.Now().Add(2 * time.Hour)
	body := fmt.Sprintf(`{"card_id":"idea-4f2a","source":"greenhouse","project":"greenhouse tracker","start_at":%q}`,
		at.Format(time.RFC3339))
	req := httptest.NewRequest(http.MethodPost, "/build/start?token="+token, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	StartHandler(token, f.cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", rec.Code, rec.Body.String())
	}
	st, ok := loadState(f.cfg.buildDir("greenhouse-tracker"))
	if !ok {
		t.Fatal("no build state on disk")
	}
	if st.Idea != "Greenhouse tracker" {
		t.Fatalf("recorded idea name = %q, want the card's title", st.Idea)
	}
	// And it reaches the phone on the stamp every card the build touches carries.
	idea, _ := store.LoadCard(f.mcpDir, f.source, "idea-4f2a")
	stamp, _ := idea.Payload["build"].(map[string]any)
	if stamp["idea"] != "Greenhouse tracker" {
		t.Fatalf("build stamp = %#v, want the idea's name on it", stamp)
	}
}
