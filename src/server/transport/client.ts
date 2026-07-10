/**
 * The protocol client: pair for a token, then stream a prompt through Claude.
 * Platform-agnostic — all pinned networking is delegated to an injected
 * Transport (./transport), so this file runs unchanged under Node and RN.
 */

import type { Transport, SecureSocket } from './transport';
import { parseStreamLine, type StreamEvent } from './protocol';

/** The three facts needed to reach a paired server. `pin` guards every connection. */
export interface ServerAddress {
  host: string;
  port: number;
  pin: string;
}

function origin(a: ServerAddress, scheme: 'https' | 'wss'): string {
  return `${scheme}://${a.host}:${a.port}`;
}

/**
 * Durable-session options shared by the three streaming clients (run / exec /
 * code). `id` opts a run into a server-side durable session that survives the
 * socket dropping (background / app-kill); the client then auto-reconnects by id
 * and the server replays the buffered tail. `resumeOnly` opens as a pure resume
 * (never starts a fresh run — the server answers `gone` if it's already reaped).
 * `onReset` fires just before a reconnect replays that tail, so the consumer can
 * clear its stale accumulated view and rebuild cleanly.
 */
export interface SessionOpts {
  id: string;
  resumeOnly?: boolean;
  onReset?: () => void;
}

/** How many times a dropped durable socket retries before giving up. */
export const MAX_RECONNECT = 6;
/** Backoff (ms) for reconnect attempt n: 0.5s, 1s, 2s, 4s, 8s, 8s… */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 8000);
}

/**
 * Redeem a one-time pairing `code` for the long-lived bearer token. The exchange
 * happens inside the pinned tunnel, so the token it returns can't be sniffed;
 * the code is single-use server-side, so a redeemed code can't be replayed.
 */
export async function pair(t: Transport, a: ServerAddress, code: string): Promise<string> {
  const url = `${origin(a, 'https')}/pair?code=${encodeURIComponent(code)}`;
  const res = await t.postPinned(url, a.pin);
  if (res.status !== 200) {
    throw new Error(`pairing failed (HTTP ${res.status}): ${res.text.trim() || 'no body'}`);
  }
  let token: unknown;
  try {
    token = (JSON.parse(res.text) as { token?: unknown }).token;
  } catch {
    throw new Error('pairing response was not JSON');
  }
  if (typeof token !== 'string' || !token) {
    throw new Error('pairing response missing token');
  }
  return token;
}

/**
 * Probe the server's `/health` endpoint over the pinned tunnel. Resolves true
 * only when the server answers 200 through a valid pin — i.e. the paired laptop
 * is reachable right now and still the one we trust. Never throws: a refused
 * connection, a timeout, or a pin mismatch all resolve false, so callers can
 * treat it as a plain reachable/not-reachable signal.
 */
export async function checkHealth(t: Transport, a: ServerAddress): Promise<boolean> {
  try {
    const res = await t.postPinned(`${origin(a, 'https')}/health`, a.pin);
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Outcome of a completed run — the final `result` line's summary. */
export interface RunResult {
  result: string;
  isError: boolean;
}

/** A live run: `done` settles when the stream closes; `cancel` tears it down early. */
export interface RunHandle {
  done: Promise<RunResult>;
  cancel(): void;
}

/**
 * Stream `prompt` through Claude on the server, invoking `onEvent` for each
 * parsed stream line as it arrives. Returns immediately with a handle; the
 * socket is opened asynchronously.
 *
 * With `session`, the run is a durable server session: if the socket drops
 * unexpectedly (background / app-kill) the client reconnects by id and the server
 * replays the buffered tail — `session.onReset` fires first so the consumer clears
 * its stale view. The run ends only on the terminal `result` line, an explicit
 * cancel (which sends kill), or `gone` on a resume of an already-reaped session.
 */
export function run(
  t: Transport,
  a: ServerAddress,
  token: string,
  prompt: string,
  onEvent: (e: StreamEvent) => void,
  session: SessionOpts,
): RunHandle {
  let sock: SecureSocket | null = null;
  let cancelled = false;
  let terminated = false; // saw the result line or `gone` — a clean end
  let settled = false;
  let attempt = 0;
  let final: RunResult = { result: '', isError: false };

  let settle!: (r: RunResult) => void;
  const done = new Promise<RunResult>(resolve => {
    settle = resolve;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    settle(final);
  };

  const url = `${origin(a, 'wss')}/run`;

  const connect = (resumeOnly: boolean) => {
    t.openPinnedSocket(url, a.pin, { Authorization: `Bearer ${token}` })
      .then(s => {
        sock = s;
        if (cancelled) {
          s.close();
          finish();
          return;
        }
        s.onMessage(text => {
          attempt = 0; // a healthy frame resets the reconnect budget
          // Intercept the durable-session `gone` control frame before stream-json
          // parsing (every /run frame is JSON, but none is `type:"gone"`).
          try {
            const o = JSON.parse(text) as { type?: string };
            if (o && o.type === 'gone') {
              terminated = true;
              final = { result: 'The run ended and can no longer be resumed.', isError: true };
              s.close();
              return;
            }
          } catch {
            /* not JSON — fall through to the stream parser */
          }
          for (const ev of parseStreamLine(text)) {
            if (ev.kind === 'result') {
              final = { result: ev.text, isError: ev.isError };
              terminated = true;
            }
            try {
              onEvent(ev);
            } catch {
              // A misbehaving UI callback must not kill the stream.
            }
          }
          if (terminated) s.close();
        });
        s.onError(() => {}); // surfaced via onClose
        s.onClose(() => {
          sock = null;
          if (cancelled || terminated) {
            finish();
            return;
          }
          reconnect();
        });
        // (Re)connect handshake; a reconnect resets the consumer's view first.
        if (resumeOnly) session.onReset?.();
        s.send(JSON.stringify({ sessionId: session.id, resumeOnly, prompt: resumeOnly ? '' : prompt }));
      })
      .catch(err => {
        sock = null;
        if (cancelled || terminated) {
          finish();
          return;
        }
        if (resumeOnly) {
          reconnect();
        } else {
          // The very first connect failed — the run never started.
          final = { result: err instanceof Error ? err.message : String(err), isError: true };
          finish();
        }
      });
  };

  const reconnect = () => {
    if (attempt >= MAX_RECONNECT) {
      final = { result: 'Lost connection to the run.', isError: true };
      finish();
      return;
    }
    attempt++;
    setTimeout(() => connect(true), reconnectDelayMs(attempt));
  };

  connect(session.resumeOnly ?? false);

  return {
    done,
    cancel() {
      cancelled = true;
      // Ask the server to actually kill the run (durable sessions don't die on a
      // mere disconnect), then drop the socket.
      if (sock) {
        try {
          sock.send(JSON.stringify({ type: 'kill' }));
        } catch {
          /* socket already gone */
        }
        sock.close();
      }
    },
  };
}
