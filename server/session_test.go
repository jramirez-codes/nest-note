package main

import (
	"testing"
	"time"
)

func TestPushFrameBoundedAndDropped(t *testing.T) {
	var ring [][]byte
	dropped := false
	for i := 0; i < ringCap; i++ {
		ring = pushFrame(ring, []byte{byte(i)}, &dropped)
	}
	if len(ring) != ringCap {
		t.Fatalf("ring len = %d, want %d", len(ring), ringCap)
	}
	if dropped {
		t.Fatalf("dropped set before overflow")
	}
	// One more overflows: oldest drops, flag trips, length stays capped.
	ring = pushFrame(ring, []byte("new"), &dropped)
	if len(ring) != ringCap {
		t.Fatalf("ring len after overflow = %d, want %d", len(ring), ringCap)
	}
	if !dropped {
		t.Fatalf("dropped not set after overflow")
	}
	if string(ring[len(ring)-1]) != "new" {
		t.Fatalf("newest frame not retained")
	}
}

func TestReapDecisionDoneLingers(t *testing.T) {
	now := time.Now()
	s := &session{kind: "run", done: true, doneAt: now}

	// Within the linger window: keep it (a reconnect may still want the result).
	if remove, kill := reapDecision(s, now.Add(sessionLinger-time.Second)); remove || kill {
		t.Fatalf("finished session reaped inside linger: remove=%v kill=%v", remove, kill)
	}
	// Past the linger: remove, but never signal a kill (the process is already gone).
	remove, kill := reapDecision(s, now.Add(sessionLinger+time.Second))
	if !remove || kill {
		t.Fatalf("finished session past linger: remove=%v kill=%v, want true,false", remove, kill)
	}
}

func TestReapDecisionOrphanTTLByKind(t *testing.T) {
	now := time.Now()
	cases := []struct {
		kind string
		ttl  time.Duration
	}{
		{"run", sessionTTLDefault},
		{"exec", sessionTTLDefault},
		{"code", sessionTTLCode},
	}
	for _, c := range cases {
		s := &session{kind: c.kind, detachedAt: now}
		// Just inside the TTL: still alive.
		if remove, _ := reapDecision(s, now.Add(c.ttl-time.Second)); remove {
			t.Fatalf("%s: reaped inside TTL", c.kind)
		}
		// Past the TTL with no socket attached: reap AND kill the orphan process.
		remove, kill := reapDecision(s, now.Add(c.ttl+time.Second))
		if !remove || !kill {
			t.Fatalf("%s: orphan past TTL: remove=%v kill=%v, want true,true", c.kind, remove, kill)
		}
	}
}

func TestReapDecisionAttachedNeverReaped(t *testing.T) {
	now := time.Now()
	// A session with a socket attached (detachedAt zero) is never orphan-reaped,
	// however old — someone is watching it.
	s := &session{kind: "code"}
	if remove, kill := reapDecision(s, now.Add(24*time.Hour)); remove || kill {
		t.Fatalf("attached session reaped: remove=%v kill=%v", remove, kill)
	}
}

func TestFindOrCreateAndGet(t *testing.T) {
	reg := &sessionRegistry{m: map[string]*session{}} // no reaper goroutine in test

	if reg.get("a") != nil {
		t.Fatalf("get of missing id returned non-nil")
	}
	s1, created := reg.findOrCreate("a", "code")
	if !created {
		t.Fatalf("first findOrCreate: created=false, want true")
	}
	s2, created := reg.findOrCreate("a", "code")
	if created {
		t.Fatalf("second findOrCreate: created=true, want false (reconnect)")
	}
	if s1 != s2 {
		t.Fatalf("findOrCreate returned different sessions for the same id")
	}
	if reg.get("a") != s1 {
		t.Fatalf("get returned a different session than findOrCreate")
	}
	reg.remove("a")
	if reg.get("a") != nil {
		t.Fatalf("session still present after remove")
	}
}

func TestFindOrCreateForRunReplacesFinishedSession(t *testing.T) {
	reg := &sessionRegistry{m: map[string]*session{}} // no reaper goroutine in test

	// A running session must be reused (a duplicate/racing connect attaches to the
	// live run rather than starting a second process).
	running, created := reg.findOrCreateForRun("a", "run")
	if !created {
		t.Fatalf("first findOrCreateForRun: created=false, want true")
	}
	again, created := reg.findOrCreateForRun("a", "run")
	if created || again != running {
		t.Fatalf("running session was not reused: created=%v same=%v", created, again == running)
	}

	// Once it finishes (lingering only for a resume replay), a fresh non-resume run
	// reusing the id — the /chat follow-up case — must get a NEW session so it runs
	// the new prompt instead of replaying the finished one's buffered output.
	running.mu.Lock()
	running.done = true
	running.mu.Unlock()
	fresh, created := reg.findOrCreateForRun("a", "run")
	if !created {
		t.Fatalf("finished session was reused; want a fresh session for the new run")
	}
	if fresh == running {
		t.Fatalf("findOrCreateForRun returned the finished session, want a replacement")
	}
	if reg.get("a") != fresh {
		t.Fatalf("registry did not hold the replacement session")
	}
}

func TestSweepReapsOrphanAndKills(t *testing.T) {
	reg := &sessionRegistry{m: map[string]*session{}}
	killed := false
	orphan := &session{
		id:         "orphan",
		kind:       "code",
		detachedAt: time.Now().Add(-sessionTTLCode - time.Minute),
		cancel:     func() { killed = true },
	}
	live := &session{id: "live", kind: "code"} // attached (detachedAt zero)
	reg.m["orphan"] = orphan
	reg.m["live"] = live

	reg.sweep(time.Now())

	if reg.get("orphan") != nil {
		t.Fatalf("orphaned session not reaped")
	}
	if !killed {
		t.Fatalf("orphan reap did not cancel the process")
	}
	if reg.get("live") == nil {
		t.Fatalf("attached session was reaped")
	}
}
