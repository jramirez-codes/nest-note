package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// mcpSetup is the outcome of scaffolding a root: where Claude should run and
// which MCP config files to hand it. When -root is unset the server keeps its
// original single-workdir behaviour and none of this runs.
type mcpSetup struct {
	projectsDir  string
	mcpConfigs   []string // absolute paths to mcp.json files, passed to --mcp-config
	servers      []string // capability server names that were built and registered
	allowedTools []string // --allowedTools patterns pre-authorizing exactly these servers
}

// scaffoldRoot lays out <root>/{projects,mcp,orchestrator}, (re)writes the
// generated Go for the orchestrator and the seed dog server, builds every
// capability server it finds under mcp/, and regenerates the mcp.json files
// that point Claude at the resulting binaries.
//
// It is idempotent and safe to run on every request: user-owned templates
// (dog/main.go, capability.json) are only written when absent, library code and
// config are rewritten only when their content actually changes, and binaries
// rebuild only when their sources are newer — so the steady-state cost is a
// couple of stats. threshold sets how many mentions a subject needs before the
// orchestrator proposes a server for it.
func scaffoldRoot(root string, threshold int) (mcpSetup, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return mcpSetup{}, err
	}

	projects := filepath.Join(root, "projects")
	mcpDir := filepath.Join(root, "mcp")
	orchDir := filepath.Join(root, "orchestrator")
	stateDir := filepath.Join(orchDir, "state")

	for _, d := range []string{
		projects,
		filepath.Join(mcpDir, "mcpx"),
		filepath.Join(mcpDir, "dog"),
		filepath.Join(mcpDir, "bin"),
		filepath.Join(orchDir, "mcpx"),
		filepath.Join(orchDir, "bin"),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return mcpSetup{}, fmt.Errorf("mkdir %s: %w", d, err)
		}
	}

	// Library code and module files: rewritten only when their content changed,
	// so their modtimes stay stable and the build guard below stays effective.
	for _, f := range []struct{ path, content string }{
		{filepath.Join(mcpDir, "go.mod"), goModTmpl("ainotepad-mcp")},
		{filepath.Join(mcpDir, "mcpx", "mcpx.go"), mcpxTmpl},
		{filepath.Join(orchDir, "go.mod"), goModTmpl("ainotepad-orchestrator")},
		{filepath.Join(orchDir, "mcpx", "mcpx.go"), mcpxTmpl},
		{filepath.Join(orchDir, "main.go"), orchestratorMainTmpl},
	} {
		if err := writeIfChanged(f.path, f.content); err != nil {
			return mcpSetup{}, err
		}
	}

	// User-owned seed: only written if absent so edits survive a restart.
	if err := writeIfMissing(filepath.Join(mcpDir, "dog", "main.go"), dogMainTmpl); err != nil {
		return mcpSetup{}, err
	}
	if err := writeIfMissing(filepath.Join(mcpDir, "dog", "capability.json"), dogCapabilityTmpl); err != nil {
		return mcpSetup{}, err
	}

	// Turn any creation requests the orchestrator queued into real server
	// folders before we scan/build, so an approved subject is live this run.
	if err := materializeRequests(mcpDir, stateDir); err != nil {
		return mcpSetup{}, err
	}

	// Build every capability server found under mcp/ (any subdir with a
	// main.go, except the shared library and bin output dirs). Dropping in a
	// new folder is all it takes to add a server.
	entries, err := os.ReadDir(mcpDir)
	if err != nil {
		return mcpSetup{}, fmt.Errorf("read mcp dir: %w", err)
	}
	servers := map[string]string{} // name -> absolute binary path
	var names []string
	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() || name == "mcpx" || name == "bin" {
			continue
		}
		if _, err := os.Stat(filepath.Join(mcpDir, name, "main.go")); err != nil {
			continue
		}
		bin := filepath.Join(mcpDir, "bin", name)
		// Rebuild when the server's own sources or the shared mcpx/go.mod are newer.
		if needsBuild(bin, filepath.Join(mcpDir, name), filepath.Join(mcpDir, "mcpx"), filepath.Join(mcpDir, "go.mod")) {
			if err := goBuild(mcpDir, bin, "./"+name); err != nil {
				return mcpSetup{}, fmt.Errorf("build mcp server %q: %w", name, err)
			}
		}
		servers[name] = bin
		names = append(names, name)
	}
	sort.Strings(names)

	orchBin := filepath.Join(orchDir, "bin", "orchestrator")
	if needsBuild(orchBin, filepath.Join(orchDir, "main.go"), filepath.Join(orchDir, "mcpx"), filepath.Join(orchDir, "go.mod")) {
		if err := goBuild(orchDir, orchBin, "."); err != nil {
			return mcpSetup{}, fmt.Errorf("build orchestrator: %w", err)
		}
	}

	// Regenerate the mcp.json config files with the freshly built binary paths.
	mcpCfg := filepath.Join(mcpDir, "mcp.json")
	if err := writeMcpConfig(mcpCfg, servers, nil); err != nil {
		return mcpSetup{}, err
	}
	orchCfg := filepath.Join(orchDir, "mcp.json")
	orchServers := map[string]string{"orchestrator": orchBin}
	orchArgs := map[string][]string{"orchestrator": {
		"-mcp-dir", mcpDir,
		"-state-dir", stateDir,
		"-threshold", strconv.Itoa(threshold),
	}}
	if err := writeMcpConfig(orchCfg, orchServers, orchArgs); err != nil {
		return mcpSetup{}, err
	}

	// Pre-authorize exactly the scaffolded MCP servers (server-level patterns),
	// so the headless -p run can call their tools without a permission prompt —
	// while Bash/Edit and any other tool stay gated as before.
	allowed := []string{"mcp__orchestrator"}
	for _, n := range names {
		allowed = append(allowed, "mcp__"+n)
	}

	return mcpSetup{
		projectsDir: projects,
		// Orchestrator first so its discovery tool is prominent in the list.
		mcpConfigs:   []string{orchCfg, mcpCfg},
		servers:      names,
		allowedTools: allowed,
	}, nil
}

// writeMcpConfig writes a Claude .mcp.json registering each named server as a
// stdio command at its absolute binary path. args supplies optional per-server
// argv (nil means none).
func writeMcpConfig(path string, servers map[string]string, args map[string][]string) error {
	type serverEntry struct {
		Command string   `json:"command"`
		Args    []string `json:"args"`
	}
	entries := map[string]serverEntry{}
	for name, bin := range servers {
		a := args[name]
		if a == nil {
			a = []string{}
		}
		entries[name] = serverEntry{Command: bin, Args: a}
	}
	doc := map[string]any{"mcpServers": entries}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return writeIfChanged(path, string(data)+"\n")
}

// materializeRequests turns each creation request the orchestrator queued under
// stateDir/requests into a real fact-store server folder under mcpDir, then
// deletes the request, and finally applies any queued consolidations. Subject
// names are validated here (defence in depth on top of the orchestrator's own
// slugging) so a request file can never write outside mcpDir.
func materializeRequests(mcpDir, stateDir string) error {
	reqDir := filepath.Join(stateDir, "requests")
	if entries, err := os.ReadDir(reqDir); err == nil {
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			reqPath := filepath.Join(reqDir, e.Name())
			var req struct {
				Name    string `json:"name"`
				Summary string `json:"summary"`
			}
			if data, err := os.ReadFile(reqPath); err != nil || json.Unmarshal(data, &req) != nil || !validSlug(req.Name) {
				os.Remove(reqPath) // unreadable or unsafe: drop it
				continue
			}
			if err := seedSubjectServer(mcpDir, req.Name, req.Summary); err != nil {
				return err
			}
			os.Remove(reqPath) // fulfilled
		}
	}
	return materializeConsolidations(mcpDir, stateDir)
}

// seedSubjectServer creates a per-subject fact-store server folder (main.go,
// capability.json, and a seeded <name>.md) under mcpDir if it doesn't exist yet.
// It is a no-op when the folder is already present, so callers can use it to
// lazily ensure a consolidation target exists. name must already be validated.
func seedSubjectServer(mcpDir, name, summary string) error {
	dir := filepath.Join(mcpDir, name)
	if _, err := os.Stat(dir); err == nil {
		return nil // already exists, keep it
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir server %q: %w", name, err)
	}
	if strings.TrimSpace(summary) == "" {
		summary = "Notes and facts about " + name + "."
	}
	main := strings.ReplaceAll(factStoreMainTmpl, "__NAME__", name)
	cap, _ := json.MarshalIndent(map[string]any{
		"name":    name,
		"summary": summary,
		"tools":   []string{name + "_add_note", name + "_notes", name + "_rewrite"},
	}, "", "  ")
	if err := writeIfMissing(filepath.Join(dir, "main.go"), main); err != nil {
		return err
	}
	if err := writeIfMissing(filepath.Join(dir, "capability.json"), string(cap)+"\n"); err != nil {
		return err
	}
	return writeIfMissing(filepath.Join(dir, name+".md"), "# "+name+"\n\n"+summary+"\n")
}

// materializeConsolidations applies each merge the orchestrator queued under
// stateDir/consolidations: it appends every "from" subject's markdown into the
// "into" subject's file, then retires the merged servers (folder + binary). Both
// endpoints are slug-validated so a request can't touch anything outside mcpDir.
func materializeConsolidations(mcpDir, stateDir string) error {
	conDir := filepath.Join(stateDir, "consolidations")
	entries, err := os.ReadDir(conDir)
	if err != nil {
		return nil // nothing queued
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		reqPath := filepath.Join(conDir, e.Name())
		var req struct {
			Into string   `json:"into"`
			From []string `json:"from"`
		}
		if data, err := os.ReadFile(reqPath); err != nil || json.Unmarshal(data, &req) != nil || !validSlug(req.Into) {
			os.Remove(reqPath) // unreadable or unsafe: drop it
			continue
		}
		if err := seedSubjectServer(mcpDir, req.Into, ""); err != nil {
			return err
		}
		intoMd := filepath.Join(mcpDir, req.Into, req.Into+".md")
		for _, from := range req.From {
			if !validSlug(from) || from == req.Into {
				continue
			}
			fromDir := filepath.Join(mcpDir, from)
			body, err := os.ReadFile(filepath.Join(fromDir, from+".md"))
			if err == nil {
				section := "\n\n<!-- consolidated from " + from + " -->\n" + strings.TrimSpace(string(body)) + "\n"
				if f, err := os.OpenFile(intoMd, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644); err == nil {
					f.WriteString(section)
					f.Close()
				}
			}
			os.RemoveAll(fromDir)                         // retire the merged server's sources
			os.Remove(filepath.Join(mcpDir, "bin", from)) // and its stale binary
		}
		os.Remove(reqPath) // fulfilled
	}
	return nil
}

// validSlug accepts only lowercase-alnum-and-hyphen names that aren't the two
// reserved folder names, so a materialized server folder can't escape mcpDir or
// collide with the library/output dirs.
func validSlug(s string) bool {
	if s == "" || s == "mcpx" || s == "bin" {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// needsBuild reports whether out is missing or older than the newest .go/go.mod
// file under any of watch.
func needsBuild(out string, watch ...string) bool {
	oi, err := os.Stat(out)
	if err != nil {
		return true
	}
	var newest time.Time
	for _, w := range watch {
		filepath.WalkDir(w, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "go.mod") {
				if info, e := d.Info(); e == nil && info.ModTime().After(newest) {
					newest = info.ModTime()
				}
			}
			return nil
		})
	}
	return newest.After(oi.ModTime())
}

func goBuild(moduleDir, out, pkg string) error {
	cmd := exec.Command("go", "build", "-o", out, pkg)
	cmd.Dir = moduleDir
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func writeFile(path, content string) error {
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

func writeIfMissing(path, content string) error {
	if _, err := os.Stat(path); err == nil {
		return nil // already exists, keep the user's version
	}
	return writeFile(path, content)
}

// writeIfChanged writes only when the file is absent or its content differs, so
// unchanged regenerated files keep their modtime (and don't trigger rebuilds).
func writeIfChanged(path, content string) error {
	if existing, err := os.ReadFile(path); err == nil && string(existing) == content {
		return nil
	}
	return writeFile(path, content)
}

func goModTmpl(module string) string {
	return fmt.Sprintf("module %s\n\ngo 1.26\n", module)
}
