package main

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// cardCall builds a tools/call frame for one of the card-management tools
// (upsert_card, list_cards, dismiss_card).
func cardCall(t *testing.T, id int, name string, args map[string]any) string {
	return rpcLine(t, id, "tools/call", map[string]any{
		"name":      name,
		"arguments": args,
	})
}

// rpcResult is the shape of a JSON-RPC tools/call reply: the tool's text lives at
// result.content[0].text.
type rpcResult struct {
	ID     int `json:"id"`
	Result struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	} `json:"result"`
}

// textOf finds the reply with the given id in newline-delimited JSON-RPC output
// and returns its tool text, or "" if not found.
func textOf(t *testing.T, out []byte, id int) string {
	t.Helper()
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		var r rpcResult
		if json.Unmarshal([]byte(line), &r) != nil || r.ID != id {
			continue
		}
		if len(r.Result.Content) > 0 {
			return r.Result.Content[0].Text
		}
	}
	return ""
}

// TestOrchestratorCardTools drives the generated orchestrator binary's card tools
// end to end over stdio: upsert_card(done) actually flips a task's done state,
// list_cards(source) filters to one subject, and dismiss_card hides a card from
// later listings. This exercises exactly what /talk's task-editing prompt and
// /agg-tasks rely on.
func TestOrchestratorCardTools(t *testing.T) {
	if testing.Short() {
		t.Skip("scaffold runs go build; skipped in -short")
	}
	root := t.TempDir()
	mcpDir := filepath.Join(root, "mcp")
	stateDir := filepath.Join(root, "orchestrator", "state")

	if _, err := scaffoldRoot(root, 4); err != nil {
		t.Fatalf("scaffoldRoot failed: %v", err)
	}
	orchBin := filepath.Join(root, "orchestrator", "bin", "orchestrator")

	run := func(in string) []byte {
		t.Helper()
		cmd := exec.Command(orchBin, "-mcp-dir", mcpDir, "-state-dir", stateDir, "-threshold", "4")
		cmd.Stdin = strings.NewReader(in)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("orchestrator run failed: %v\n%s", err, out)
		}
		return out
	}

	handshake := rpcLine(t, 1, "initialize", map[string]any{"protocolVersion": "2025-06-18"}) +
		rpcLine(t, 0, "notifications/initialized", nil)

	// Create two tasks under "greenhouse" and one under "taxes" so list_cards'
	// source filter has something to prove.
	out := run(handshake +
		cardCall(t, 2, "upsert_card", map[string]any{
			"kind": "task", "title": "Water tomatoes", "priority": "high", "source": "greenhouse",
		}) +
		cardCall(t, 3, "upsert_card", map[string]any{
			"kind": "task", "title": "Prune roses", "priority": "normal", "source": "greenhouse",
		}) +
		cardCall(t, 4, "upsert_card", map[string]any{
			"kind": "task", "title": "File W2", "priority": "urgent", "source": "taxes",
		}) +
		cardCall(t, 5, "list_cards", map[string]any{"source": "greenhouse"}),
	)
	list := textOf(t, out, 5)
	if !strings.Contains(list, "Water tomatoes") || !strings.Contains(list, "Prune roses") {
		t.Fatalf("source-filtered list_cards should include both greenhouse tasks, got: %s", list)
	}
	if strings.Contains(list, "File W2") {
		t.Fatalf("source-filtered list_cards should exclude the taxes task, got: %s", list)
	}

	// Mark "Water tomatoes" done via upsert_card(done=true), then confirm
	// list_cards reflects it without a second, unrelated run in between.
	waterID := "task-water-tomatoes"
	out = run(handshake +
		cardCall(t, 2, "upsert_card", map[string]any{
			"kind": "task", "title": "Water tomatoes", "priority": "high", "source": "greenhouse",
			"id": waterID, "done": true,
		}) +
		cardCall(t, 3, "list_cards", map[string]any{"source": "greenhouse"}),
	)
	upsertMsg := textOf(t, out, 2)
	if !strings.Contains(upsertMsg, "done") {
		t.Fatalf("upsert_card reply should note the card is done, got: %s", upsertMsg)
	}
	list = textOf(t, out, 3)
	if !strings.Contains(list, "Water tomatoes") || !strings.Contains(list, "(done)") {
		t.Fatalf("list_cards should show Water tomatoes as done, got: %s", list)
	}

	// dismiss_card hides it from later listings.
	out = run(handshake +
		cardCall(t, 2, "dismiss_card", map[string]any{"id": waterID, "source": "greenhouse"}) +
		cardCall(t, 3, "list_cards", map[string]any{"source": "greenhouse"}),
	)
	dismissMsg := textOf(t, out, 2)
	if !strings.Contains(dismissMsg, "dismissed") {
		t.Fatalf("dismiss_card should confirm the dismissal, got: %s", dismissMsg)
	}
	list = textOf(t, out, 3)
	if strings.Contains(list, "Water tomatoes") {
		t.Fatalf("dismissed card should no longer be listed, got: %s", list)
	}
	if !strings.Contains(list, "Prune roses") {
		t.Fatalf("dismissing one card should not affect the other, got: %s", list)
	}

	// dismiss_card on an unknown id should reply, not hang or error the process.
	out = run(handshake + cardCall(t, 2, "dismiss_card", map[string]any{"id": "nope-not-real"}))
	notFoundMsg := textOf(t, out, 2)
	if !strings.Contains(notFoundMsg, "no card found") {
		t.Fatalf("dismiss_card on an unknown id should say so, got: %s", notFoundMsg)
	}
}
