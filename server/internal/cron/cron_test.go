package cron

import (
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
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

func (f *fakeCrontab) io() IO {
	return IO{
		List: func() (string, error) {
			if f.listErr != nil {
				return "", f.listErr
			}
			return f.content, nil
		},
		Save: func(s string) error {
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
	line := LineFor("/srv/nest", "greenhouse")
	if err := InstallLine(f.io(), "greenhouse", line); err != nil {
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
	line := LineFor("/srv/nest", "greenhouse")
	for i := 0; i < 3; i++ {
		if err := InstallLine(f.io(), "greenhouse", line); err != nil {
			t.Fatalf("install %d: %v", i, err)
		}
	}
	if n := strings.Count(f.content, marker("greenhouse")); n != 1 {
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
	if err := InstallLine(f.io(), "greenhouse", LineFor("/srv/nest", "greenhouse")); err != nil {
		t.Fatal(err)
	}
	if err := RemoveLine(f.io(), "greenhouse"); err != nil {
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
		if err := InstallLine(f.io(), slug, LineFor("/srv/nest", slug)); err != nil {
			t.Fatal(err)
		}
	}
	if err := RemoveLine(f.io(), "taxes-2026"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(f.content, marker("taxes-2026")) {
		t.Fatalf("taxes-2026 survived removal:\n%s", f.content)
	}
	for _, slug := range []string{"greenhouse", "buddy"} {
		if !strings.Contains(f.content, marker(slug)) {
			t.Fatalf("%s was removed as collateral:\n%s", slug, f.content)
		}
	}
}

// TestCronLinesSurviveAPrefixSlug is the collision the marker test has to be exact
// about: slugs come from project names, so one is routinely a prefix of another,
// and "# nestnote:greenhouse" reads as a substring of
// "# nestnote:greenhouse-tracker". Matching anywhere in the line means scheduling
// or cancelling the shorter build quietly disarms the longer one — a live build
// that never ticks again, and a crontab the user is sure they just watched an
// entry vanish from.
func TestCronLinesSurviveAPrefixSlug(t *testing.T) {
	f := &fakeCrontab{}
	for _, slug := range []string{"greenhouse-tracker", "greenhouse"} {
		if err := InstallLine(f.io(), slug, LineFor("/srv/nest", slug)); err != nil {
			t.Fatal(err)
		}
	}
	if !strings.Contains(f.content, marker("greenhouse-tracker")) {
		t.Fatalf("installing greenhouse took greenhouse-tracker's line with it:\n%s", f.content)
	}

	if err := RemoveLine(f.io(), "greenhouse"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.content, marker("greenhouse-tracker")) {
		t.Fatalf("removing greenhouse took greenhouse-tracker's line with it:\n%s", f.content)
	}
	if HasLine(f.content, "greenhouse") {
		t.Fatalf("greenhouse survived its own removal:\n%s", f.content)
	}

	// And the other way round: the longer slug leaves the shorter one's line be.
	if err := InstallLine(f.io(), "greenhouse", LineFor("/srv/nest", "greenhouse")); err != nil {
		t.Fatal(err)
	}
	if err := RemoveLine(f.io(), "greenhouse-tracker"); err != nil {
		t.Fatal(err)
	}
	if !HasLine(f.content, "greenhouse") {
		t.Fatalf("removing greenhouse-tracker took greenhouse's line with it:\n%s", f.content)
	}
}

// TestRemoveCronLineNeverInstalled: a no-op, not an error, and — importantly — not
// even a write. Every teardown path calls remove unconditionally, so a build that
// halts twice must not keep rewriting the host's crontab.
func TestRemoveCronLineNeverInstalled(t *testing.T) {
	f := &fakeCrontab{content: "0 4 * * * /usr/bin/backup\n"}
	if err := RemoveLine(f.io(), "never-installed"); err != nil {
		t.Fatalf("removing an absent slug: %v", err)
	}
	if f.saves != 0 {
		t.Fatalf("removing an absent slug wrote the crontab %d times, want 0", f.saves)
	}
}

// TestInstallCronLineFailsWhenTheWriteDoesNotStick covers the silent failure this
// feature dies of: a `crontab -` that exits 0 without keeping the entry. The
// build state would say "scheduled", the phone would show a start time, and
// nothing in the crontab would ever start it — so the install has to read back
// and report a failure the caller can put in front of the user.
func TestInstallCronLineFailsWhenTheWriteDoesNotStick(t *testing.T) {
	// A crontab that accepts every write and keeps none of them.
	swallow := IO{
		List: func() (string, error) { return "0 4 * * * /usr/bin/backup\n", nil },
		Save: func(string) error { return nil },
	}
	err := InstallLine(swallow, "greenhouse", LineFor("/srv/nest", "greenhouse"))
	if err == nil {
		t.Fatal("installing into a crontab that drops writes reported success")
	}
	if !strings.Contains(err.Error(), "greenhouse") {
		t.Fatalf("error = %q, want it to name the build that isn't scheduled", err)
	}

	// And the mirror image: a removal the crontab quietly ignored leaves cron
	// poking a build that has been stopped.
	stuck := IO{
		List: func() (string, error) { return LineFor("/srv/nest", "greenhouse") + "\n", nil },
		Save: func(string) error { return nil },
	}
	if err := RemoveLine(stuck, "greenhouse"); err == nil {
		t.Fatal("removing from a crontab that drops writes reported success")
	}
}

// TestInstallCronLineListFailurePropagates is the dangerous case: if `crontab -l`
// fails for a reason that ISN'T "no crontab for user", treating it as an empty
// crontab would rewrite every entry the user has out of existence. It has to be
// an error that stops the write.
func TestInstallCronLineListFailurePropagates(t *testing.T) {
	f := &fakeCrontab{listErr: errors.New("crontab: permission denied")}
	if err := InstallLine(f.io(), "greenhouse", LineFor("/srv/nest", "greenhouse")); err == nil {
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
	line := LineFor("/srv/nest", "greenhouse")
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

// TestCronLineAtShape pins the one-shot line a scheduled build installs: the
// minute, hour, day-of-month and month of the chosen start, and day-of-week left
// as "*". Cron ORs the two day fields, so anything but "*" there would quietly
// turn a single start into a weekly one.
func TestCronLineAtShape(t *testing.T) {
	at := time.Date(2026, time.August, 3, 21, 5, 0, 0, time.Local)
	line := LineAt("/srv/nest", "greenhouse", at)
	if got, want := strings.Fields(line)[:5], []string{"5", "21", "3", "8", "*"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("schedule fields = %v, want %v (line %q)", got, want, line)
	}
	for _, want := range []string{"/srv/nest/bin/nestnote-tick greenhouse", "# nestnote:greenhouse"} {
		if !strings.Contains(line, want) {
			t.Fatalf("cron line %q is missing %q", line, want)
		}
	}
}

// TestScheduledCronLinesInstallAndRemoveTogether: a scheduled build puts TWO
// lines in the crontab — the exact minute, and the ordinary recurring line as the
// safety net for a server that was down for that minute. Both must carry the
// marker, or removing the build would leave a date-pinned entry behind to fire
// again in a year.
func TestScheduledCronLinesInstallAndRemoveTogether(t *testing.T) {
	f := &fakeCrontab{content: "0 9 * * * /usr/bin/backup  # mine\n"}
	at := time.Date(2026, time.August, 3, 21, 5, 0, 0, time.Local)
	if err := InstallLine(f.io(), "greenhouse", ScheduledLines("/srv/nest", "greenhouse", at)); err != nil {
		t.Fatal(err)
	}
	var managed int
	for _, l := range strings.Split(strings.TrimSpace(f.content), "\n") {
		if strings.Contains(l, marker("greenhouse")) {
			managed++
		}
	}
	if managed != 2 {
		t.Fatalf("want the exact-minute line and the recurring one, got %d:\n%s", managed, f.content)
	}
	if !strings.Contains(f.content, "*/30 * * * *") || !strings.Contains(f.content, "5 21 3 8 *") {
		t.Fatalf("both schedules should be present:\n%s", f.content)
	}

	if err := RemoveLine(f.io(), "greenhouse"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(f.content, marker("greenhouse")) {
		t.Fatalf("removing the build left one of its lines behind:\n%s", f.content)
	}
	if !strings.Contains(f.content, "# mine") {
		t.Fatalf("the user's own line was eaten:\n%s", f.content)
	}
}

// TestWriteTickDriver checks the generated driver is executable, carries the
// token path and listen address it was built for, and honours the dry-run escape
// hatch — debugging a build otherwise means one iteration per tick interval.
func TestWriteTickDriver(t *testing.T) {
	root := t.TempDir()
	state := t.TempDir()
	if err := WriteTickDriver(root, state, "192.168.1.5:8443"); err != nil {
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
