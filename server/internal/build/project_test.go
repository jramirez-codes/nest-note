package build

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// .gitignore re-assertion
// ---------------------------------------------------------------------------

// TestEnsureGitignore is the table for the rule that keeps .nestnote/ out of the
// user's repo. It runs on EVERY tick against a file the feature agent is free to
// rewrite, so each row here is a real thing that happens to a live project — most
// of all the framework-generator row, which is why seeding once is not enough.
func TestEnsureGitignore(t *testing.T) {
	cases := []struct {
		name    string
		before  string // "" with exists=false means no .gitignore at all
		exists  bool
		wantHas bool
		keep    []string // substrings that must survive byte-for-byte
	}{
		{name: "no gitignore at all", exists: false, wantHas: true},
		{
			name:    "already contains the rule",
			before:  "node_modules/\n.nestnote/\ndist/\n",
			exists:  true,
			wantHas: true,
			keep:    []string{"node_modules/", "dist/"},
		},
		{
			name:    "unrelated rules survive",
			before:  "*.log\n/build\n",
			exists:  true,
			wantHas: true,
			keep:    []string{"*.log", "/build"},
		},
		{
			name:    "replaced by a framework generator",
			before:  "# Created by create-next-app\n/node_modules\n/.next/\n",
			exists:  true,
			wantHas: true,
			keep:    []string{"/.next/", "/node_modules"},
		},
		{
			name:    "near miss: no trailing slash",
			before:  ".nestnote\n",
			exists:  true,
			wantHas: true,
			keep:    []string{".nestnote\n"},
		},
		{
			name:    "near miss: commented out",
			before:  "#.nestnote/\n",
			exists:  true,
			wantHas: true,
			keep:    []string{"#.nestnote/"},
		},
		{
			name:    "no trailing newline on the last line",
			before:  "*.tmp",
			exists:  true,
			wantHas: true,
			keep:    []string{"*.tmp\n"}, // must be terminated, not glued to our rule
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, ".gitignore")
			if tc.exists {
				if err := os.WriteFile(path, []byte(tc.before), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if err := ensureGitignore(dir); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if gitignoreHasRule(string(got)) != tc.wantHas {
				t.Fatalf("rule present = %v, want %v.\n%s", !tc.wantHas, tc.wantHas, got)
			}
			for _, keep := range tc.keep {
				if !strings.Contains(string(got), keep) {
					t.Fatalf("lost %q from the original file:\n%s", keep, got)
				}
			}
		})
	}
}

// TestEnsureGitignoreTwiceAppendsOnce: the re-assertion runs on every tick, so a
// build that ticks a hundred times must not leave a hundred copies of the rule.
func TestEnsureGitignoreTwiceAppendsOnce(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 3; i++ {
		if err := ensureGitignore(dir); err != nil {
			t.Fatal(err)
		}
	}
	body, err := os.ReadFile(filepath.Join(dir, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(body), gitignoreRule); n != 1 {
		t.Fatalf("rule appears %d times, want 1:\n%s", n, body)
	}
}
