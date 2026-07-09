package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// randomSessionID mints an id for an ephemeral (non-durable) session — used when a
// client connects without a sessionId, so it can't be resumed and is keyed
// uniquely for the lifetime of its one socket.
func randomSessionID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return "eph-" + hex.EncodeToString(b[:])
}

// mustJSON marshals a frame, discarding the (impossible for these maps) error.
func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// writeGone tells a resume-only client that the session it asked for is gone
// (reaped or never existed) and closes, so the client finalizes the card as
// interrupted rather than accidentally opening a fresh run.
func writeGone(c *websocket.Conn) {
	_ = c.Write(context.Background(), websocket.MessageText, mustJSON(map[string]any{"type": "gone"}))
	c.Close(websocket.StatusNormalClosure, "gone")
}

// Durable sessions decouple a streaming run's process from the socket watching
// it. Before this, closing the socket (the phone backgrounding, or being killed)
// killed the laptop-side process — so an AI run couldn't outlive the app. Now the
// process is owned by a session that keeps running and buffering output when no
// socket is attached; the phone reconnects by id and replays the buffered tail to
// rebuild its view, then rides the live stream to completion.
//
// Reconnect model: instead of per-frame sequence numbers, a (re)connecting client
// clears its own accumulated state and the session replays its whole buffered
// tail. That keeps the wire format unchanged (every frame is exactly what the
// one-shot handlers already emit) and the buffer bounded — at the cost of only
// ever being able to replay the last `ringCap` frames (a long-idle reconnect gets
// the tail, flagged via `dropped`).
//
// A session ends only on an explicit kill, the process exiting (then a short
// linger so a reconnecting client still gets the result), or the orphan TTL
// elapsing with no socket attached — 30 min in general, 10 min for /code, whose
// bypassPermissions process runs arbitrary code and shouldn't idle unattended.

const (
	sessionTTLDefault = 30 * time.Minute
	sessionTTLCode    = 10 * time.Minute
	// Keep a finished session briefly so a client reconnecting right as it ends
	// still replays the terminal (exit/result) frame instead of getting `gone`.
	sessionLinger = 60 * time.Second
	// Max frames retained for replay. Enough for a long /code transcript's tail;
	// older frames drop (and set `dropped`) rather than growing without bound.
	ringCap = 4096
	// How often the reaper sweeps for finished/orphaned sessions.
	reapInterval = 30 * time.Second
)

// session owns one durable run: its process (via cancel), the buffered frames for
// replay, and whichever socket (if any) is currently watching it.
type session struct {
	id   string
	kind string // "run" | "exec" | "code" — selects the orphan TTL
	// ephemeral sessions come from a client that sent no sessionId: they can't be
	// resumed, and a socket disconnect kills them (the pre-durability behaviour),
	// so an un-updated client keeps working exactly as before.
	ephemeral bool

	mu         sync.Mutex
	ring       [][]byte        // buffered outbound frames (bounded; oldest dropped)
	dropped    bool            // ring overflowed — a replay is only the tail
	conn       *websocket.Conn // currently attached socket, nil when detached
	done       bool            // the process has exited
	doneAt     time.Time       // when it exited (drives the linger)
	detachedAt time.Time       // when the last socket left; zero while attached

	cancel context.CancelFunc // cancels the owning process
	// Control hooks set by the process owner and invoked by whichever socket holds
	// the control loop. `input` feeds a prompt (/code) or stdin (/exec); `signal`
	// delivers a POSIX signal (/exec only; nil otherwise).
	input  func(string)
	signal func(string)

	// writeMu serialises socket writes (coder/websocket writes aren't concurrent-
	// safe), held separately from mu so a slow write never blocks buffering.
	writeMu sync.Mutex
}

func (s *session) ttlLocked() time.Duration {
	if s.kind == "code" {
		return sessionTTLCode
	}
	return sessionTTLDefault
}

// emit buffers a frame for replay and, if a socket is attached, writes it live.
// The process owner calls this for every outbound frame; it's safe with no socket
// attached (the frame is simply retained for a later reconnect).
func (s *session) emit(b []byte) {
	s.mu.Lock()
	s.ring = pushFrame(s.ring, b, &s.dropped)
	conn := s.conn
	s.mu.Unlock()
	if conn != nil {
		s.writeMu.Lock()
		_ = conn.Write(context.Background(), websocket.MessageText, b)
		s.writeMu.Unlock()
	}
}

// attach makes conn the live socket and replays the whole buffered tail so a
// (re)connecting client can rebuild its view. Any previously attached socket is
// dropped (latest wins — one watcher at a time avoids double delivery).
func (s *session) attach(conn *websocket.Conn) {
	s.mu.Lock()
	s.conn = conn
	s.detachedAt = time.Time{}
	frames := make([][]byte, len(s.ring))
	copy(frames, s.ring)
	s.mu.Unlock()

	s.writeMu.Lock()
	for _, b := range frames {
		_ = conn.Write(context.Background(), websocket.MessageText, b)
	}
	s.writeMu.Unlock()
}

// detach clears the live socket (only if it's still this one) but leaves the
// process running and buffering — the crux of surviving a disconnect.
func (s *session) detach(conn *websocket.Conn) {
	s.mu.Lock()
	if s.conn == conn {
		s.conn = nil
		s.detachedAt = time.Now()
	}
	s.mu.Unlock()
}

// markDone records that the process exited, starting the linger window, and
// closes the attached socket. Closing on completion matches the pre-durability
// handlers (an un-updated/ephemeral client relies on the server closing when the
// run ends); a durable client has already closed itself on the terminal frame, so
// this is a harmless no-op there, and a later reconnect within the linger window
// still replays the buffered exit frame.
func (s *session) markDone() {
	s.mu.Lock()
	s.done = true
	s.doneAt = time.Now()
	conn := s.conn
	s.mu.Unlock()
	if conn != nil {
		conn.Close(websocket.StatusNormalClosure, "done")
	}
}

func (s *session) setCancel(cancel context.CancelFunc) {
	s.mu.Lock()
	s.cancel = cancel
	s.mu.Unlock()
}

// kill cancels the owning process (SIGKILLs its group via the context). The
// reaper removes the entry once the process is marked done.
func (s *session) kill() {
	s.mu.Lock()
	cancel := s.cancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// pushFrame appends b to a bounded ring, dropping the oldest frame (and flagging
// *dropped) once the cap is reached. Pure and side-effect-free beyond the flag,
// so the ring/overflow behaviour is unit-testable without a socket.
func pushFrame(ring [][]byte, b []byte, dropped *bool) [][]byte {
	if len(ring) >= ringCap {
		ring = ring[1:]
		*dropped = true
	}
	return append(ring, b)
}

// reapDecision decides a session's fate on a reaper sweep at `now`, factored out
// so the TTL/linger policy is testable without goroutines or clocks. `remove`
// drops the entry; `killProc` additionally cancels the process (orphan reap).
func reapDecision(s *session, now time.Time) (remove, killProc bool) {
	if s.done {
		return now.Sub(s.doneAt) > sessionLinger, false
	}
	if s.conn == nil && !s.detachedAt.IsZero() && now.Sub(s.detachedAt) > s.ttlLocked() {
		return true, true
	}
	return false, false
}

// sessionRegistry maps session id → session and reaps finished/orphaned ones.
type sessionRegistry struct {
	mu sync.Mutex
	m  map[string]*session
}

func newSessionRegistry() *sessionRegistry {
	reg := &sessionRegistry{m: map[string]*session{}}
	go reg.reapLoop()
	return reg
}

// get returns the session for id, or nil. Used by a resume-only connect to tell a
// live session (replay) from a reaped/never-existed one (gone).
func (reg *sessionRegistry) get(id string) *session {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	return reg.m[id]
}

// findOrCreate returns the existing session for id (created=false → the caller is
// a reconnect and must NOT start a process), or a fresh one (created=true → the
// caller owns the process).
func (reg *sessionRegistry) findOrCreate(id, kind string) (s *session, created bool) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if existing := reg.m[id]; existing != nil {
		return existing, false
	}
	s = &session{id: id, kind: kind}
	reg.m[id] = s
	return s, true
}

// findOrCreateForRun is findOrCreate for a non-resume connect that carries a fresh
// prompt (a new one-shot run). It differs in one case: an existing session that has
// already FINISHED (kept around only so a resume can replay its result during the
// linger window) is replaced with a fresh one instead of being reused. A new prompt
// reusing an id is a genuinely new run — notably a /chat follow-up threads replies
// through the same card id — and must not be answered with the previous run's
// replayed output. A still-running session is returned as-is (created=false) so a
// duplicate/racing connect attaches rather than starting a second process.
func (reg *sessionRegistry) findOrCreateForRun(id, kind string) (s *session, created bool) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if existing := reg.m[id]; existing != nil {
		existing.mu.Lock()
		done := existing.done
		existing.mu.Unlock()
		if !done {
			return existing, false
		}
		// Finished session lingering for resume — drop it so the new prompt runs.
		delete(reg.m, id)
	}
	s = &session{id: id, kind: kind}
	reg.m[id] = s
	return s, true
}

func (reg *sessionRegistry) remove(id string) {
	reg.mu.Lock()
	delete(reg.m, id)
	reg.mu.Unlock()
}

func (reg *sessionRegistry) reapLoop() {
	t := time.NewTicker(reapInterval)
	defer t.Stop()
	for range t.C {
		reg.sweep(time.Now())
	}
}

// sweep applies reapDecision to every session. Separate from reapLoop so a test
// can drive it with an explicit `now`.
func (reg *sessionRegistry) sweep(now time.Time) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	for id, s := range reg.m {
		s.mu.Lock()
		remove, killProc := reapDecision(s, now)
		cancel := s.cancel
		s.mu.Unlock()
		if killProc && cancel != nil {
			cancel()
		}
		if remove {
			delete(reg.m, id)
		}
	}
}
