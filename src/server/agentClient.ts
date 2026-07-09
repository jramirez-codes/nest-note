/**
 * The /code protocol client: open a persistent, multi-turn Claude Code agent
 * session in a project directory on the paired server and stream its output back
 * live, while sending follow-up prompts or a kill up the same socket. Unlike
 * ./client (a one-shot Claude `run`) the session stays open across turns, so
 * context is kept in one long-lived server process — see server/agent.go.
 *
 * Platform-agnostic like ./client and ./execClient: all pinned networking is
 * delegated to the injected Transport, so this file runs unchanged under Node
 * (proof harness) and RN (the app). It mirrors server/agent.go frame-for-frame.
 */

import type { Transport, SecureSocket } from './transport';
import { type ServerAddress, type SessionOpts, MAX_RECONNECT, reconnectDelayMs } from './client';
import { parseStreamLine, type StreamEvent } from './protocol';

/**
 * One server→client frame off the /code socket (server/agent.go emits these).
 * `cc` wraps a raw `claude` stream-json object under `msg`; `userprompt` echoes a
 * user turn (so it lands in the transcript and replays on reconnect); `exit` marks
 * the session ended; `error` carries a failure message; `gone` says a resume
 * target was already reaped.
 */
interface AgentFrame {
  type?: 'cc' | 'userprompt' | 'exit' | 'error' | 'gone';
  msg?: unknown;
  message?: string;
  text?: string;
}

export interface AgentCallbacks {
  /**
   * A parsed Claude stream event: assistant text/deltas, tool calls, tool
   * results, per-turn result markers. The session emits many of these per turn.
   */
  onEvent: (ev: StreamEvent) => void;
  /** The session ended (Claude exited or the socket closed cleanly). Terminal. */
  onExit: () => void;
  /**
   * The session failed: a server-reported error frame, or a transport/pinning
   * failure. Terminal — no further callbacks follow.
   */
  onError: (message: string) => void;
}

/** How the session ended, for the `done` promise. */
export interface AgentResult {
  error?: string;
}

/** A live agent session: send a new turn up the socket, or await/observe its end. */
export interface AgentHandle {
  /** Send a follow-up prompt as the next user turn in the running session. */
  prompt(text: string): void;
  /** Kill the session and close the socket (server SIGKILLs the whole group). */
  kill(): void;
  /** Settles once the session ends (clean exit, error, or socket close). */
  done: Promise<AgentResult>;
}

function origin(a: ServerAddress): string {
  return `wss://${a.host}:${a.port}`;
}

/**
 * List the existing project directories on the paired server — the names
 * `/code <name>` selects among — so the phone can autocomplete them. Reads over
 * the pinned tunnel (server/agent.go's /projects). Never throws: a disabled
 * /code, an unreachable server, a non-200, or a malformed reply all resolve to
 * an empty list, so the caller treats the result as "the projects to suggest,
 * possibly none".
 */
export async function listProjects(
  t: Transport,
  a: ServerAddress,
  token: string,
): Promise<string[]> {
  try {
    const res = await t.postPinned(`https://${a.host}:${a.port}/projects`, a.pin, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) return [];
    const body = JSON.parse(res.text) as { projects?: unknown };
    if (!Array.isArray(body.projects)) return [];
    return body.projects.filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}

/**
 * Delete the project folder `project` on the paired server — the destructive
 * counterpart to listProjects. POSTs the human name to /projects/delete over the
 * pinned tunnel; the server slugs it the same way it slugs a `/code` target, so
 * whatever the user picked from the autocomplete maps to the right folder.
 * Resolves to `{ ok: true }` on a 200, otherwise `{ ok: false, error }` with a
 * human-readable reason (disabled /code, unknown project, unreachable server) —
 * never throws, so the caller can surface the reason in a dialog.
 */
export async function deleteProject(
  t: Transport,
  a: ServerAddress,
  token: string,
  project: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await t.postPinned(`https://${a.host}:${a.port}/projects/delete`, a.pin, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project }),
    });
    if (res.status === 200) return { ok: true };
    if (res.status === 404) return { ok: false, error: 'That project no longer exists.' };
    if (res.status === 403) {
      return { ok: false, error: 'Deleting projects is disabled on the paired laptop.' };
    }
    return { ok: false, error: `Could not delete the project (HTTP ${res.status}).` };
  } catch {
    return { ok: false, error: 'Could not reach the paired laptop.' };
  }
}

function parseAgentFrame(text: string): AgentFrame | null {
  try {
    return JSON.parse(text) as AgentFrame;
  } catch {
    return null;
  }
}

/**
 * Open a Claude Code session in `project` (created if missing) on the server,
 * optionally kicking it off with `firstPrompt`. Returns immediately with a
 * handle; the socket opens asynchronously. Prompts (or a kill) issued before the
 * socket is up are buffered and flushed on open in order, so no early turn is
 * lost.
 */
export function openAgent(
  t: Transport,
  a: ServerAddress,
  token: string,
  project: string,
  firstPrompt: string | undefined,
  cb: AgentCallbacks,
  session: SessionOpts,
): AgentHandle {
  let sock: SecureSocket | null = null;
  let killed = false;
  let terminated = false; // saw exit / gone — a clean end, no reconnect
  let closed = false;
  let attempt = 0;
  // Outbound frames issued while the socket is down, flushed on (re)open in order.
  const pending: string[] = [];

  let settle!: (r: AgentResult) => void;
  const done = new Promise<AgentResult>(resolve => {
    settle = resolve;
  });

  // Error seen (if any), reported when the session finally ends.
  let errorMsg: string | null = null;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    settle({ error: errorMsg ?? undefined });
  };

  const sendFrame = (frame: object): void => {
    const text = JSON.stringify(frame);
    if (sock) sock.send(text);
    else pending.push(text);
  };

  const reconnect = (): void => {
    if (attempt >= MAX_RECONNECT) {
      errorMsg = 'Lost connection to the session.';
      try {
        cb.onError(errorMsg);
      } catch {
        /* ignore */
      }
      finish();
      return;
    }
    attempt++;
    setTimeout(() => connect(true), reconnectDelayMs(attempt));
  };

  const connect = (resumeOnly: boolean): void => {
    t.openPinnedSocket(`${origin(a)}/code`, a.pin, { Authorization: `Bearer ${token}` })
      .then(s => {
        sock = s;
        if (killed) {
          s.close();
          finish();
          return;
        }

        s.onMessage(text => {
          attempt = 0; // a healthy frame resets the reconnect budget
          const f = parseAgentFrame(text);
          if (!f) return;
          try {
            if (f.type === 'cc') {
              // Re-stringify the wrapped claude object and reuse the shared
              // stream-json parser so /code and the one-shot `run` render alike.
              for (const ev of parseStreamLine(JSON.stringify(f.msg))) cb.onEvent(ev);
            } else if (f.type === 'userprompt') {
              // A user turn echoed by the server, so it replays on reconnect.
              cb.onEvent({ kind: 'user-prompt', text: f.text ?? '' });
            } else if (f.type === 'exit') {
              terminated = true;
              cb.onExit();
              s.close();
            } else if (f.type === 'error') {
              // Not terminal on its own — the server sends error THEN exit.
              errorMsg = f.message || 'The agent session failed on the server.';
              cb.onError(errorMsg);
            } else if (f.type === 'gone') {
              terminated = true;
              errorMsg = 'The session ended and can no longer be resumed.';
              cb.onError(errorMsg);
              s.close();
            }
          } catch {
            // A misbehaving UI callback must not tear down the stream.
          }
        });
        s.onError(() => {}); // surfaced via onClose
        s.onClose(() => {
          sock = null;
          if (killed || terminated) {
            finish();
            return;
          }
          reconnect();
        });

        // (Re)connect handshake: name the session (and, for a fresh start, the
        // project + first prompt). A reconnect resets the consumer's transcript
        // first, since the server replays the whole buffered tail.
        if (resumeOnly) session.onReset?.();
        s.send(
          JSON.stringify({
            sessionId: session.id,
            resumeOnly,
            project,
            prompt: resumeOnly ? '' : firstPrompt ?? '',
          }),
        );
        for (const text of pending) s.send(text);
        pending.length = 0;
      })
      .catch(err => {
        sock = null;
        if (killed || terminated) {
          finish();
          return;
        }
        if (resumeOnly) {
          reconnect();
        } else {
          errorMsg = err instanceof Error ? err.message : String(err);
          try {
            cb.onError(errorMsg);
          } catch {
            /* ignore */
          }
          finish();
        }
      });
  };

  connect(session.resumeOnly ?? false);

  return {
    done,
    prompt(text: string) {
      sendFrame({ type: 'prompt', text });
    },
    kill() {
      killed = true;
      // Ask the server to kill (durable sessions don't die on a mere disconnect),
      // then drop the socket.
      if (sock) {
        sendFrame({ type: 'kill' });
        sock.close();
      }
    },
  };
}
