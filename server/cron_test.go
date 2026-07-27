package main

import (
	"errors"
	"os"
	"strings"
	"testing"
)

// fakeCrontab stands in for the crontab binary. Every test in this package uses
// it rather than the real one: the crontab layer is the part of a scheduled build
// that reaches out and touches the host, so it is exactly the layer that must
// never be exercised against a developer's actual crontab.
type fakeCrontab struct {
	content string
	saves   int
	listErr error
	saveErr error
}

func (f *fakeCrontab) io() crontabIO {
	return crontabIO{
		list: func() (string, error) {
			if f.listErr != nil {
				return "", f.listErr
			}
			return f.content, nil
		},
		save: func(s string) error {
			if f.saveErr != nil {
				return f.saveErr
			}
			f.content = s
			f.saves++
			return nil
		},
	}
}

// TestInstallCronLineFromNothing covers the fresh machine: `crontab -l` reports
// no crontab at all, which the real IO turns into ("", nil). That must not be
// fatal — it is the normal state of a host that has never had one.
func TestInstallCronLineFromNothing(t *testing.T) {
	f := &fakeCrontab{}
	line := cronLineFor("/srv/nest", "greenhouse")
	if err := installCronLine(f.io(), "greenhouse", line); err != nil {
		t.Fatalf("install on an empty crontab: %v", err)
	}
	if f.content != line+"\n" {
		t.Fatalf("content = %q, want %q", f.content, line+"\n")
	}
}

// TestInstallCronLineIsIdempotent: installing twice leaves one line, not two.
// The drop-then-append order is what guarantees it, so this is really a test that
// the order never gets swapped.
func TestInstallCronLineIsIdempotent(t *testing.T) {
	f := &fakeCrontab{}
	line := cronLineFor("/srv/nest", "greenhouse")
	for i := 0; i < 3; i++ {
		if err := installCronLine(f.io(), "greenhouse", line); err != nil {
			t.Fatalf("install %d: %v", i, err)
		}
	}
	if n := strings.Count(f.content, cronMarker("greenhouse")); n != 1 {
		t.Fatalf("marker appears %d times, want 1:\n%s", n, f.content)
	}
}

// TestCrontabPreservesUserLines: the user's own entries survive a round trip
// byte-for-byte, including comments and blank lines between them. Anything less
// and a scheduled build would be quietly eating someone's backup job.
func TestCrontabPreservesUserLines(t *testing.T) {
	user := strings.Join([]string{
		"# my own jobs",
		"MAILTO=me@example.com",
		"0 4 * * * /usr/bin/backup --full",
		"",
		"*/5 * * * * /home/me/bin/ping-check  # not nestnote",
	}, "\n") + "\n"

	f := &fakeCrontab{content: user}
	if err := installCronLine(f.io(), "greenhouse", cronLineFor("/srv/nest", "greenhouse")); err != nil {
		t.Fatal(err)
	}
	if err := removeCronLine(f.io(), "greenhouse"); err != nil {
		t.Fatal(err)
	}
	if f.content != user {
		t.Fatalf("user crontab did not survive a round trip.\n got: %q\nwant: %q", f.content, user)
	}
}

// TestRemoveCronLineLeavesOtherBuilds: removing one build's line must not disturb
// another build's, which is the whole reason the marker carries the slug.
func TestRemoveCronLineLeavesOtherBuilds(t *testing.T) {
	f := &fakeCrontab{}
	for _, slug := range []string{"greenhouse", "taxes-2026", "buddy"} {
		if err := installCronLine(f.io(), slug, cronLineFor("/srv/nest", slug)); err != nil {
			t.Fatal(err)
		}
	}
	if err := removeCronLine(f.io(), "taxes-2026"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(f.content, cronMarker("taxes-2026")) {
		t.Fatalf("taxes-2026 survived removal:\n%s", f.content)
	}
	for _, slug := range []string{"greenhouse", "buddy"} {
		if !strings.Contains(f.content, cronMarker(slug)) {
			t.Fatalf("%s was removed as collateral:\n%s", slug, f.content)
		}
	}
}

// TestRemoveCronLineNeverInstalled: a no-op, not an error, and — importantly — not
// even a write. Every teardown path calls remove unconditionally, so a build that
// halts twice must not keep rewriting the host's crontab.
func TestRemoveCronLineNeverInstalled(t *testing.T) {
	f := &fakeCrontab{content: "0 4 * * * /usr/bin/backup\n"}
	if err := removeCronLine(f.io(), "never-installed"); err != nil {
		t.Fatalf("removing an absent slug: %v", err)
	}
	if f.saves != 0 {
		t.Fatalf("removing an absent slug wrote the crontab %d times, want 0", f.saves)
	}
}

// TestInstallCronLineListFailurePropagates is the dangerous case: if `crontab -l`
// fails for a reason that ISN'T "no crontab for user", treating it as an empty
// crontab would rewrite every entry the user has out of existence. It has to be
// an error that stops the write.
func TestInstallCronLineListFailurePropagates(t *testing.T) {
	f := &fakeCrontab{listErr: errors.New("crontab: permission denied")}
	if err := installCronLine(f.io(), "greenhouse", cronLineFor("/srv/nest", "greenhouse")); err == nil {
		t.Fatal("want an error when the crontab cannot be read, got nil")
	}
	if f.saves != 0 {
		t.Fatalf("wrote the crontab %d times despite an unreadable listing, want 0", f.saves)
	}
}

// TestCronLineShape pins the generated line: the schedule, the ONE shared driver
// with the slug as argv, and the marker. The marker is what makes every entry
// greppable and individually removable, so its absence is a real bug.
func TestCronLineShape(t *testing.T) {
	line := cronLineFor("/srv/nest", "greenhouse")
	for _, want := range []string{
		"*/30 * * * *",
		"/srv/nest/bin/nestnote-tick greenhouse",
		"# nestnote:greenhouse",
	} {
		if !strings.Contains(line, want) {
			t.Fatalf("cron line %q is missing %q", line, want)
		}
	}
	if strings.Contains(line, "\n") {
		t.Fatalf("cron line must be a single line, got %q", line)
	}
}

// TestWriteTickDriver checks the generated driver is executable, carries the
// token path and listen address it was built for, and honours the dry-run escape
// hatch — debugging a build otherwise means one iteration per tick interval.
func TestWriteTickDriver(t *testing.T) {
	root := t.TempDir()
	state := t.TempDir()
	cfg := buildConfig{root: root, stateDir: state, listenAddr: "192.168.1.5:8443"}
	if err := writeTickDriver(cfg); err != nil {
		t.Fatal(err)
	}
	path := tickDriverPath(root)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("driver is not executable (mode %v) — cron could never run it", info.Mode())
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		state + "/token",
		"https://192.168.1.5:8443/build/tick",
		"NESTNOTE_TICK_DRY_RUN",
	} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("driver is missing %q:\n%s", want, body)
		}
	}
}
