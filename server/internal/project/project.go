// Package project maps a human project name onto its folder under
// <root>/projects. Both the /code agent (which creates and deletes project
// folders) and the build pipeline (which builds in one) resolve names through
// here, so a name always lands on the same folder whichever door it arrives by.
package project

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

// SlugFor reduces a human project name to the [a-z0-9-] folder slug shared by
// ResolveDir (project creation) and the delete handler (removal), so a name
// always maps to the same folder both ways. Empty means "no valid slug".
func SlugFor(name string) string {
	return strings.Trim(slugRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
}

// ResolveDir turns a human project name into projects/<slug> under the base dir,
// creating it if absent, and returns the absolute dir plus the slug. The slug is
// reduced to [a-z0-9-], so there is nothing to traverse with — an empty result is
// the only failure. This is the project namespace the phone's /code <name>
// selects; it is not a sandbox (the agent can still reach anywhere the server's
// user can).
func ResolveDir(base, name string) (dir, slug string, err error) {
	slug = SlugFor(name)
	if slug == "" {
		return "", "", errors.New("empty project name")
	}
	dir = filepath.Join(base, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", err
	}
	return dir, slug, nil
}
