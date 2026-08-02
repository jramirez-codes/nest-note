package claude

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"nestnote/server/internal/procio"
)

// OrchestrationPrompt is appended to Claude's system prompt when MCP is enabled.
// It's the glue that makes the toolset grow itself: the orchestrator holds the
// cross-turn memory (a mention tally), Claude supplies the per-turn subject and
// does the proposing, and creation only happens with the user's agreement.
const OrchestrationPrompt = `This session has an "orchestrator" MCP server that lets your toolset grow over time. Follow this routine, and keep it invisible to the user except when proposing a change:

1. Near the start of each turn, call orchestrator record_subject with a short lowercase slug for the MAIN subject or project the user is discussing (e.g. "greenhouse", "taxes-2026", "buddy-the-dog"). Use one slug and reuse the same one for the same subject across turns. Don't mention that you're doing this.
2. record_subject tells you when a subject has come up often enough to deserve its own notes server and doesn't have one yet. When it says so, briefly tell the user you can spin up a dedicated "<subject>" server to remember notes and facts about it, and ask if they want it. Do NOT create it unless they agree.
3. If the user agrees, call request_new_server with the subject name and a one-line summary. It becomes available on the NEXT message, with tools to add, list, and rewrite notes about that subject — tell the user that.
4. Store facts with <name>_add_note and recall them with <name>_notes. Each subject's notes live in a markdown file. When a subject's notes grow long, duplicated, or messy, read <name>_notes and call <name>_rewrite with a cleaned-up, consolidated markdown body — never drop facts, and do this quietly.
5. When two subjects clearly overlap (e.g. "garden" and "greenhouse"), you may tell the user you can consolidate them; only if they agree, call consolidate_subjects with the target subject to keep (into) and the ones to merge in and retire (from). It takes effect on the NEXT message.
6. Call list_capabilities whenever you need to see existing servers, trending subjects, or queued creations and consolidations.`

// Run spawns the Claude Code CLI in print mode with streaming JSON output
// and invokes onLine for each newline-delimited JSON object it emits. The output
// is relayed verbatim so the server stays a dumb pipe and the client owns
// parsing of the {type: system|assistant|result|...} shape.
//
// workdir confines where Claude runs — it is the server's single configured
// directory, never a client-supplied path, which is the main lever we have on
// an endpoint that is, by design, remote code execution.
//
// mcpConfigs are absolute paths to .mcp.json files (empty when -root is unset).
// When present they are loaded with --strict-mcp-config so only these servers
// are available — the MCP surface is exactly what the server scaffolded, never
// the host's ambient/global MCP settings. allowedTools pre-authorizes exactly
// those servers so their tools run in headless -p mode without a permission
// prompt; every other tool stays gated.
func Run(ctx context.Context, workdir string, mcpConfigs, allowedTools []string, prompt string, onLine func([]byte)) error {
	args := []string{"-p", prompt,
		"--model", "sonnet",
		// Emit per-token content_block_delta lines (not just one whole-turn
		// assistant message), so the app can type the answer out as it arrives.
		"--include-partial-messages",
		"--output-format", "stream-json", "--verbose"}
	if len(allowedTools) > 0 {
		args = append(args, "--allowedTools")
		args = append(args, allowedTools...)
	}
	if len(mcpConfigs) > 0 {
		// Teach Claude the orchestrator routine: report each turn's subject, and
		// propose (then, on the user's yes, create) a dedicated notes server when
		// a subject keeps coming up.
		args = append(args, "--append-system-prompt", OrchestrationPrompt)
		// --strict-mcp-config is a bool that precedes the variadic --mcp-config
		// so the config list runs cleanly to the end of the argv.
		args = append(args, "--strict-mcp-config", "--mcp-config")
		args = append(args, mcpConfigs...)
	}
	cmd := exec.CommandContext(ctx, "claude", args...)
	cmd.Dir = workdir

	// Capture stderr so a non-zero exit surfaces *why* Claude failed. Without
	// this the caller only sees "exit status 1" with no cause — the CLI writes
	// its real diagnostics (auth errors, bad flags, model/quota problems) here.
	// Bounded so a chatty run can't grow this without limit.
	var stderr procio.BoundedBuffer
	stderr.Limit = 64 * 1024
	cmd.Stderr = &stderr

	// Run Claude in its own process group so the whole tree — Claude plus every
	// MCP server it spawns — can be signalled together. A lingering MCP child
	// that inherited the stdout pipe would otherwise hold its write end open
	// after Claude exits, leaving the reader below blocked on EOF forever (an
	// eternal spinner on the phone). setProcGroup also SIGKILLs the group on ctx
	// timeout/cancel. Shared with the /exec handler (see internal/procio).
	procio.SetGroup(cmd)

	// Own the pipe (rather than StdoutPipe) so its lifetime isn't coupled to
	// Wait: we close the parent's write end after Start, leaving only the child
	// tree holding it, and read until every writer is gone.
	pr, pw, err := os.Pipe()
	if err != nil {
		return err
	}
	cmd.Stdout = pw
	if err := cmd.Start(); err != nil {
		pw.Close()
		pr.Close()
		return err
	}
	pw.Close() // the child tree keeps its own copies of the write end

	scanDone := make(chan error, 1)
	go func() {
		scan := bufio.NewScanner(pr)
		// Stream-json lines carry whole assistant turns and can be large.
		scan.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
		for scan.Scan() {
			// Copy: the scanner reuses its buffer on the next Scan.
			onLine(append([]byte(nil), scan.Bytes()...))
		}
		scanDone <- scan.Err()
	}()

	waitErr := cmd.Wait()
	// Claude has exited. Reap any MCP servers it left in the group so they
	// release the pipe's write end and the reader can reach EOF instead of
	// blocking indefinitely.
	procio.KillGroup(cmd)
	scanErr := <-scanDone
	pr.Close()

	if waitErr != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("%w: %s", waitErr, msg)
		}
		return waitErr
	}
	return scanErr
}
