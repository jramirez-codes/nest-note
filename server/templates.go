package main

import "strings"

// bt swaps the %BT% placeholder for a backtick so the templates below can carry
// Go struct tags while themselves being raw string literals.
func bt(s string) string { return strings.ReplaceAll(s, "%BT%", "`") }

// mcpxTmpl is a tiny, stdlib-only MCP server over stdio: newline-delimited
// JSON-RPC 2.0 with just the methods Claude needs (initialize, tools/list,
// tools/call, ping). It is copied verbatim into each generated module so the
// capability servers have no external dependencies and no network fetch on
// first build.
var mcpxTmpl = bt(`package mcpx

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

// dogMainTmpl is the seed capability server: a template to copy when adding a
// new server. Its "storage" is a stub — swap the handlers for real logic.
var dogMainTmpl = bt(`package main

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

// dogCapabilityTmpl is read by the orchestrator's list_capabilities tool. Every
// capability server folder should carry one of these describing itself.
var dogCapabilityTmpl = `{
  "name": "dog",
  "summary": "Profile and notes about Jordan's dog.",
  "tools": ["dog_profile", "dog_add_note"]
}
`

// orchestratorMainTmpl is the discovery + growth server. It still reports what
// exists (list_capabilities), but it also keeps a persistent tally of the
// subjects Claude reports each turn (record_subject) and decides, by a simple
// mention threshold, when a subject has come up often enough to deserve its own
// notes server. It never builds anything itself: request_new_server just drops
// a request file that the Go server materialises on the next run. That keeps all
// code generation on the trusted server side.
var orchestratorMainTmpl = bt(`package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
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
		Description: "File one or more notes under a subject, creating its notes store if needed. This is the workhorse for /ingest: call it once per distinct topic found on the page. The notes are saved immediately; if the subject had no server yet, one is queued and goes live on the next message. Reuse an existing subject slug when the topic matches one (call list_capabilities first).",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"subject": map[string]any{"type": "string", "description": "short lowercase slug for the topic, e.g. greenhouse or taxes-2026"},
			"summary": map[string]any{"type": "string", "description": "one-line description of the subject (used only when creating it)"},
			"notes":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "the notes/facts from the page to file under this subject"},
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
		Name:        "list_capabilities",
		Description: "List existing capability servers, subjects trending toward their own server, and any queued creations or consolidations.",
		InputSchema: mcpx.ObjectSchema(nil, nil),
		Handler:     func(args map[string]any) (string, error) { return listCapabilities(), nil },
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

// hasServer reports whether a capability server folder already exists for name.
func hasServer(name string) bool {
	if mcpDir == "" || name == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(mcpDir, name))
	return err == nil && info.IsDir()
}

func subjectsPath() string      { return filepath.Join(stateDir, "subjects.json") }
func requestsDir() string       { return filepath.Join(stateDir, "requests") }
func consolidationsDir() string { return filepath.Join(stateDir, "consolidations") }
func suggestionsDir() string    { return filepath.Join(stateDir, "suggestions") }

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
	return fmt.Sprintf("queued consolidation of %s into %q. Live on the next message; the merged subjects are retired.", strings.Join(from, ", "), into), nil
}

// ingestTopic files notes under a subject during /ingest. Unlike request_new_server
// (which only queues a build), it writes the note markdown immediately so the
// dashboard shows it this instant — and, when the subject has no server code yet,
// also queues one so the queryable MCP binary comes online next message. Notes and
// the generated fact-store server share the same file (<mcp>/<name>/<name>.md), and
// materialization uses writeIfMissing for the .md, so the queued build never
// clobbers what we write here.
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

	dir := filepath.Join(mcpDir, name)
	mdPath := filepath.Join(dir, name+".md")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}

	body, err := os.ReadFile(mdPath)
	isNew := err != nil // no notes file yet -> this subject is brand new
	if isNew {
		head := "# " + name + "\n\n"
		if summary != "" {
			head += summary + "\n"
		}
		body = []byte(head)
	}
	text := string(body)
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	stamp := time.Now().Format("2006-01-02 15:04")
	for _, n := range notes {
		text += "- " + n + " <!-- " + stamp + " -->\n"
	}
	if err := os.WriteFile(mdPath, []byte(text), 0o644); err != nil {
		return "", err
	}

	// Queue the queryable MCP binary if this subject has no server code yet.
	created := false
	if _, err := os.Stat(filepath.Join(dir, "main.go")); err != nil {
		s := summary
		if s == "" {
			s = "Notes and facts about " + name + "."
		}
		os.MkdirAll(requestsDir(), 0o755)
		req := map[string]string{"name": name, "summary": s}
		data, _ := json.MarshalIndent(req, "", "  ")
		os.WriteFile(filepath.Join(requestsDir(), name+".json"), append(data, '\n'), 0o644)
		created = true
	}

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

func listCapabilities() string {
	var b strings.Builder

	var caps []capability
	if mcpDir != "" {
		entries, _ := os.ReadDir(mcpDir)
		for _, e := range entries {
			if !e.IsDir() {
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
`)

// factStoreMainTmpl is the body of a generated per-subject notes server. The Go
// server substitutes __NAME__ for the subject slug before writing it. Notes are
// kept as a plain markdown file at <mcp>/__NAME__/__NAME__.md, resolved from the
// running binary's location (<mcp>/bin/__NAME__) so it moves with the root.
// add_note appends a bullet, notes returns the whole file, and rewrite replaces
// it — the tool Claude uses to consolidate/dedupe/reorganize a subject's notes.
var factStoreMainTmpl = bt(`package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ainotepad-mcp/mcpx"
)

var mu sync.Mutex

// notePath resolves <mcp>/__NAME__/__NAME__.md from the binary at
// <mcp>/bin/__NAME__, so the markdown moves with the root.
func notePath() string {
	exe, err := os.Executable()
	if err != nil {
		return "__NAME__.md"
	}
	return filepath.Join(filepath.Dir(exe), "..", "__NAME__", "__NAME__.md")
}

func readBody() string {
	data, err := os.ReadFile(notePath())
	if err != nil {
		return ""
	}
	return string(data)
}

func writeBody(s string) error {
	if !strings.HasSuffix(s, "\n") {
		s += "\n"
	}
	return os.WriteFile(notePath(), []byte(s), 0o644)
}

func main() {
	s := mcpx.NewServer("__NAME__", "0.1.0")

	s.AddTool(mcpx.Tool{
		Name:        "__NAME___add_note",
		Description: "Append a note or fact about __NAME__ as a markdown bullet.",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"note": map[string]any{"type": "string", "description": "the note or fact to remember"},
		}, []string{"note"}),
		Handler: func(args map[string]any) (string, error) {
			text, _ := args["note"].(string)
			text = strings.TrimSpace(text)
			if text == "" {
				return "nothing to save", nil
			}
			mu.Lock()
			defer mu.Unlock()
			body := readBody()
			if body != "" && !strings.HasSuffix(body, "\n") {
				body += "\n"
			}
			body += "- " + text + " <!-- " + time.Now().Format("2006-01-02 15:04") + " -->\n"
			if err := writeBody(body); err != nil {
				return "", err
			}
			return "saved to __NAME__.md", nil
		},
	})

	s.AddTool(mcpx.Tool{
		Name:        "__NAME___notes",
		Description: "Return the full __NAME__.md markdown notes.",
		InputSchema: mcpx.ObjectSchema(nil, nil),
		Handler: func(args map[string]any) (string, error) {
			mu.Lock()
			defer mu.Unlock()
			body := strings.TrimSpace(readBody())
			if body == "" {
				return "no notes about __NAME__ yet.", nil
			}
			return body, nil
		},
	})

	s.AddTool(mcpx.Tool{
		Name:        "__NAME___rewrite",
		Description: "Replace the entire __NAME__.md with new markdown. Use to consolidate, dedupe, or reorganize the notes. Read __NAME___notes first so nothing is lost.",
		InputSchema: mcpx.ObjectSchema(map[string]any{
			"content": map[string]any{"type": "string", "description": "the full new markdown body for __NAME__.md"},
		}, []string{"content"}),
		Handler: func(args map[string]any) (string, error) {
			content, _ := args["content"].(string)
			mu.Lock()
			defer mu.Unlock()
			if err := writeBody(content); err != nil {
				return "", err
			}
			return "rewrote __NAME__.md", nil
		},
	})

	if err := s.Serve(); err != nil {
		panic(err)
	}
}
`)
