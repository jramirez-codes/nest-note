// Package session owns the durable runs behind every streaming endpoint (/run,
// /exec, /code, and scheduled builds). A Session decouples a run's process from
// the socket watching it, so the process survives a disconnect and a reconnecting
// client replays the buffered tail.
//
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
package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// The session kinds. Kind selects the orphan TTL and nothing else.
const (
	KindRun  = "run"
	KindExec = "exec"
	KindCode = "code"
	// KindBuild marks a scheduled build's run. It is a distinct kind purely for
	// its orphan TTL: see ttlBuild.
	KindBuild = "build"
)

const (
	ttlDefault = 30 * time.Minute
	ttlCode    = 10 * time.Minute
	// A scheduled build run has no watcher by design — nobody is holding a socket
	// open at 3am — so the orphan TTL that protects an idle /code session would
	// instead kill the very runs this exists to perform. Its real ceiling is the
	// -run-timeout the process itself carries; this only has to outlast that, and
	// a finished session is still swept promptly by the linger rule above.
	ttlBuild = 24 * time.Hour
	// Keep a finished session briefly so a client reconnecting right as it ends
	// still replays the terminal (exit/result) frame instead of getting `gone`.
	linger = 60 * time.Second
	// Max frames retained for replay. Enough for a long /code transcript's tail;
	// older frames drop (and set `dropped`) rather than growing without bound.
	ringCap = 4096
	// How often the reaper sweeps for finished/orphaned sessions.
	reapInterval = 30 * time.Second
)

// RandomID mints an id for an ephemeral (non-durable) session — used when a
// client connects without a sessionId, so it can't be resumed and is keyed
// uniquely for the lifetime of its one socket.
func RandomID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return "eph-" + hex.EncodeToString(b[:])
}

// MustJSON marshals a frame, discarding the (impossible for these maps) error.
func MustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// WriteGone tells a resume-only client that the session it asked for is gone
// (reaped or never existed) and closes, so the client finalizes the card as
// interrupted rather than accidentally opening a fresh run.
func WriteGone(c *websocket.Conn) {
	_ = c.Write(context.Background(), websocket.MessageText, MustJSON(map[string]any{"type": "gone"}))
	c.Close(websocket.StatusNormalClosure, "gone")
}

// Session owns one durable run: its process (via cancel), the buffered frames for
// replay, and whichever socket (if any) is currently watching it.
//
// Every field is unexported and reached through methods: the process owner lives
// in another package (run, exec, agent, build) and must not have to know which
// mutex guards what.
type Session struct {
	id   string
	kind string // selects the orphan TTL
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

// ID is the session's registry key.
func (s *Session) ID() string { return s.id }

// SetEphemeral marks a session as un-resumable, so its socket closing kills it.
func (s *Session) SetEphemeral(v bool) {
	s.mu.Lock()
	s.ephemeral = v
	s.mu.Unlock()
}

// Ephemeral reports whether a socket disconnect should kill this session.
func (s *Session) Ephemeral() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ephemeral
}

func (s *Session) ttlLocked() time.Duration {
	switch s.kind {
	case KindCode:
		return ttlCode
	case KindBuild:
		return ttlBuild
	}
	return ttlDefault
}

// Running reports whether the owning process is still going. The build tick uses
// it to tell "a feature run is in flight" from "the run ended and the session is
// only lingering so a late reconnect can replay its result".
func (s *Session) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.done
}

// Emit buffers a frame for replay and, if a socket is attached, writes it live.
// The process owner calls this for every outbound frame; it's safe with no socket
// attached (the frame is simply retained for a later reconnect).
func (s *Session) Emit(b []byte) {
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

// Attach makes conn the live socket and replays the whole buffered tail so a
// (re)connecting client can rebuild its view. Any previously attached socket is
// dropped (latest wins — one watcher at a time avoids double delivery).
func (s *Session) Attach(conn *websocket.Conn) {
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

// Detach clears the live socket (only if it's still this one) but leaves the
// process running and buffering — the crux of surviving a disconnect.
func (s *Session) Detach(conn *websocket.Conn) {
	s.mu.Lock()
	if s.conn == conn {
		s.conn = nil
		s.detachedAt = time.Now()
	}
	s.mu.Unlock()
}

// MarkDone records that the process exited, starting the linger window, and
// closes the attached socket. Closing on completion matches the pre-durability
// handlers (an un-updated/ephemeral client relies on the server closing when the
// run ends); a durable client has already closed itself on the terminal frame, so
// this is a harmless no-op there, and a later reconnect within the linger window
// still replays the buffered exit frame.
func (s *Session) MarkDone() {
	s.mu.Lock()
	s.done = true
	s.doneAt = time.Now()
	conn := s.conn
	s.mu.Unlock()
	if conn != nil {
		conn.Close(websocket.StatusNormalClosure, "done")
	}
}

func (s *Session) SetCancel(cancel context.CancelFunc) {
	s.mu.Lock()
	s.cancel = cancel
	s.mu.Unlock()
}

// Kill cancels the owning process (SIGKILLs its group via the context). The
// reaper removes the entry once the process is marked done.
func (s *Session) Kill() {
	s.mu.Lock()
	cancel := s.cancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// SetHooks installs the control hooks the socket's control loop invokes. signal
// may be nil for kinds that don't accept one (everything but /exec).
func (s *Session) SetHooks(input, signal func(string)) {
	s.mu.Lock()
	s.input, s.signal = input, signal
	s.mu.Unlock()
}

// Hooks returns the currently installed control hooks. Either may be nil.
func (s *Session) Hooks() (input, signal func(string)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.input, s.signal
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
func reapDecision(s *Session, now time.Time) (remove, killProc bool) {
	if s.done {
		return now.Sub(s.doneAt) > linger, false
	}
	if s.conn == nil && !s.detachedAt.IsZero() && now.Sub(s.detachedAt) > s.ttlLocked() {
		return true, true
	}
	return false, false
}

// Registry maps session id → Session and reaps finished/orphaned ones.
type Registry struct {
	mu sync.Mutex
	m  map[string]*Session
}

func NewRegistry() *Registry {
	reg := &Registry{m: map[string]*Session{}}
	go reg.reapLoop()
	return reg
}

// Get returns the session for id, or nil. Used by a resume-only connect to tell a
// live session (replay) from a reaped/never-existed one (gone).
func (reg *Registry) Get(id string) *Session {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	return reg.m[id]
}

// FindOrCreate returns the existing session for id (created=false → the caller is
// a reconnect and must NOT start a process), or a fresh one (created=true → the
// caller owns the process).
func (reg *Registry) FindOrCreate(id, kind string) (s *Session, created bool) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if existing := reg.m[id]; existing != nil {
		return existing, false
	}
	s = &Session{id: id, kind: kind}
	reg.m[id] = s
	return s, true
}

// FindOrCreateForRun is FindOrCreate for a non-resume connect that carries a fresh
// prompt (a new one-shot run). It differs in one case: an existing session that has
// already FINISHED (kept around only so a resume can replay its result during the
// linger window) is replaced with a fresh one instead of being reused. A new prompt
// reusing an id is a genuinely new run — notably a /chat follow-up threads replies
// through the same card id — and must not be answered with the previous run's
// replayed output. A still-running session is returned as-is (created=false) so a
// duplicate/racing connect attaches rather than starting a second process.
func (reg *Registry) FindOrCreateForRun(id, kind string) (s *Session, created bool) {
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
	s = &Session{id: id, kind: kind}
	reg.m[id] = s
	return s, true
}

func (reg *Registry) Remove(id string) {
	reg.mu.Lock()
	delete(reg.m, id)
	reg.mu.Unlock()
}

func (reg *Registry) reapLoop() {
	t := time.NewTicker(reapInterval)
	defer t.Stop()
	for range t.C {
		reg.Sweep(time.Now())
	}
}

// Sweep applies reapDecision to every session. Separate from reapLoop so a test
// can drive it with an explicit `now`.
func (reg *Registry) Sweep(now time.Time) {
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
