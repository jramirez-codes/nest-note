/**
 * The protocol client: pair for a token, then stream a prompt through Claude.
 * Platform-agnostic — all pinned networking is delegated to an injected
 * Transport (./transport), so this file runs unchanged under Node and RN.
 */

import type { Transport } from './transport';
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
 * socket is opened asynchronously. Cancelling closes the socket, which the
 * server treats as a disconnect and uses to kill the Claude subprocess.
 */
export function run(
  t: Transport,
  a: ServerAddress,
  token: string,
  prompt: string,
  onEvent: (e: StreamEvent) => void,
): RunHandle {
  let socketClose: (() => void) | null = null;
  let cancelled = false;

  let settle!: (r: RunResult) => void;
  let fail!: (e: Error) => void;
  const done = new Promise<RunResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const url = `${origin(a, 'wss')}/run`;
  t.openPinnedSocket(url, a.pin, { Authorization: `Bearer ${token}` })
    .then(sock => {
      socketClose = () => sock.close();
      if (cancelled) {
        sock.close();
        fail(new Error('run cancelled'));
        return;
      }

      let final: RunResult = { result: '', isError: false };
      let closed = false;

      sock.onMessage(text => {
        for (const ev of parseStreamLine(text)) {
          if (ev.kind === 'result') {
            final = { result: ev.text, isError: ev.isError };
          }
          try {
            onEvent(ev);
          } catch {
            // A misbehaving UI callback must not kill the stream.
          }
        }
      });
      sock.onError(err => {
        if (closed) return;
        closed = true;
        fail(err);
      });
      sock.onClose(() => {
        if (closed) return;
        closed = true;
        settle(final);
      });

      sock.send(JSON.stringify({ prompt }));
    })
    .catch(err => fail(err instanceof Error ? err : new Error(String(err))));

  return {
    done,
    cancel() {
      cancelled = true;
      socketClose?.();
    },
  };
}
