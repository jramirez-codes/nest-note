package scaffold

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A root scaffolded before the NestNote rebrand has go.mod files naming the old
// modules and sources importing them. scaffoldRoot regenerates go.mod with the
// current module name, so unless the stale imports are migrated too, the
// user-owned dog/main.go (written only when absent) stops compiling and fails
// the whole scaffold — which on a machine nobody can log into means the
// self-updated server never comes back.
func TestScaffoldRootMigratesPreRebrandRoot(t *testing.T) {
	root := t.TempDir()
	mcpDir := filepath.Join(root, "mcp")
	for _, d := range []string{
		filepath.Join(mcpDir, "mcpx"),
		filepath.Join(mcpDir, "dog"),
		filepath.Join(root, "orchestrator", "mcpx"),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}

	// The pre-rebrand layout: old module name, and a user-edited dog server
	// importing it. The edit ("woof woof") must survive the migration.
	writeTestFile(t, filepath.Join(mcpDir, "go.mod"), "module ainotepad-mcp\n\ngo 1.26\n")
	writeTestFile(t, filepath.Join(mcpDir, "dog", "main.go"),
		"package main\n\nimport \"ainotepad-mcp/mcpx\"\n\n// woof woof\nfunc main() { _ = mcpx.Tool{} }\n")

	if _, err := Root(root, 4); err != nil {
		t.Fatalf("scaffoldRoot on a pre-rebrand root: %v", err)
	}

	dogSrc := readTestFile(t, filepath.Join(mcpDir, "dog", "main.go"))
	if strings.Contains(dogSrc, "ainotepad-mcp/") {
		t.Errorf("dog/main.go still imports the pre-rebrand module:\n%s", dogSrc)
	}
	if !strings.Contains(dogSrc, "nestnote-mcp/mcpx") {
		t.Errorf("dog/main.go should import the current module:\n%s", dogSrc)
	}
	if !strings.Contains(dogSrc, "woof woof") {
		t.Errorf("the user's edits to dog/main.go were clobbered:\n%s", dogSrc)
	}
	if got := readTestFile(t, filepath.Join(mcpDir, "go.mod")); !strings.Contains(got, "module nestnote-mcp") {
		t.Errorf("go.mod = %q, want the current module name", got)
	}
}

// migrateModulePaths rewrites only quoted import prefixes, leaves everything
// else alone, and is safe to run repeatedly (it runs on every scaffold).
func TestMigrateModulePaths(t *testing.T) {
	dir := t.TempDir()
	src := "package main\n\n" +
		"import (\n\t\"ainotepad-mcp/mcpx\"\n\t\"ainotepad-orchestrator/mcpx\"\n)\n\n" +
		"// ainotepad-mcp is mentioned in prose and must stay put.\n" +
		"const note = \"ainotepad-mcp\"\n"
	path := filepath.Join(dir, "main.go")
	writeTestFile(t, path, src)

	// A non-Go file must not be touched.
	other := filepath.Join(dir, "capability.json")
	writeTestFile(t, other, `{"name":"ainotepad-mcp"}`)

	migrateModulePaths(dir)
	got := readTestFile(t, path)

	if !strings.Contains(got, "\"nestnote-mcp/mcpx\"") || !strings.Contains(got, "\"nestnote-orchestrator/mcpx\"") {
		t.Errorf("imports not migrated:\n%s", got)
	}
	if !strings.Contains(got, "// ainotepad-mcp is mentioned in prose") {
		t.Errorf("prose mention was rewritten:\n%s", got)
	}
	if !strings.Contains(got, "const note = \"ainotepad-mcp\"") {
		t.Errorf("a non-import string was rewritten:\n%s", got)
	}
	if o := readTestFile(t, other); o != `{"name":"ainotepad-mcp"}` {
		t.Errorf("non-Go file was rewritten: %s", o)
	}

	// Idempotent: a second pass changes nothing.
	migrateModulePaths(dir)
	if again := readTestFile(t, path); again != got {
		t.Errorf("second pass changed the file:\n%s", again)
	}
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func readTestFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}
