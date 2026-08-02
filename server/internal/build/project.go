package build

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The project folder is the user's, not ours. Two files in it are the exception,
// and both are re-asserted rather than seeded once — see each for why.

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

// seedProjectClaudeMD writes the project's own CLAUDE.md, which is how each
// unattended run learns the rules it is working under: build one feature, stop,
// and leave .nestnote/ alone. That last part is guidance, not enforcement — the
// re-assertion in ensureGitignore is what actually holds the line — but an agent
// told why a directory is off limits is much less likely to "tidy" it away.
//
// Only written when absent: after feature 1 this is the user's file to edit.
func seedProjectClaudeMD(dir, title string) error {
	body := fmt.Sprintf(`# %s

Built by NestNote, one feature at a time, from `+"`"+planName+"`"+`.

## How this project is built

- `+"`"+planName+"`"+` is the plan of record. Each `+"`"+`## Feature N`+"`"+` section is one
  unattended agent run: build only the feature you were asked for, then stop.
- After each feature the build pauses until the user validates it from the
  NestNote dashboard, so leave the repo in a state someone can read and run.
- Commit your work. The user pushes these repos.

## `+"`"+dirName+"/`"+` is off limits

`+"`"+dirName+"/`"+` is NestNote's own build state — the build's status and run logs,
plus card ids that mean nothing outside this machine. Never edit it, never commit it, and
never drop its entry from `+"`"+`.gitignore`+"`"+`: if a framework generator overwrites that
file, the `+"`"+gitignoreRule+"`"+` rule has to go back in.
`, title)
	if _, err := os.Stat(filepath.Join(dir, "CLAUDE.md")); err == nil {
		return nil // already there, keep the user's version
	}
	return os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte(body), 0o644)
}
