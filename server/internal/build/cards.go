package build

import (
	"fmt"
	"log"
	"strings"

	"nestnote/server/internal/store"
)

// gateCardID is the id of the card that gates feature n. It is a store.ValidSlug
// (the project slug is already [a-z0-9-]), so the dashboard's own complete/dismiss
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
func writeGateCard(mcpDir string, st State, feat PlanFeature, projectDir string) error {
	// The idea card, loaded whether or not it has been retired — dismissing leaves
	// the file on disk (see retireIdeaCard), so its tags stay available to every
	// step this build files, and the tag filter keeps working on a project's steps.
	idea, hasIdea := store.LoadCard(mcpDir, st.Source, st.CardID)

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
	if st.Feature == firstFeature && hasIdea && strings.TrimSpace(idea.Body) != "" {
		body += "\n\n---\n\n## The idea\n\n" + strings.TrimSpace(idea.Body)
	}

	var tags []string
	if hasIdea {
		tags = idea.Tags
	}
	if err := store.WriteCard(mcpDir, st.Source, store.Card{
		ID:       st.GateCardID,
		Kind:     cardKind,
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
	if st.Feature == firstFeature {
		retireIdeaCard(mcpDir, st)
	}
	return nil
}

// stepStamp is payload.step: which feature a step card is asking about, and what
// that feature is called. It is what the dashboard row reads to say what is being
// validated under the idea's name, and it never changes after the card is filed.
func stepStamp(st State, feat PlanFeature) map[string]any {
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
// Dismissing is what "delete" means for a card here (see the dashboard's action
// handler): the file stays on disk, which is what keeps the idea readable to later
// step cards and to ensurePlanOverview, and what makes the dashboard's own restore
// work if this turns out to have been wrong.
//
// Deliberately not routed through the /action dismiss path: that is the *user*
// throwing an idea away, which stops the build (StopForCard). This is the build
// moving the idea somewhere better, and it must not stop anything.
func retireIdeaCard(mcpDir string, st State) {
	if st.CardID == "" || !store.ValidSlug(st.CardID) {
		return
	}
	if _, ok := store.UpdateCard(mcpDir, st.Source, st.CardID, func(c *store.Card) {
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
func buildStamp(st State) map[string]any {
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
	// Why the build is where it is — what the last run reported, or the reason it
	// was stopped. Carried for the same reason as start_at: a dashboard row can say
	// what went wrong from the card alone, and a row that only said "Stopped" would
	// make the user open the page to learn the one thing that matters about it.
	if st.Note != "" {
		stamp["note"] = st.Note
	}
	return stamp
}

// stampIdeaCard records the build on the idea card it came from. The app derives
// the idea page's lock from this — not from local state — so the lock survives an
// app restart and is true on every device.
func stampIdeaCard(mcpDir string, st State) {
	stampCard(mcpDir, st.Source, st.CardID, st)
}

// stampGateCard puts the same record on the step card that is currently asking
// for a decision, so opening it shows what the build is actually doing rather
// than an empty stamp the page has to fill in from a fetch.
func stampGateCard(mcpDir string, st State) {
	stampCard(mcpDir, st.Source, st.GateCardID, st)
}

func stampCard(mcpDir, source, cardID string, st State) {
	if cardID == "" || !store.ValidSlug(cardID) {
		return
	}
	_, _ = store.UpdateCard(mcpDir, source, cardID, func(c *store.Card) {
		if c.Payload == nil {
			c.Payload = map[string]any{}
		}
		c.Payload["build"] = buildStamp(st)
	})
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
func settleGateCard(mcpDir string, st State, outcome string) {
	if st.GateCardID == "" || !store.ValidSlug(st.GateCardID) {
		return
	}
	_, _ = store.UpdateCard(mcpDir, st.Source, st.GateCardID, func(c *store.Card) {
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
