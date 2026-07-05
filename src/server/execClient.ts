/**
 * The /exec protocol client: run a raw shell command on the paired server and
 * stream its stdout/stderr back live, while sending stdin, an interrupt, or a
 * kill up the same socket. This is the direct `/run <cmd>` terminal channel — no
 * Claude involved (see ./client for the Claude `run`).
 *
 * Platform-agnostic like ./client: all pinned networking is delegated to the
 * injected Transport, so this file runs unchanged under Node (proof harness) and
 * RN (the app). It mirrors the Go handler in server/exec.go frame-for-frame.
 */

import type { Transport, SecureSocket } from './transport';
import { type ServerAddress, type SessionOpts, MAX_RECONNECT, reconnectDelayMs } from './client';

/** One server→client frame off the /exec socket (server/exec.go emits these). */
interface ExecFrame {
  type?: 'log' | 'exit' | 'error' | 'gone';
  stream?: 'stdout' | 'stderr';
  data?: string;
  code?: number;
  message?: string;
}

export interface ExecCallbacks {
  /** A chunk of live output, tagged with which stream it came from. */
  onLog: (stream: 'stdout' | 'stderr', data: string) => void;
  /** The command exited on its own; `code` is its exit status (-1 if signalled). */
  onExit: (code: number) => void;
  /**
   * The run failed: a server-reported error frame, or a transport/pinning
   * failure. Terminal — no further callbacks follow.
   */
  onError: (message: string) => void;
}

/** How the run ended, for the `done` promise. `code` is null if it errored out. */
export interface ExecResult {
  code: number | null;
  error?: string;
}

/** A live exec session: send input up the socket, or await/observe its end. */
export interface ExecHandle {
  /** Write to the running process's stdin. */
  sendStdin(data: string): void;
  /** Send an interrupt to the process group (default SIGINT — the wire Ctrl-C). */
  signal(sig?: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void;
  /** Kill the run and close the socket (the server SIGKILLs the whole group). */
  kill(): void;
  /** Settles once the session ends (clean exit, error, or socket close). */
  done: Promise<ExecResult>;
}

function origin(a: ServerAddress): string {
  return `wss://${a.host}:${a.port}`;
}

function parseExecFrame(text: string): ExecFrame | null {
  try {
    return JSON.parse(text) as ExecFrame;
  } catch {
    return null;
  }
}

/**
 * Start `cmd` on the server (optionally under project subdir `dir`) and stream it
 * live. Returns immediately with a handle; the socket opens asynchronously. Input
 * sent before the socket is up is buffered and flushed on open, so no early
 * keystroke or an eager kill is lost.
 */
export function exec(
  t: Transport,
  a: ServerAddress,
  token: string,
  cmd: string,
  dir: string | undefined,
  cb: ExecCallbacks,
  session: SessionOpts,
): ExecHandle {
  let sock: SecureSocket | null = null;
  let killed = false;
  let terminated = false; // saw exit / gone — a clean end, no reconnect
  let closed = false;
  let attempt = 0;
  // Outbound frames issued while the socket is down, flushed on (re)open in order.
  const pending: string[] = [];

  let settle!: (r: ExecResult) => void;
  const done = new Promise<ExecResult>(resolve => {
    settle = resolve;
  });

  // Last exit code / error seen, reported when the session finally ends.
  let exitCode: number | null = null;
  let errorMsg: string | null = null;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    settle({ code: exitCode, error: errorMsg ?? undefined });
  };

  const sendFrame = (frame: object): void => {
    const text = JSON.stringify(frame);
    if (sock) sock.send(text);
    else pending.push(text);
  };

  const reconnect = (): void => {
    if (attempt >= MAX_RECONNECT) {
      errorMsg = 'Lost connection to the command.';
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
    t.openPinnedSocket(`${origin(a)}/exec`, a.pin, { Authorization: `Bearer ${token}` })
      .then(s => {
        sock = s;
        if (killed) {
          s.close();
          finish();
          return;
        }

        s.onMessage(text => {
          attempt = 0; // a healthy frame resets the reconnect budget
          const f = parseExecFrame(text);
          if (!f) return;
          try {
            if (f.type === 'log' && f.data) {
              cb.onLog(f.stream === 'stderr' ? 'stderr' : 'stdout', f.data);
            } else if (f.type === 'exit') {
              exitCode = typeof f.code === 'number' ? f.code : -1;
              terminated = true;
              cb.onExit(exitCode);
              s.close();
            } else if (f.type === 'error') {
              errorMsg = f.message || 'The command failed on the server.';
              cb.onError(errorMsg);
            } else if (f.type === 'gone') {
              terminated = true;
              errorMsg = 'The command ended and can no longer be resumed.';
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
        // command). A reconnect resets the consumer's view first, since the server
        // replays the whole buffered tail.
        if (resumeOnly) session.onReset?.();
        s.send(
          JSON.stringify({ sessionId: session.id, resumeOnly, cmd: resumeOnly ? '' : cmd, dir: dir ?? '' }),
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
    sendStdin(data: string) {
      sendFrame({ type: 'stdin', data });
    },
    signal(sig: 'SIGINT' | 'SIGTERM' | 'SIGKILL' = 'SIGINT') {
      sendFrame({ type: 'signal', sig });
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
