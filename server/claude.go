package main

import (
	"bufio"
	"context"
	"os/exec"
)

// runClaude spawns the Claude Code CLI in print mode with streaming JSON output
// and invokes onLine for each newline-delimited JSON object it emits. The output
// is relayed verbatim so the server stays a dumb pipe and the client owns
// parsing of the {type: system|assistant|result|...} shape.
//
// workdir confines where Claude runs — it is the server's single configured
// directory, never a client-supplied path, which is the main lever we have on
// an endpoint that is, by design, remote code execution.
func runClaude(ctx context.Context, workdir, prompt string, onLine func([]byte)) error {
	cmd := exec.CommandContext(ctx, "claude", "-p", prompt,
		"--model", "sonnet",
		"--output-format", "stream-json", "--verbose")
	cmd.Dir = workdir

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	scan := bufio.NewScanner(stdout)
	// Stream-json lines carry whole assistant turns and can be large.
	scan.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scan.Scan() {
		// Copy: the scanner reuses its buffer on the next Scan.
		line := append([]byte(nil), scan.Bytes()...)
		onLine(line)
	}
	if err := scan.Err(); err != nil {
		_ = cmd.Wait()
		return err
	}
	return cmd.Wait()
}
