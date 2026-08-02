package build

import (
	"fmt"
	"strings"
)

// The three prompts an unattended run can be given. They are kept together, and
// apart from the state machine that chooses between them, because their wording
// is the actual contract with the agent: "## Feature N" is load-bearing grammar,
// and "then stop" is what makes the gate a gate.

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
		title, strings.TrimSpace(idea), planName)
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
		planName, n, prior, planName, dirName, gitignoreRule)
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
		n, planName, note, planName, planName, n, planName, dirName)
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
