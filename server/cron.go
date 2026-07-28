package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Scheduled builds are driven by real entries in the user's crontab, and the Go
// server owns every mutation of it — never the agent. An agent running with
// bypassPermissions editing the host's crontab is both untestable and the worst
// possible blast radius; here it is one function doing an idempotent block
// rewrite, with the crontab binary injected so tests never touch a developer's
// real one.
//
// Every managed line carries a marker comment:
//
//	*/30 * * * * /srv/nest/bin/nestnote-tick greenhouse  # nestnote:greenhouse
//
// which makes the entries greppable, individually removable, and safe alongside
// the user's own lines — those are passed through untouched, byte for byte.

// cronMarker is the trailing comment that identifies a line as ours.
func cronMarker(slug string) string { return "# nestnote:" + slug }

// crontabIO is the crontab binary as two operations, injected so the block
// rewriting can be tested against a fake. list must report an empty crontab as
// ("", nil) — "no crontab for user" is the normal state of a fresh machine, not
// an error.
type crontabIO struct {
	list func() (string, error)
	save func(string) error
}

// realCrontabIO drives the actual `crontab` binary.
func realCrontabIO() crontabIO {
	return crontabIO{
		list: func() (string, error) {
			cmd := exec.Command("crontab", "-l")
			var stderr strings.Builder
			cmd.Stderr = &stderr
			out, err := cmd.Output()
			if err != nil {
				// A user with no crontab yet exits non-zero saying so. That is an
				// empty crontab, not a failure. Anything else is propagated — the
				// caller must NOT treat an unreadable crontab as an empty one, or a
				// transient error would rewrite the user's real entries away.
				if strings.Contains(strings.ToLower(stderr.String()), "no crontab") {
					return "", nil
				}
				return "", fmt.Errorf("crontab -l: %w: %s", err, strings.TrimSpace(stderr.String()))
			}
			return string(out), nil
		},
		save: func(content string) error {
			cmd := exec.Command("crontab", "-")
			cmd.Stdin = strings.NewReader(content)
			var stderr strings.Builder
			cmd.Stderr = &stderr
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("crontab -: %w: %s", err, strings.TrimSpace(stderr.String()))
			}
			return nil
		},
	}
}

// rewriteCrontab drops every line tagged for slug and appends line if it is
// non-empty, returning the new crontab. Pure, so the whole install/remove policy
// is testable without a crontab anywhere in sight.
//
// Installing is therefore idempotent by construction: the drop always runs first,
// so installing twice leaves one line rather than two.
func rewriteCrontab(current, slug, line string) string {
	marker := cronMarker(slug)
	var kept []string
	for _, l := range strings.Split(current, "\n") {
		if strings.Contains(l, marker) {
			continue
		}
		kept = append(kept, l)
	}
	// Drop trailing blank lines so repeated rewrites don't accumulate them, then
	// re-terminate the file properly at the end.
	for len(kept) > 0 && strings.TrimSpace(kept[len(kept)-1]) == "" {
		kept = kept[:len(kept)-1]
	}
	if line != "" {
		kept = append(kept, line)
	}
	if len(kept) == 0 {
		return ""
	}
	return strings.Join(kept, "\n") + "\n"
}

// installCronLine puts (or replaces) slug's scheduled tick.
func installCronLine(io crontabIO, slug, line string) error {
	if io.list == nil || io.save == nil {
		return fmt.Errorf("crontab unavailable")
	}
	current, err := io.list()
	if err != nil {
		return err
	}
	return io.save(rewriteCrontab(current, slug, line))
}

// removeCronLine takes slug's scheduled tick out. Removing a slug that was never
// installed is a no-op, not an error, so every caller can just call it — including
// the ones that don't know whether a line exists.
//
// Cleanup is mandatory rather than a nicety: without it, deleting a project (or
// halting a build) leaves cron firing every half hour at a directory that no
// longer exists.
func removeCronLine(io crontabIO, slug string) error {
	if io.list == nil || io.save == nil {
		return nil
	}
	current, err := io.list()
	if err != nil {
		return err
	}
	if !strings.Contains(current, cronMarker(slug)) {
		return nil
	}
	return io.save(rewriteCrontab(current, slug, ""))
}

// tickDriverPath is the ONE shared driver every project's crontab line invokes,
// with the slug as argv. Not one copy per project: a bug in a per-project script
// would have to be fixed in every project folder that already exists, whereas this
// is patched in one place and every build picks it up on its next tick.
func tickDriverPath(root string) string {
	return filepath.Join(root, "bin", "nestnote-tick")
}

// cronLineFor is the crontab line for one build.
func cronLineFor(root, slug string) string {
	return fmt.Sprintf("*/%d * * * * %s %s  %s",
		buildTickMinutes, tickDriverPath(root), slug, cronMarker(slug))
}

// cronLineAt fires a single tick at one specific minute — the start time the user
// picked for a build. Day-of-week stays "*" because the day-of-month and month
// fields already pin the date; in cron the two day fields are OR'd, so anything
// but "*" there would fire on every matching weekday as well.
//
// The time is converted to the machine's local zone: the phone sends an instant
// (UTC), and cron reads wall clock.
func cronLineAt(root, slug string, at time.Time) string {
	t := at.Local()
	return fmt.Sprintf("%d %d %d %d * %s %s  %s",
		t.Minute(), t.Hour(), t.Day(), int(t.Month()), tickDriverPath(root), slug, cronMarker(slug))
}

// scheduledCronLines is what a build waiting for its start time installs: the
// exact-minute line, plus the ordinary recurring line underneath it.
//
// Both, not either. The exact line is what makes "build it at 9pm" start at 9pm
// rather than up to buildTickMinutes late. The recurring line is the safety net,
// and it is the one that matters in practice: a one-shot date in the crontab
// repeats *annually*, so if the server happened to be down for that single minute
// the build would sit scheduled until next year. With the recurring line there,
// the next ordinary tick starts it instead, and the first tick to run rewrites
// this pair down to the recurring line alone.
//
// One string, two lines — installCronLine appends it as written, and both carry
// the marker, so removing the slug still takes the pair out together.
func scheduledCronLines(root, slug string, at time.Time) string {
	return cronLineAt(root, slug, at) + "\n" + cronLineFor(root, slug)
}

// tickDriverTmpl is the driver: read the token, poke the server, exit. That is
// deliberately the whole job — the build itself runs inside the server process so
// it inherits the server's environment (see buildTickHandler), which cron's own
// stripped environment could never reproduce.
//
// TLS is not verified because the destination is this machine's own listener and
// the bearer token is the actual authentication; the pinned-cert dance exists for
// the phone crossing a network, which this never does.
const tickDriverTmpl = `#!/bin/sh
# NestNote build tick — GENERATED by the companion server, rewritten on every
# /build/start. Do not edit: your changes will be overwritten.
#
# Usage: nestnote-tick <project-slug>
#
# All this does is tell the server "it's time to look at this build". The build
# itself runs inside the server process, which is the only place with the
# environment (PATH, profile, credentials) an agent run needs — cron's own
# environment has none of it.
#
# Set NESTNOTE_TICK_DRY_RUN=1 to ask what the tick WOULD do, including the prompt
# it would send, without starting anything.
set -eu

slug="${1:-}"
if [ -z "$slug" ]; then
	echo "usage: nestnote-tick <project-slug>" >&2
	exit 2
fi

token=$(cat %q) || { echo "nestnote-tick: cannot read the server token" >&2; exit 1; }

dry=false
if [ -n "${NESTNOTE_TICK_DRY_RUN:-}" ]; then
	dry=true
fi

exec curl --silent --show-error --insecure --max-time 60 \
	-X POST "https://%s/build/tick" \
	-H "Authorization: Bearer $token" \
	-H "Content-Type: application/json" \
	-d "{\"slug\":\"$slug\",\"dry_run\":$dry}"
`

// writeTickDriver (re)writes the shared driver script. Called on every
// /build/start so an upgraded server refreshes the copy that every existing
// crontab line already points at.
func writeTickDriver(cfg buildConfig) error {
	if cfg.root == "" {
		return fmt.Errorf("no -root, nowhere to put the tick driver")
	}
	path := tickDriverPath(cfg.root)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	body := fmt.Sprintf(tickDriverTmpl, filepath.Join(cfg.stateDir, "token"), cfg.listenAddr)
	return os.WriteFile(path, []byte(body), 0o755)
}
