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

	// Bring older roots up to the current notebook layout (a notes/ page folder +
	// notebook.json per folder, cards co-located under each notebook) before anything
	// reads them.
	migrateNotebooks(mcpDir, stateDir)

	// Ensure the data-only "orchestrator" notebook exists so its notes are viewable
	// alongside every subject. It gets no generated query server (see the skip below).
	if err := seedOrchestratorNotebook(mcpDir); err != nil {
		return mcpSetup{}, err
	}

	// Turn any creation requests the orchestrator queued into real server
	// folders before we scan/build, so an approved subject is live this run.
	if err := materializeRequests(mcpDir, stateDir); err != nil {
		return mcpSetup{}, err
	}

	// Refresh every notebook's generated query-layer files (main.go/capability.json)
	// from the current template, so a template change — like the notes.md path — is
	// picked up and rebuilt below. Bare capability servers (no manifest, e.g. dog)
	// are skipped so their hand-written code is never clobbered.
	for _, slug := range listNotebookSlugs(mcpDir) {
		// The orchestrator notebook is data-only — never give it a fact-store query
		// server, which would collide with the real orchestrator MCP's name.
		if slug == orchestratorSlug {
			continue
		}
		if err := seedSubjectServer(mcpDir, slug, ""); err != nil {
			return mcpSetup{}, err
		}
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

// seedSubjectServer lays out (or refreshes) a subject notebook folder under mcpDir:
// the viewable data layer (notebook.json + notes.md) and the generated query layer
// (main.go + capability.json). The generated files are rewritten from the template
// (writeIfChanged) so template changes propagate and rebuild; the notes and manifest
// are only written when absent so their content is never clobbered. Safe to call on
// an existing folder to bring it current. name must already be validated.
func seedSubjectServer(mcpDir, name, summary string) error {
	dir := filepath.Join(mcpDir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir server %q: %w", name, err)
	}
	if strings.TrimSpace(summary) == "" {
		summary = "Notes and facts about " + name + "."
	}

	// Query layer: regenerated from the template so a template change rebuilds.
	main := strings.ReplaceAll(factStoreMainTmpl, "__NAME__", name)
	cap, _ := json.MarshalIndent(map[string]any{
		"name":    name,
		"summary": summary,
		"tools":   []string{name + "_add_note", name + "_notes", name + "_rewrite"},
	}, "", "  ")
	if err := writeIfChanged(filepath.Join(dir, "main.go"), main); err != nil {
		return err
	}
	if err := writeIfChanged(filepath.Join(dir, "capability.json"), string(cap)+"\n"); err != nil {
		return err
	}

	// Data layer: seed an Overview page + manifest only when the notebook has no
	// content pages yet, so existing notes/manifest content is never clobbered. The
	// Appendix is (re)generated from whatever pages exist.
	hasContent := false
	for _, p := range listPages(mcpDir, name) {
		if p.Num != appendixNum {
			hasContent = true
			break
		}
	}
	if !hasContent {
		if err := os.MkdirAll(notesDirFor(mcpDir, name), 0o755); err != nil {
			return err
		}
		overview := filepath.Join(notesDirFor(mcpDir, name), pageFileName(1, "Overview"))
		if err := writeIfMissing(overview, "# Overview\n\n"+summary+"\n"); err != nil {
			return err
		}
	}
	if !isNotebook(mcpDir, name) {
		if err := saveNotebook(mcpDir, notebook{Slug: name, Summary: summary}); err != nil {
			return err
		}
	}
	return rebuildAppendix(mcpDir, name)
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
		for _, from := range req.From {
			if !validSlug(from) || from == req.Into {
				continue
			}
			fromDir := filepath.Join(mcpDir, from)
			// Carry the merged notebook's pages over as one new page in the target,
			// preserving the markdown, then drop the retired folder.
			_ = mergeNotebookPages(mcpDir, from, req.Into)
			// Carry the merged notebook's cards over so they aren't lost with the folder.
			for _, c := range loadCards(mcpDir, from) {
				c.Source = req.Into
				if data, err := json.MarshalIndent(c, "", "  "); err == nil {
					dest := cardsDirFor(mcpDir, req.Into)
					if os.MkdirAll(dest, 0o755) == nil {
						os.WriteFile(filepath.Join(dest, c.ID+".json"), append(data, '\n'), 0o644)
					}
				}
			}
			os.RemoveAll(fromDir)                         // retire the merged server's sources
			os.Remove(filepath.Join(mcpDir, "bin", from)) // and its stale binary
		}
		_ = touchNotebook(mcpDir, req.Into, "") // bump updated_at after the merge
		os.Remove(reqPath)                      // fulfilled
	}
	return nil
}

// validSlug accepts only lowercase-alnum-and-hyphen names that aren't reserved, so a
// materialized server folder can't escape mcpDir, collide with the library/output
// dirs, or shadow the data-only "orchestrator" notebook (whose name belongs to the
// real orchestrator MCP).
func validSlug(s string) bool {
	if s == "" || s == "mcpx" || s == "bin" || s == orchestratorSlug {
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
