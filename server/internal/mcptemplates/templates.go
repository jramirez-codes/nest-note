// Package mcptemplates holds the raw Go-source templates the server writes out
// when scaffolding generated MCP servers (see scaffold.go). Almost everything in
// this file is a string literal — the generated programs' own source — not real
// declarations in this package, so it has no dependency on the rest of the server.
package mcptemplates

import "strings"

// bt swaps the %BT% placeholder for a backtick so the templates below can carry
// Go struct tags while themselves being raw string literals.
func bt(s string) string { return strings.ReplaceAll(s, "%BT%", "`") }

// withPageHelpers splices the shared notebook-page helpers into a generated server
// template at its "//__PAGE_HELPERS__" placeholder, so the fact-store and orchestrator
// servers share one copy of the notes/ layout logic (kept in step with notebook.go).
func withPageHelpers(tmpl string) string {
	return strings.Replace(tmpl, "//__PAGE_HELPERS__", pageHelpersSrc, 1)
}

// pageHelpersSrc is package-agnostic Go source (no package/import lines — the host
// template supplies those) implementing a notebook's notes/ page folder: parsing and
// formatting "#N (Title).md", listing/upserting/rewriting pages, and regenerating the
// "#0 (Appendix).md" index. It has no backticks so it embeds cleanly in a raw template
// literal; it needs the host to import encoding/json, fmt, os, path/filepath, regexp,
// sort, strconv, and strings.
const pageHelpersSrc = `
// --- notebook pages (generated; mirrors the server's notebook.go layout) ------------
// A notebook's notes live in a notes/ folder of "#N (Title).md" pages; page #0 is the
// auto-generated Appendix indexing the rest with [[#N (Title)]] links. Within-notebook
// links are [[#N (Title)]]; cross-notebook links are [[slug::#N (Title)]].

var pageFileRe = regexp.MustCompile("^#([0-9]+) \\((.+)\\)\\.md$")

func sanitizePageTitle(title string) string {
	title = strings.NewReplacer("(", " ", ")", " ", "/", " ", "\n", " ", "\r", " ").Replace(title)
	title = strings.Join(strings.Fields(title), " ")
	if title == "" {
		title = "Untitled"
	}
	if len(title) > 60 {
		title = strings.TrimSpace(title[:60])
	}
	return title
}

func pageFileName(num int, title string) string {
	return fmt.Sprintf("#%d (%s).md", num, sanitizePageTitle(title))
}

func parsePageFile(name string) (int, string, bool) {
	m := pageFileRe.FindStringSubmatch(name)
	if m == nil {
		return 0, "", false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, "", false
	}
	return n, m[2], true
}

type page struct {
	Num   int
	Title string
	File  string
	Body  string
}

func listPagesIn(notesDir string) []page {
	entries, err := os.ReadDir(notesDir)
	if err != nil {
		return nil
	}
	var pages []page
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		num, title, ok := parsePageFile(e.Name())
		if !ok {
			continue
		}
		body, _ := os.ReadFile(filepath.Join(notesDir, e.Name()))
		pages = append(pages, page{Num: num, Title: title, File: e.Name(), Body: string(body)})
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].Num < pages[j].Num })
	return pages
}

func nextPageNum(pages []page) int {
	next := 1
	for _, p := range pages {
		if p.Num >= next {
			next = p.Num + 1
		}
	}
	return next
}

// nbMeta reads a notebook's title + summary from notebook.json, defaulting the title
// from the folder name so the Appendix always has a heading.
func nbMeta(nbDir string) (string, string) {
	var title, summary string
	if data, err := os.ReadFile(filepath.Join(nbDir, "notebook.json")); err == nil {
		var m map[string]any
		if json.Unmarshal(data, &m) == nil {
			if t, ok := m["title"].(string); ok {
				title = t
			}
			if s, ok := m["summary"].(string); ok {
				summary = s
			}
		}
	}
	if strings.TrimSpace(title) == "" {
		title = filepath.Base(nbDir)
	}
	return title, summary
}

// rebuildAppendixIn regenerates notesDir/"#0 (Appendix).md": the notebook title +
// summary, then a "## Pages" index of [[#N (Title)]] links to every content page.
func rebuildAppendixIn(notesDir string) error {
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		return err
	}
	title, summary := nbMeta(filepath.Dir(notesDir))
	var b strings.Builder
	b.WriteString("# " + title + " — Appendix\n\n")
	if s := strings.TrimSpace(summary); s != "" {
		b.WriteString(s + "\n\n")
	}
	b.WriteString("## Pages\n")
	count := 0
	for _, p := range listPagesIn(notesDir) {
		if p.Num == 0 {
			continue
		}
		fmt.Fprintf(&b, "- [[#%d (%s)]]\n", p.Num, p.Title)
		count++
	}
	if count == 0 {
		b.WriteString("_No pages yet._\n")
	}
	return os.WriteFile(filepath.Join(notesDir, pageFileName(0, "Appendix")), []byte(b.String()), 0o644)
}

// upsertPageIn files bullets under a titled content page: an existing content page with
// the same title (case-insensitive) has the bullets appended; otherwise a new
// next-numbered page is created. Regenerates the Appendix. Creating a new non-Task-Log
// page pushes any existing Task Log page(s) to higher numbers so they stay the
// notebook's last pages.
func upsertPageIn(notesDir, title string, bullets []string) error {
	title = sanitizePageTitle(title)
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		return err
	}
	pages := listPagesIn(notesDir)
	num := nextPageNum(pages)
	body := "# " + title + "\n"
	reused := false
	// Reuse an existing content page with the same title (case-insensitive): keep its
	// number AND original title so we append in place rather than fork a new file.
	for _, p := range pages {
		if p.Num != 0 && strings.EqualFold(p.Title, title) {
			num, title, body = p.Num, p.Title, p.Body
			reused = true
			break
		}
	}
	if _, isLog := taskLogSeq(title); !reused && !isLog {
		if err := pushTaskLogPagesAfter(notesDir, num, pages); err != nil {
			return err
		}
	}
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	for _, bl := range bullets {
		if bl = strings.TrimSpace(bl); bl != "" {
			// A block that's already a heading (e.g. a task-log entry) is inserted as
			// its own block, blank-line separated, rather than folded into a bullet.
			if strings.HasPrefix(bl, "#") {
				if !strings.HasSuffix(body, "\n\n") {
					body += "\n"
				}
				body += bl + "\n\n"
			} else {
				body += "- " + bl + "\n"
			}
		}
	}
	if err := os.WriteFile(filepath.Join(notesDir, pageFileName(num, title)), []byte(body), 0o644); err != nil {
		return err
	}
	return rebuildAppendixIn(notesDir)
}

// taskLogSeq reports whether title is a Task Log page's title ("Task Log" or
// "Task Log N"), returning its sequence number (1 for the bare title).
func taskLogSeq(title string) (int, bool) {
	switch {
	case title == "Task Log":
		return 1, true
	case strings.HasPrefix(title, "Task Log "):
		if v, err := strconv.Atoi(strings.TrimPrefix(title, "Task Log ")); err == nil && v > 1 {
			return v, true
		}
	}
	return 0, false
}

// pushTaskLogPagesAfter renumbers any existing Task Log pages so they all sit at
// numbers greater than afterNum, in their existing sequence order — keeping them
// the notebook's last pages whenever a new non-Task-Log page claims a number.
// No-op if there's no Task Log page yet.
func pushTaskLogPagesAfter(notesDir string, afterNum int, pages []page) error {
	var logs []page
	for _, p := range pages {
		if _, ok := taskLogSeq(p.Title); ok {
			logs = append(logs, p)
		}
	}
	if len(logs) == 0 {
		return nil
	}
	sort.Slice(logs, func(i, j int) bool {
		ni, _ := taskLogSeq(logs[i].Title)
		nj, _ := taskLogSeq(logs[j].Title)
		return ni < nj
	})
	next := afterNum + 1
	for _, p := range logs {
		if p.Num != next {
			oldPath := filepath.Join(notesDir, p.File)
			newPath := filepath.Join(notesDir, pageFileName(next, p.Title))
			if err := os.Rename(oldPath, newPath); err != nil {
				return err
			}
		}
		next++
	}
	return nil
}

// rewritePageIn replaces one page's body, matching target by number ("1"/"#1") or
// title; an unmatched target creates a new page. Returns the page's filename.
func rewritePageIn(notesDir, target, content string) (string, error) {
	pages := listPagesIn(notesDir)
	key := strings.TrimPrefix(strings.TrimSpace(target), "#")
	num := 0
	title := sanitizePageTitle(target)
	found := false
	for _, p := range pages {
		if p.Num == 0 {
			continue
		}
		if strconv.Itoa(p.Num) == key || strings.EqualFold(p.Title, title) {
			num, title, found = p.Num, p.Title, true
			break
		}
	}
	if !found {
		num = nextPageNum(pages)
	}
	// A Task Log page is a live database of dismissed tasks — never let a rewrite edit
	// or clobber one (whether targeted by its number or its "Task Log"/"Task Log N" title).
	if _, isLog := taskLogSeq(title); isLog {
		return "", fmt.Errorf("the %q page is a protected task log and cannot be rewritten", title)
	}
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		return "", err
	}
	body := content
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	if err := os.WriteFile(filepath.Join(notesDir, pageFileName(num, title)), []byte(body), 0o644); err != nil {
		return "", err
	}
	if err := rebuildAppendixIn(notesDir); err != nil {
		return "", err
	}
	return pageFileName(num, title), nil
}

// readAllPages concatenates every page (Appendix first) into one markdown blob, rule-
// separated, for the "notes" query tool.
func readAllPages(notesDir string) string {
	var b strings.Builder
	for _, p := range listPagesIn(notesDir) {
		if b.Len() > 0 {
			b.WriteString("\n\n---\n\n")
		}
		b.WriteString(strings.TrimRight(p.Body, "\n"))
	}
	return strings.TrimSpace(b.String())
}
`

// MCPXTmpl is a tiny, stdlib-only MCP server over stdio: newline-delimited
// JSON-RPC 2.0 with just the methods Claude needs (initialize, tools/list,
// tools/call, ping). It is copied verbatim into each generated module so the
// capability servers have no external dependencies and no network fetch on
// first build.
var MCPXTmpl = bt(`package mcpx

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

// Tool is one callable exposed by the server. Handler receives the decoded
// arguments and returns the text result (or an error, surfaced as isError).
type Tool struct {
	Name        string
	Description string
	InputSchema map[string]any
	Handler     func(args map[string]any) (string, error)
}

// Server is a stdio MCP server. Construct with NewServer, register tools with
// AddTool, then call Serve.
type Server struct {
	name    string
	version string
	tools   []Tool
}

func NewServer(name, version string) *Server {
	return &Server{name: name, version: version}
}

func (s *Server) AddTool(t Tool) { s.tools = append(s.tools, t) }

// ObjectSchema builds a minimal JSON Schema object for a tool's inputs. Pass
// nil props for a no-argument tool.
func ObjectSchema(props map[string]any, required []string) map[string]any {
	if props == nil {
		props = map[string]any{}
	}
	schema := map[string]any{
		"type":       "object",
		"properties": props,
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

type rpcRequest struct {
	JSONRPC string          %BT%json:"jsonrpc"%BT%
	ID      json.RawMessage %BT%json:"id,omitempty"%BT%
	Method  string          %BT%json:"method"%BT%
	Params  json.RawMessage %BT%json:"params,omitempty"%BT%
}

type rpcError struct {
	Code    int    %BT%json:"code"%BT%
	Message string %BT%json:"message"%BT%
}

type rpcResponse struct {
	JSONRPC string          %BT%json:"jsonrpc"%BT%
	ID      json.RawMessage %BT%json:"id"%BT%
	Result  any             %BT%json:"result,omitempty"%BT%
	Error   *rpcError       %BT%json:"error,omitempty"%BT%
}

// Serve runs the read/dispatch/write loop until stdin closes. Anything the
// server logs must go to stderr; stdout carries the protocol.
func (s *Server) Serve() error {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	w := bufio.NewWriter(os.Stdout)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			continue // ignore malformed frames
		}
		resp, notif := s.handle(req)
		if notif {
			continue // notifications get no response
		}
		out, err := json.Marshal(resp)
		if err != nil {
			continue
		}
		w.Write(out)
		w.WriteByte('\n')
		w.Flush()
	}
	return sc.Err()
}

func isNotification(id json.RawMessage) bool {
	return len(id) == 0 || string(id) == "null"
}

func (s *Server) handle(req rpcRequest) (rpcResponse, bool) {
	notif := isNotification(req.ID)
	resp := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		pv := "2025-06-18"
		var p struct {
			ProtocolVersion string %BT%json:"protocolVersion"%BT%
		}
		if json.Unmarshal(req.Params, &p) == nil && p.ProtocolVersion != "" {
			pv = p.ProtocolVersion
		}
		resp.Result = map[string]any{
			"protocolVersion": pv,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": s.name, "version": s.version},
		}
	case "tools/list":
		list := make([]map[string]any, 0, len(s.tools))
		for _, t := range s.tools {
			schema := t.InputSchema
			if schema == nil {
				schema = ObjectSchema(nil, nil)
			}
			list = append(list, map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"inputSchema": schema,
			})
		}
		resp.Result = map[string]any{"tools": list}
	case "tools/call":
		var p struct {
			Name      string         %BT%json:"name"%BT%
			Arguments map[string]any %BT%json:"arguments"%BT%
		}
		_ = json.Unmarshal(req.Params, &p)
		resp.Result = s.callTool(p.Name, p.Arguments)
	case "ping":
		resp.Result = map[string]any{}
	default:
		if notif {
			return resp, true // e.g. notifications/initialized
		}
		resp.Error = &rpcError{Code: -32601, Message: fmt.Sprintf("method not found: %s", req.Method)}
	}
	return resp, notif
}

func (s *Server) callTool(name string, args map[string]any) map[string]any {
	for _, t := range s.tools {
		if t.Name != name {
			continue
		}
		text, err := t.Handler(args)
		if err != nil {
			return map[string]any{
				"content": []map[string]any{{"type": "text", "text": "error: " + err.Error()}},
				"isError": true,
			}
		}
		return map[string]any{
			"content": []map[string]any{{"type": "text", "text": text}},
		}
	}
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": "unknown tool: " + name}},
		"isError": true,
	}
}
`)

// DogMainTmpl is the seed capability server: a template to copy when adding a
// new server. Its "storage" is a stub — swap the handlers for real logic.
var DogMainTmpl = bt(`package main

import "ainotepad-mcp/mcpx"

func main() {
	s := mcpx.NewServer("dog", "0.1.0")

	s.AddTool(mcpx.Tool{
		Name:        "dog_profile",
		Description: "Return the profile of Jordan's dog: name, breed, age, and quirks.",
		InputSchema: mcpx.ObjectSchema(nil, nil),
		Handler: func(args map[string]any) (string, error) {
			return "Name: Biscuit\nBreed: Border Collie\nAge: 4\nQuirks: herds the roomba, afraid of umbrellas.", nil
		},
	})

	s.AddTool(mcpx.Tool{
		Name:        "dog_add_note",
		Description: "Record a short note about the dog (e.g. a vet date or a new trick). Stub: not yet persisted.",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"note": map[string]any{"type": "string", "description": "the note to record"},
		}, []string{"note"}),
		Handler: func(args map[string]any) (string, error) {
			note, _ := args["note"].(string)
			return "noted: " + note, nil
		},
	})

	if err := s.Serve(); err != nil {
		panic(err)
	}
}
`)

// DogCapabilityTmpl is read by the orchestrator's list_capabilities tool. Every
// capability server folder should carry one of these describing itself.
var DogCapabilityTmpl = `{
  "name": "dog",
  "summary": "Profile and notes about Jordan's dog.",
  "tools": ["dog_profile", "dog_add_note"]
}
`

// OrchestratorMainTmpl is the discovery + growth server. It still reports what
// exists (list_capabilities), but it also keeps a persistent tally of the
// subjects Claude reports each turn (record_subject) and decides, by a simple
// mention threshold, when a subject has come up often enough to deserve its own
// notes server. It never builds anything itself: request_new_server just drops
// a request file that the Go server materialises on the next run. That keeps all
// code generation on the trusted server side.
var OrchestratorMainTmpl = withPageHelpers(bt(`package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"ainotepad-orchestrator/mcpx"
)

type capability struct {
	Name    string   %BT%json:"name"%BT%
	Summary string   %BT%json:"summary"%BT%
	Tools   []string %BT%json:"tools"%BT%
}

// subjectState is the running tally for one subject slug. MergedInto is set once
// the subject has been consolidated into another, so it stops trending/proposing.
type subjectState struct {
	Count      int    %BT%json:"count"%BT%
	Requested  bool   %BT%json:"requested"%BT%
	MergedInto string %BT%json:"merged_into,omitempty"%BT%
}

// card is one dashboard card (a task, or any future kind — "notification" is
// retired and rejected by upsertCard). It is
// persisted as one JSON file per card under state/cards/<id>.json. The schema is
// deliberately flat and kind-agnostic: the dashboard renders unknown kinds with a
// generic fallback, so new kinds need no new code. Payload carries kind-specific
// extras that stay opaque to the Go side.
type card struct {
	ID        string         %BT%json:"id"%BT%
	Kind      string         %BT%json:"kind"%BT%
	Priority  string         %BT%json:"priority"%BT%
	Date      string         %BT%json:"date,omitempty"%BT%
	Title     string         %BT%json:"title"%BT%
	Body      string         %BT%json:"body,omitempty"%BT%
	Tags      []string       %BT%json:"tags,omitempty"%BT%
	Payload   map[string]any %BT%json:"payload,omitempty"%BT%
	Done      bool           %BT%json:"done"%BT%
	Dismissed bool           %BT%json:"dismissed"%BT%
	Source    string         %BT%json:"source,omitempty"%BT%
	CreatedAt string         %BT%json:"created_at"%BT%
	UpdatedAt string         %BT%json:"updated_at"%BT%
}

var (
	mcpDir    string
	stateDir  string
	threshold int
)

func main() {
	flag.StringVar(&mcpDir, "mcp-dir", "", "directory containing capability server folders")
	flag.StringVar(&stateDir, "state-dir", "", "directory for the subject tally + requests")
	flag.IntVar(&threshold, "threshold", 4, "mentions before a subject is proposed a server")
	flag.Parse()

	s := mcpx.NewServer("orchestrator", "0.1.0")

	s.AddTool(mcpx.Tool{
		Name:        "record_subject",
		Description: "Record that this turn is about a subject or project. Call once per turn with a short lowercase slug. The reply tells you whether the subject now warrants its own notes server.",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"subject": map[string]any{"type": "string", "description": "short lowercase slug, e.g. greenhouse or buddy-the-dog"},
		}, []string{"subject"}),
		Handler: recordSubject,
	})
	s.AddTool(mcpx.Tool{
		Name:        "request_new_server",
		Description: "Queue creation of a notes server for a subject. Only call after the user has agreed to it. The server is live on the next message.",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"name":    map[string]any{"type": "string", "description": "subject slug to create a server for"},
			"summary": map[string]any{"type": "string", "description": "one-line description of what it tracks"},
		}, []string{"name"}),
		Handler: requestNewServer,
	})
	s.AddTool(mcpx.Tool{
		Name:        "consolidate_subjects",
		Description: "Queue merging one or more subjects' notes into a target subject, retiring the merged ones. Only call after the user agrees. Takes effect on the next message.",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"into": map[string]any{"type": "string", "description": "target subject slug to keep"},
			"from": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "subject slugs to merge in and retire"},
		}, []string{"into", "from"}),
		Handler: consolidateSubjects,
	})
	s.AddTool(mcpx.Tool{
		Name:        "ingest_topic",
		Description: "File one or more notes under a subject notebook, creating it if needed. This is the workhorse for /ingest: call it once per distinct topic on the page. Each call writes to one titled PAGE inside the subject's notebook — pass 'page' as a short title for this batch (reuse the same title to append to that page; a new title starts a new page). The notes save immediately; if the subject had no server yet, one is queued and goes live on the next message. Reuse an existing subject slug when the topic matches one (call list_capabilities first). In a note you may link another page as [[#N (Title)]] or another notebook's page as [[slug::#N (Title)]].",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"subject": map[string]any{"type": "string", "description": "short lowercase slug for the subject notebook, e.g. greenhouse or taxes-2026"},
			"page":    map[string]any{"type": "string", "description": "short title for the page these notes go on, e.g. \"Watering Schedule\" (defaults to the summary, else \"Notes\")"},
			"summary": map[string]any{"type": "string", "description": "one-line description of the subject (used only when creating the notebook)"},
			"notes":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "the notes/facts from the page to file under this subject. Any HTML comment block (a line \"<!--ai\" through its closing \"-->\") is a rendered widget: pass it through verbatim as its own note, never editing anything between <!-- and -->."},
		}, []string{"subject", "notes"}),
		Handler: ingestTopic,
	})
	s.AddTool(mcpx.Tool{
		Name:        "suggest_merge",
		Description: "Optionally suggest merging overlapping subjects. Only call when two subjects clearly duplicate each other. This does NOT merge anything — it drops a suggestion the user can approve later in the dashboard. Never blocks; use sparingly.",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"into":   map[string]any{"type": "string", "description": "target subject slug to keep"},
			"from":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "subject slugs that could be merged into the target"},
			"reason": map[string]any{"type": "string", "description": "one line on why they overlap"},
		}, []string{"into", "from"}),
		Handler: suggestMerge,
	})
	s.AddTool(mcpx.Tool{
		Name:        "propose_reorg",
		Description: "Propose a reorganization of a subject notebook's pages (combine, split, delete, reorder pages, and drop items the Task Log shows are already done). This does NOT apply anything — it drops a proposal the user approves in the dashboard, then the server rewrites the pages. Read <subject>_notes FIRST so nothing is lost. Pass the FULL intended set of content pages in order as 'pages' (each {title, body}); the server replaces the notebook's current content pages with exactly these. NEVER include a \"Task Log\" (or \"Task Log N\") page — those are a live database the server preserves untouched; the server ignores any Task Log page you pass. Preserve every real fact; invent nothing.",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"subject": map[string]any{"type": "string", "description": "the subject notebook slug to reorganize"},
			"summary": map[string]any{"type": "string", "description": "one short line describing the reorganization, shown on the confirm card"},
			"pages": map[string]any{"type": "array", "items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"title": map[string]any{"type": "string", "description": "the page's title"},
					"body":  map[string]any{"type": "string", "description": "the page's full markdown body"},
				},
			}, "description": "the full intended set of content pages, in order (never a Task Log page)"},
		}, []string{"subject", "pages"}),
		Handler: proposeReorg,
	})
	s.AddTool(mcpx.Tool{
		Name:        "list_capabilities",
		Description: "List existing capability servers, subjects trending toward their own server, and any queued creations or consolidations.",
		InputSchema: mcpx.ObjectSchema(nil, nil),
		Handler:     func(args map[string]any) (string, error) { return listCapabilities(), nil },
	})
	s.AddTool(mcpx.Tool{
		Name:        "upsert_card",
		Description: "Create or update a dashboard card from the notes, or from a conversation about an existing subject (e.g. during /talk). Use kind=\"task\" for action items the user must do (with a due date if one is stated). Use kind=\"idea\" for a proposal, feature, or thought worth keeping — for an idea, structure the body as Markdown with these four sections, filling in what the notes support:\\n## Problem\\n## Idea\\n## Project plan\\n## Next steps\\nand attach 1–4 short lowercase tags (e.g. ux, sync, ai) so it can be filtered on the dashboard. Set priority as an honest urgency (for an idea, how promising/pressing it is): urgent, high, normal, or low. Idempotent: omit id and the same title+kind always maps to the same card, so re-running /ingest — or revisiting the same idea later — updates rather than duplicates (omitting tags on a re-file keeps the existing ones). Call list_cards first to avoid a near-duplicate, or to find the id of a card the user wants changed. Pass done=true/false to mark a task complete or reopen it. Note: kind=\"notification\" is retired — do not use it; file a task instead.",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"kind":     map[string]any{"type": "string", "description": "task, idea, or any future kind (notification is retired)"},
			"title":    map[string]any{"type": "string", "description": "short one-line card title"},
			"priority": map[string]any{"type": "string", "description": "urgent | high | normal | low"},
			"date":     map[string]any{"type": "string", "description": "optional ISO date (YYYY-MM-DD): due date for a task"},
			"body":     map[string]any{"type": "string", "description": "optional extra detail or context. For kind=\"idea\", the Markdown template body (## Problem / ## Idea / ## Project plan / ## Next steps)."},
			"tags":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "optional freeform lowercase labels for filtering (best for ideas), e.g. [\"ux\",\"sync\"]. Omit on a re-file to keep the card's existing tags."},
			"payload":  map[string]any{"type": "object", "description": "optional kind-specific extras, stored opaquely"},
			"source":   map[string]any{"type": "string", "description": "optional subject slug the card came from"},
			"id":       map[string]any{"type": "string", "description": "optional stable id; omit to derive one from title+kind"},
			"done":     map[string]any{"type": "boolean", "description": "optional: set true to mark a task complete, false to reopen it. Omit to leave its done state unchanged."},
		}, []string{"kind", "title", "priority"}),
		Handler: upsertCard,
	})
	s.AddTool(mcpx.Tool{
		Name:        "list_cards",
		Description: "List the dashboard cards that already exist (tasks), so you can update or avoid duplicating them, or find the id of one to change. Pass 'source' to see only one subject's cards (e.g. the subject of the current /talk conversation).",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"source": map[string]any{"type": "string", "description": "optional subject slug to filter to just that notebook's cards"},
		}, nil),
		Handler: func(args map[string]any) (string, error) {
			source, _ := args["source"].(string)
			return listCards(slug(source)), nil
		},
	})
	s.AddTool(mcpx.Tool{
		Name:        "dismiss_card",
		Description: "Remove a dashboard card (e.g. a task the user says to delete, drop, or cancel) so it stops showing on the dashboard. This does not delete history — it just hides the card. Call list_cards first to find the id. Irreversible from here: to bring it back, use upsert_card with the same id.",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"id":     map[string]any{"type": "string", "description": "the card's id, from list_cards"},
			"source": map[string]any{"type": "string", "description": "optional subject slug the card lives under; speeds up the lookup"},
		}, []string{"id"}),
		Handler: dismissCard,
	})

	if err := s.Serve(); err != nil {
		panic(err)
	}
}

var slugRe = regexp.MustCompile(%BT%[^a-z0-9]+%BT%)

func slug(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = slugRe.ReplaceAllString(s, "-")
	return strings.Trim(s, "-")
}

// hasServer reports whether a capability server folder already exists for name. The
// data-only "orchestrator" notebook never counts — it has no query server.
func hasServer(name string) bool {
	if mcpDir == "" || name == "" || name == "orchestrator" {
		return false
	}
	info, err := os.Stat(filepath.Join(mcpDir, name))
	return err == nil && info.IsDir()
}

func subjectsPath() string      { return filepath.Join(stateDir, "subjects.json") }
func requestsDir() string       { return filepath.Join(stateDir, "requests") }
func consolidationsDir() string { return filepath.Join(stateDir, "consolidations") }
func suggestionsDir() string    { return filepath.Join(stateDir, "suggestions") }
func reorgsDir() string         { return filepath.Join(stateDir, "reorgs") }

// The notebook layout, mirrored from the Go server's notebook.go: a subject folder
// under mcp/<slug>/ holds notes/ (a folder of "#N (Title).md" pages), notebook.json
// (its viewable identity), and cards/ (its tasks). Cards live with their
// notebook, not in a global queue, so each notebook owns its own actions.
const notebookManifest = "notebook.json"

func notebookDir(name string) string { return filepath.Join(mcpDir, name) }
func notesDirFor(name string) string { return filepath.Join(mcpDir, name, "notes") }
func cardsDirFor(name string) string { return filepath.Join(mcpDir, name, "cards") }

// logActivity records one line of orchestrator bookkeeping on the data-only
// "orchestrator" notebook's Activity page, so the user can see what was filed or merged.
func logActivity(line string) {
	if mcpDir == "" {
		return
	}
	_ = upsertPageIn(filepath.Join(mcpDir, "orchestrator", "notes"), "Activity", []string{line})
}

//__PAGE_HELPERS__

// titleFromSlug turns "taxes-2026" into "Taxes 2026" for a default display title.
func titleFromSlug(name string) string {
	words := strings.FieldsFunc(name, func(r rune) bool { return r == '-' || r == '_' })
	for i, w := range words {
		if w != "" {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	if len(words) == 0 {
		return name
	}
	return strings.Join(words, " ")
}

// touchManifest bumps a notebook's updated_at (creating the manifest if absent),
// so the dashboard index can order notebooks by recency.
func touchManifest(name string) {
	path := filepath.Join(notebookDir(name), notebookManifest)
	m := map[string]any{}
	if data, err := os.ReadFile(path); err == nil {
		json.Unmarshal(data, &m)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	m["slug"] = name
	if t, _ := m["title"].(string); t == "" {
		m["title"] = titleFromSlug(name)
	}
	if c, _ := m["created_at"].(string); c == "" {
		m["created_at"] = now
	}
	m["updated_at"] = now
	data, _ := json.MarshalIndent(m, "", "  ")
	os.WriteFile(path, append(data, '\n'), 0o644)
}

// ensureNotebook makes <mcp>/<name> a viewable + queryable notebook: it seeds
// notebook.json when absent, refreshes the notes/ Appendix, always bumps updated_at,
// and queues the query binary build when the subject has no server code yet. It does
// not seed a starter page — the first ingested topic becomes page #1. Returns whether
// a build was newly queued.
func ensureNotebook(name, summary string) bool {
	dir := notebookDir(name)
	os.MkdirAll(dir, 0o755)
	summary = strings.TrimSpace(summary)
	if summary == "" {
		summary = "Notes and facts about " + name + "."
	}
	if _, err := os.Stat(filepath.Join(dir, notebookManifest)); err != nil {
		now := time.Now().UTC().Format(time.RFC3339)
		nb := map[string]any{
			"slug": name, "title": titleFromSlug(name), "summary": summary,
			"pinned": false, "created_at": now, "updated_at": now,
		}
		data, _ := json.MarshalIndent(nb, "", "  ")
		os.WriteFile(filepath.Join(dir, notebookManifest), append(data, '\n'), 0o644)
	} else {
		touchManifest(name)
	}
	// Refresh the Appendix (creating the notes/ folder) now that the manifest exists.
	rebuildAppendixIn(notesDirFor(name))
	queued := false
	if _, err := os.Stat(filepath.Join(dir, "main.go")); err != nil {
		os.MkdirAll(requestsDir(), 0o755)
		req := map[string]string{"name": name, "summary": summary}
		data, _ := json.MarshalIndent(req, "", "  ")
		os.WriteFile(filepath.Join(requestsDir(), name+".json"), append(data, '\n'), 0o644)
		queued = true
	}
	return queued
}

func loadSubjects() map[string]*subjectState {
	m := map[string]*subjectState{}
	if data, err := os.ReadFile(subjectsPath()); err == nil {
		json.Unmarshal(data, &m)
	}
	return m
}

func saveSubjects(m map[string]*subjectState) {
	os.MkdirAll(stateDir, 0o755)
	data, _ := json.MarshalIndent(m, "", "  ")
	os.WriteFile(subjectsPath(), append(data, '\n'), 0o644)
}

func recordSubject(args map[string]any) (string, error) {
	name := slug(fmt.Sprintf("%v", args["subject"]))
	if name == "" {
		return "no subject given.", nil
	}
	m := loadSubjects()
	st := m[name]
	if st == nil {
		st = &subjectState{}
		m[name] = st
	}
	st.Count++
	saveSubjects(m)

	switch {
	case st.MergedInto != "":
		return fmt.Sprintf("recorded %q (%d); it was consolidated into %q — use that subject's notes.", name, st.Count, st.MergedInto), nil
	case hasServer(name):
		return fmt.Sprintf("recorded %q (%d); it already has a server.", name, st.Count), nil
	case st.Requested:
		return fmt.Sprintf("recorded %q (%d); a server is already queued.", name, st.Count), nil
	case st.Count >= threshold:
		return fmt.Sprintf("recorded %q (%d). This keeps coming up and has no server. If it fits, tell the user you can create a %q notes server and ask if they want it; only call request_new_server if they agree.", name, st.Count, name), nil
	default:
		return fmt.Sprintf("recorded %q (%d).", name, st.Count), nil
	}
}

func requestNewServer(args map[string]any) (string, error) {
	name := slug(fmt.Sprintf("%v", args["name"]))
	if name == "" {
		return "no name given.", nil
	}
	if hasServer(name) {
		return fmt.Sprintf("%q already has a server.", name), nil
	}
	summary, _ := args["summary"].(string)
	if strings.TrimSpace(summary) == "" {
		summary = "Notes and facts about " + name + "."
	}
	os.MkdirAll(requestsDir(), 0o755)
	req := map[string]string{"name": name, "summary": summary}
	data, _ := json.MarshalIndent(req, "", "  ")
	if err := os.WriteFile(filepath.Join(requestsDir(), name+".json"), append(data, '\n'), 0o644); err != nil {
		return "", err
	}
	m := loadSubjects()
	st := m[name]
	if st == nil {
		st = &subjectState{}
		m[name] = st
	}
	st.Requested = true
	saveSubjects(m)
	logActivity("Queued a new notebook: " + name)
	return fmt.Sprintf("queued the %q notes server (%s). It goes live on the next message, with tools %s_add_note, %s_notes, and %s_rewrite.", name, summary, name, name, name), nil
}

// consolidateSubjects queues a merge of one or more subjects into a target. It
// only drops a request file (the trusted Go server does the markdown merge and
// retires the merged servers on the next run) and marks the merged subjects so
// they stop trending here.
func consolidateSubjects(args map[string]any) (string, error) {
	into := slug(fmt.Sprintf("%v", args["into"]))
	if into == "" {
		return "no target subject given.", nil
	}
	var from []string
	if raw, ok := args["from"].([]any); ok {
		for _, v := range raw {
			s := slug(fmt.Sprintf("%v", v))
			if s != "" && s != into {
				from = append(from, s)
			}
		}
	}
	if len(from) == 0 {
		return "no subjects to merge (need at least one 'from' distinct from 'into').", nil
	}
	os.MkdirAll(consolidationsDir(), 0o755)
	req := map[string]any{"into": into, "from": from}
	data, _ := json.MarshalIndent(req, "", "  ")
	if err := os.WriteFile(filepath.Join(consolidationsDir(), into+".json"), append(data, '\n'), 0o644); err != nil {
		return "", err
	}
	m := loadSubjects()
	for _, f := range from {
		st := m[f]
		if st == nil {
			st = &subjectState{}
			m[f] = st
		}
		st.MergedInto = into
	}
	saveSubjects(m)
	logActivity("Queued merge of " + strings.Join(from, ", ") + " → " + into)
	return fmt.Sprintf("queued consolidation of %s into %q. Live on the next message; the merged subjects are retired.", strings.Join(from, ", "), into), nil
}

// ingestTopic files notes under a subject notebook during /ingest. It writes the
// note markdown immediately (so the dashboard shows it this instant) via
// ensureNotebook, which also seeds the notebook.json manifest and queues the
// queryable MCP binary when the subject has no server code yet. Notes live in the
// notebook's notes.md; the generated fact-store server reads the same file, and
// seeding uses writeIfMissing for notes.md so a build never clobbers what we write.
func ingestTopic(args map[string]any) (string, error) {
	name := slug(fmt.Sprintf("%v", args["subject"]))
	if name == "" {
		return "no subject given.", nil
	}
	if mcpDir == "" {
		return "no mcp dir configured.", nil
	}

	var notes []string
	if raw, ok := args["notes"].([]any); ok {
		for _, v := range raw {
			if s := strings.TrimSpace(fmt.Sprintf("%v", v)); s != "" {
				notes = append(notes, s)
			}
		}
	}
	if one, ok := args["note"].(string); ok {
		if s := strings.TrimSpace(one); s != "" {
			notes = append(notes, s)
		}
	}
	if len(notes) == 0 {
		return "no notes to file for " + name + ".", nil
	}
	summary, _ := args["summary"].(string)
	summary = strings.TrimSpace(summary)

	m := loadSubjects()
	// Follow a prior consolidation so notes land in the surviving subject.
	if st := m[name]; st != nil && st.MergedInto != "" {
		name = st.MergedInto
	}

	// Brand-new when the notebook has no notes/ folder yet — for the reply wording.
	_, statErr := os.Stat(notesDirFor(name))
	isNew := statErr != nil

	// One page per ingested topic: use the explicit 'page' title, else the summary,
	// else a default.
	pageTitle, _ := args["page"].(string)
	pageTitle = strings.TrimSpace(pageTitle)
	if pageTitle == "" {
		pageTitle = strings.TrimSpace(summary)
	}
	if pageTitle == "" {
		pageTitle = "Notes"
	}

	// Seed the notebook (manifest + appendix) and queue its binary if needed, then
	// file the notes onto their page (upsertPageIn rebuilds the appendix).
	created := ensureNotebook(name, summary)
	if err := upsertPageIn(notesDirFor(name), pageTitle, notes); err != nil {
		return "", err
	}
	touchManifest(name)
	logActivity("Filed " + strconv.Itoa(len(notes)) + " note(s) → " + name + " · " + sanitizePageTitle(pageTitle))

	st := m[name]
	if st == nil {
		st = &subjectState{}
		m[name] = st
	}
	st.Count++
	if created {
		st.Requested = true
	}
	saveSubjects(m)

	if isNew {
		return fmt.Sprintf("filed %d note(s) under new subject %q; its notes server goes live on the next message.", len(notes), name), nil
	}
	if created {
		return fmt.Sprintf("filed %d note(s) under %q (its notes server is queued, live next message).", len(notes), name), nil
	}
	return fmt.Sprintf("filed %d note(s) under %q.", len(notes), name), nil
}

// suggestMerge drops an optional merge suggestion for the user to approve in the
// dashboard. It never merges anything itself — approval writes a consolidation
// request through the /action endpoint, which the Go server drains next run.
func suggestMerge(args map[string]any) (string, error) {
	into := slug(fmt.Sprintf("%v", args["into"]))
	if into == "" {
		return "no target subject given.", nil
	}
	var from []string
	if raw, ok := args["from"].([]any); ok {
		for _, v := range raw {
			s := slug(fmt.Sprintf("%v", v))
			if s != "" && s != into {
				from = append(from, s)
			}
		}
	}
	if len(from) == 0 {
		return "no subjects to merge (need at least one 'from' distinct from 'into').", nil
	}
	reason, _ := args["reason"].(string)
	os.MkdirAll(suggestionsDir(), 0o755)
	req := map[string]any{"into": into, "from": from, "reason": strings.TrimSpace(reason)}
	data, _ := json.MarshalIndent(req, "", "  ")
	if err := os.WriteFile(filepath.Join(suggestionsDir(), into+".json"), append(data, '\n'), 0o644); err != nil {
		return "", err
	}
	return fmt.Sprintf("suggested merging %s into %q; the user can approve it in the dashboard.", strings.Join(from, ", "), into), nil
}

// proposeReorg drops a page-reorganization proposal for a subject notebook, which the
// user approves in the dashboard (the trusted Go server then rewrites the pages). It
// never touches anything itself. The proposal is the FULL intended set of content
// pages; any Task Log page passed in is dropped here (defence in depth — the server's
// apply preserves the real Task Log pages untouched regardless).
func proposeReorg(args map[string]any) (string, error) {
	subject := slug(fmt.Sprintf("%v", args["subject"]))
	if subject == "" {
		return "no subject given.", nil
	}
	if mcpDir == "" {
		return "no mcp dir configured.", nil
	}
	type reorgPage struct {
		Title string %BT%json:"title"%BT%
		Body  string %BT%json:"body"%BT%
	}
	var pages []reorgPage
	if raw, ok := args["pages"].([]any); ok {
		for _, v := range raw {
			m, ok := v.(map[string]any)
			if !ok {
				continue
			}
			title := strings.TrimSpace(fmt.Sprintf("%v", m["title"]))
			body, _ := m["body"].(string)
			if title == "" && strings.TrimSpace(body) == "" {
				continue
			}
			// Never let a Task Log page be authored through a reorg — it is a live
			// database only the dismissal path writes to.
			if _, isLog := taskLogSeq(sanitizePageTitle(title)); isLog {
				continue
			}
			pages = append(pages, reorgPage{Title: title, Body: body})
		}
	}
	if len(pages) == 0 {
		return "no content pages given to reorganize into.", nil
	}
	summary, _ := args["summary"].(string)
	summary = strings.TrimSpace(summary)
	os.MkdirAll(reorgsDir(), 0o755)
	req := map[string]any{"subject": subject, "summary": summary, "pages": pages}
	data, _ := json.MarshalIndent(req, "", "  ")
	if err := os.WriteFile(filepath.Join(reorgsDir(), subject+".json"), append(data, '\n'), 0o644); err != nil {
		return "", err
	}
	logActivity("Proposed reorganizing " + subject + " into " + strconv.Itoa(len(pages)) + " page(s)")
	return fmt.Sprintf("proposed reorganizing %q into %d page(s); the user can approve it in the dashboard. Do not apply it yourself.", subject, len(pages)), nil
}

// validPriority normalizes a priority string, defaulting unknown/blank ones to
// "normal" so a card always carries a sortable urgency.
func validPriority(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "urgent":
		return "urgent"
	case "high":
		return "high"
	case "low":
		return "low"
	default:
		return "normal"
	}
}

// upsertCard writes one dashboard card JSON under state/cards/<id>.json. The id is
// a slug so the file can never escape the cards dir. Omitting id derives a stable
// one from kind+title, so re-ingesting the same item overwrites rather than dupes.
// Existing done/dismissed/created_at are preserved so re-running /ingest never
// undoes a user's completion or dismissal.
func upsertCard(args map[string]any) (string, error) {
	kind := slug(fmt.Sprintf("%v", args["kind"]))
	if kind == "" {
		return "no card kind given.", nil
	}
	if kind == "notification" {
		return "kind=\"notification\" is retired and no longer accepted; file kind=\"task\" instead.", nil
	}
	title := strings.TrimSpace(fmt.Sprintf("%v", args["title"]))
	if title == "" {
		return "no title given.", nil
	}
	id := ""
	if raw, ok := args["id"].(string); ok {
		id = slug(raw)
	}
	if id == "" {
		id = slug(kind + "-" + title)
	}
	if id == "" {
		return "could not derive a card id from the title.", nil
	}

	body, _ := args["body"].(string)
	date, _ := args["date"].(string)
	// The card is owned by its source notebook and stored under it. An unspecified
	// (or invalid) source falls back to the "inbox" notebook so nothing is orphaned.
	source := ""
	if raw, ok := args["source"].(string); ok {
		source = slug(raw)
	}
	if source == "" {
		source = "inbox"
	}
	var payload map[string]any
	if p, ok := args["payload"].(map[string]any); ok {
		payload = p
	}

	// Make sure the owning notebook exists (viewable + queued) before filing into it.
	ensureNotebook(source, "")
	dir := cardsDirFor(source)
	os.MkdirAll(dir, 0o755)
	path := filepath.Join(dir, id+".json")

	var prev card
	if data, err := os.ReadFile(path); err == nil {
		json.Unmarshal(data, &prev)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	createdAt := prev.CreatedAt
	if createdAt == "" {
		createdAt = now
	}
	done := prev.Done
	if b, ok := args["done"].(bool); ok {
		done = b
	}
	// Tags are the freeform labels a card (chiefly an idea) is filed under, powering
	// the dashboard's tag filter. An absent "tags" key keeps whatever the previous
	// version had, so re-ingesting a card without restating its tags never strips
	// them; an explicit array (even empty) replaces them. Dupes are folded
	// case-insensitively while keeping each tag's first-seen spelling.
	tags := prev.Tags
	if raw, ok := args["tags"].([]any); ok {
		tags = []string{}
		seen := map[string]bool{}
		for _, v := range raw {
			t := strings.TrimSpace(fmt.Sprintf("%v", v))
			if t == "" || seen[strings.ToLower(t)] {
				continue
			}
			seen[strings.ToLower(t)] = true
			tags = append(tags, t)
		}
	}
	c := card{
		ID:        id,
		Kind:      kind,
		Priority:  validPriority(fmt.Sprintf("%v", args["priority"])),
		Date:      strings.TrimSpace(date),
		Title:     title,
		Body:      strings.TrimSpace(body),
		Tags:      tags,
		Payload:   payload,
		Done:      done,
		Dismissed: prev.Dismissed,
		Source:    source,
		CreatedAt: createdAt,
		UpdatedAt: now,
	}
	data, _ := json.MarshalIndent(c, "", "  ")
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		return "", err
	}
	doneNote := ""
	if kind == "task" && done {
		doneNote = ", done"
	}
	return fmt.Sprintf("filed %s card %q (priority %s%s, id %s).", kind, title, c.Priority, doneNote, id), nil
}

// findCard locates mcp/<slug>/cards/<id>.json for a card id, trying hint (the
// caller's guess at its source notebook) first, then every notebook. Returns the
// resolved path, the card's owning subject slug, and whether it was found.
func findCard(hint, id string) (path, foundSource string, ok bool) {
	try := func(name string) bool {
		p := filepath.Join(cardsDirFor(name), id+".json")
		if _, err := os.Stat(p); err != nil {
			return false
		}
		path, foundSource = p, name
		return true
	}
	if hint != "" && try(hint) {
		return path, foundSource, true
	}
	subjects, _ := os.ReadDir(mcpDir)
	for _, sub := range subjects {
		name := sub.Name()
		if !sub.IsDir() || name == "mcpx" || name == "bin" || name == hint {
			continue
		}
		if try(name) {
			return path, foundSource, true
		}
	}
	return "", "", false
}

// dismissCard hides a card from the dashboard (mirrors the phone's own dismiss
// action) without deleting its history — upsert_card with the same id can
// resurrect it later.
func dismissCard(args map[string]any) (string, error) {
	id := slug(fmt.Sprintf("%v", args["id"]))
	if id == "" {
		return "no card id given.", nil
	}
	hint := slug(fmt.Sprintf("%v", args["source"]))
	path, foundSource, ok := findCard(hint, id)
	if !ok {
		return fmt.Sprintf("no card found with id %q. Call list_cards to find the right id.", id), nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var c card
	if json.Unmarshal(data, &c) != nil {
		return "", fmt.Errorf("card %s is corrupt", id)
	}
	c.Dismissed = true
	c.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	out, _ := json.MarshalIndent(c, "", "  ")
	if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
		return "", err
	}
	logTaskDismissal(foundSource, c)
	return fmt.Sprintf("dismissed card %q (id %s).", c.Title, id), nil
}

// logTaskDismissal appends one entry to the owning subject's "Task Log" notebook page
// recording that a task was removed: whether it was completed or dropped, and how long
// it lived (created_at -> the moment it was dismissed). See taskLogLine for the entry's
// format.
func logTaskDismissal(source string, c card) {
	if source == "" || c.Kind != "task" {
		return
	}
	notesDir := notesDirFor(source)
	_ = upsertPageIn(notesDir, taskLogTargetTitle(notesDir), []string{taskLogLine(c)})
}

// taskLogPageCap is the most entries kept on one "Task Log" page before a dismissal
// rolls onto a new one ("Task Log 2", "Task Log 3", ...), so a long-lived notebook's
// log stays a series of bounded pages instead of one ever-growing file.
const taskLogPageCap = 100

// taskLogTargetTitle picks which "Task Log" page the next dismissal entry belongs
// on: the highest-numbered existing one if it still has room, otherwise the next
// one in the sequence.
func taskLogTargetTitle(notesDir string) string {
	n, body := latestTaskLogPage(listPagesIn(notesDir))
	if n > 0 && countTaskLogEntries(body) >= taskLogPageCap {
		n++
	}
	if n <= 1 {
		return "Task Log"
	}
	return fmt.Sprintf("Task Log %d", n)
}

// latestTaskLogPage returns the sequence number (1 for bare "Task Log", 2+ for
// "Task Log N") and body of the highest-numbered Task Log page present, or (0, "")
// if the notebook doesn't have one yet.
func latestTaskLogPage(pages []page) (int, string) {
	best, body := 0, ""
	for _, p := range pages {
		if n, ok := taskLogSeq(p.Title); ok && n > best {
			best, body = n, p.Body
		}
	}
	return best, body
}

// countTaskLogEntries counts task-log entries in a page body by counting "## "
// headings (one per entry — see taskLogLine). A manually edited page that loses a
// heading just undercounts by that much; the cap is a soft target, not a guarantee,
// so that's fine.
func countTaskLogEntries(body string) int {
	n := 0
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "## ") {
			n++
		}
	}
	return n
}

// taskLogLine renders one dismissal as its own "## " heading (just the task title)
// followed by plain bullets for the details — readable directly in the notebook, no
// machine-only tag. No source field: the entry already lives on the owning
// subject's own Task Log page.
func taskLogLine(c card) string {
	now := time.Now().UTC()
	verb := "Dropped"
	if c.Done {
		verb = "Completed"
	}
	created, err := time.Parse(time.RFC3339, c.CreatedAt)
	if err != nil {
		created = now
	}
	dur := now.Sub(created)
	return strings.Join([]string{
		fmt.Sprintf("## %s", c.Title),
		fmt.Sprintf("- %s after %s", verb, humanDuration(dur)),
		fmt.Sprintf("- Filed %s → Closed %s", created.Format("2006-01-02 15:04 MST"), now.Format("2006-01-02 15:04 MST")),
		fmt.Sprintf("- id: %BT%%s%BT%", c.ID),
	}, "\n")
}

// humanDuration renders a duration as its two most significant units (days+hours,
// hours+minutes, minutes+seconds, or bare seconds) for a short, readable "took X" note.
func humanDuration(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	days := int(d.Hours()) / 24
	hours := int(d.Hours()) % 24
	mins := int(d.Minutes()) % 60
	secs := int(d.Seconds()) % 60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd %dh", days, hours)
	case hours > 0:
		return fmt.Sprintf("%dh %dm", hours, mins)
	case mins > 0:
		return fmt.Sprintf("%dm %ds", mins, secs)
	default:
		return fmt.Sprintf("%ds", secs)
	}
}

// listCards reports the current cards across every notebook (or, when source is
// non-empty, just that notebook's) so Claude can update or avoid duplicating them.
// Cards live under each notebook's cards/ dir; dismissed ones are skipped and done
// tasks are flagged.
func listCards(source string) string {
	var cards []card
	subjects, _ := os.ReadDir(mcpDir)
	for _, sub := range subjects {
		name := sub.Name()
		if !sub.IsDir() || name == "mcpx" || name == "bin" {
			continue
		}
		if source != "" && name != source {
			continue
		}
		entries, err := os.ReadDir(cardsDirFor(name))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(cardsDirFor(name), e.Name()))
			if err != nil {
				continue
			}
			var c card
			if json.Unmarshal(data, &c) != nil || c.Dismissed {
				continue
			}
			if c.Source == "" {
				c.Source = name
			}
			cards = append(cards, c)
		}
	}
	if len(cards) == 0 {
		if source != "" {
			return fmt.Sprintf("No cards yet for %q.", source)
		}
		return "No cards yet."
	}
	sort.Slice(cards, func(i, j int) bool { return cards[i].ID < cards[j].ID })
	var b strings.Builder
	b.WriteString("Cards:")
	for _, c := range cards {
		line := fmt.Sprintf("\n- [%s/%s] %s (id: %s)", c.Kind, c.Priority, c.Title, c.ID)
		if c.Date != "" {
			line += " date=" + c.Date
		}
		if c.Kind == "task" && c.Done {
			line += " (done)"
		}
		b.WriteString(line)
	}
	return b.String()
}

func listCapabilities() string {
	var b strings.Builder

	var caps []capability
	if mcpDir != "" {
		entries, _ := os.ReadDir(mcpDir)
		for _, e := range entries {
			if !e.IsDir() || e.Name() == "mcpx" || e.Name() == "bin" || e.Name() == "orchestrator" {
				continue
			}
			data, err := os.ReadFile(filepath.Join(mcpDir, e.Name(), "capability.json"))
			if err != nil {
				continue
			}
			var c capability
			if json.Unmarshal(data, &c) != nil {
				continue
			}
			if c.Name == "" {
				c.Name = e.Name()
			}
			caps = append(caps, c)
		}
	}
	sort.Slice(caps, func(i, j int) bool { return caps[i].Name < caps[j].Name })
	if len(caps) == 0 {
		b.WriteString("No capability servers yet.")
	} else {
		b.WriteString("Capability servers:")
		for _, c := range caps {
			b.WriteString("\n- " + c.Name + ": " + c.Summary)
			if len(c.Tools) > 0 {
				b.WriteString("\n  tools: " + strings.Join(c.Tools, ", "))
			}
		}
	}

	m := loadSubjects()
	var trending, queued []string
	for name, st := range m {
		if hasServer(name) || st.MergedInto != "" {
			continue
		}
		if st.Requested {
			queued = append(queued, name)
		} else if st.Count >= threshold {
			trending = append(trending, fmt.Sprintf("%s (%d mentions)", name, st.Count))
		}
	}
	sort.Strings(trending)
	sort.Strings(queued)
	if len(trending) > 0 {
		b.WriteString("\n\nTrending subjects with no server (consider proposing one):\n- " + strings.Join(trending, "\n- "))
	}
	if len(queued) > 0 {
		b.WriteString("\n\nQueued servers (live next message):\n- " + strings.Join(queued, "\n- "))
	}

	var merges []string
	if entries, err := os.ReadDir(consolidationsDir()); err == nil {
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			var req struct {
				Into string   %BT%json:"into"%BT%
				From []string %BT%json:"from"%BT%
			}
			if data, err := os.ReadFile(filepath.Join(consolidationsDir(), e.Name())); err == nil && json.Unmarshal(data, &req) == nil {
				merges = append(merges, fmt.Sprintf("%s <- %s", req.Into, strings.Join(req.From, ", ")))
			}
		}
	}
	sort.Strings(merges)
	if len(merges) > 0 {
		b.WriteString("\n\nQueued consolidations (live next message):\n- " + strings.Join(merges, "\n- "))
	}
	return b.String()
}
`))

// FactStoreMainTmpl is the body of a generated per-subject notes server. The Go server
// substitutes __NAME__ for the subject slug before writing it. Notes are a folder of
// "#N (Title).md" pages at <mcp>/__NAME__/notes/, resolved from the running binary's
// location (<mcp>/bin/__NAME__) so they move with the root. The shared page helpers
// (spliced in at //__PAGE_HELPERS__) do the parsing/upserting/appendix work: add_note
// files a bullet on a page, notes returns every page, and rewrite replaces one page.
var FactStoreMainTmpl = withPageHelpers(bt(`package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"ainotepad-mcp/mcpx"
)

var mu sync.Mutex

// notesDir resolves <mcp>/__NAME__/notes from the binary at <mcp>/bin/__NAME__, so the
// pages move with the root.
func notesDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "notes"
	}
	return filepath.Join(filepath.Dir(exe), "..", "__NAME__", "notes")
}

//__PAGE_HELPERS__

func main() {
	s := mcpx.NewServer("__NAME__", "0.1.0")

	s.AddTool(mcpx.Tool{
		Name:        "__NAME___add_note",
		Description: "Append a note or fact about __NAME__ to a page in its notebook. Pass 'page' to pick the page title — a new title starts a new page, an existing one appends — or omit it to use the default \"Notes\" page.",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"note": map[string]any{"type": "string", "description": "the note or fact to remember"},
			"page": map[string]any{"type": "string", "description": "optional page title to file the note under (default \"Notes\")"},
		}, []string{"note"}),
		Handler: func(args map[string]any) (string, error) {
			text, _ := args["note"].(string)
			text = strings.TrimSpace(text)
			if text == "" {
				return "nothing to save", nil
			}
			title, _ := args["page"].(string)
			if strings.TrimSpace(title) == "" {
				title = "Notes"
			}
			mu.Lock()
			defer mu.Unlock()
			if err := upsertPageIn(notesDir(), title, []string{text}); err != nil {
				return "", err
			}
			return "saved to __NAME__ page \"" + sanitizePageTitle(title) + "\"", nil
		},
	})

	s.AddTool(mcpx.Tool{
		Name:        "__NAME___notes",
		Description: "Return all of __NAME__'s notes: every page in order (the Appendix index first, then each content page).",
		InputSchema: mcpx.ObjectSchema(nil, nil),
		Handler: func(args map[string]any) (string, error) {
			mu.Lock()
			defer mu.Unlock()
			body := readAllPages(notesDir())
			if body == "" {
				return "no notes about __NAME__ yet.", nil
			}
			return body, nil
		},
	})

	s.AddTool(mcpx.Tool{
		Name:        "__NAME___rewrite",
		Description: "Replace one page's markdown in __NAME__. Pass 'page' as the page number (e.g. 1) or its title; an unknown title creates a new page. Use to consolidate, dedupe, or reorganize a page. Read __NAME___notes first so nothing is lost. You may link other pages with [[#N (Title)]] or other notebooks with [[slug::#N (Title)]].",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"page":    map[string]any{"type": "string", "description": "page number or title to rewrite"},
			"content": map[string]any{"type": "string", "description": "the full new markdown body for that page"},
		}, []string{"page", "content"}),
		Handler: func(args map[string]any) (string, error) {
			target, _ := args["page"].(string)
			content, _ := args["content"].(string)
			if strings.TrimSpace(target) == "" {
				return "which page? pass a page number or title.", nil
			}
			mu.Lock()
			defer mu.Unlock()
			file, err := rewritePageIn(notesDir(), target, content)
			if err != nil {
				return "", err
			}
			return "rewrote " + file, nil
		},
	})

	if err := s.Serve(); err != nil {
		panic(err)
	}
}
`))
