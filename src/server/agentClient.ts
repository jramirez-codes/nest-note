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
import type { ServerAddress } from './client';
import { parseStreamLine, type StreamEvent } from './protocol';

/**
 * One server→client frame off the /code socket (server/agent.go emits these).
 * `cc` wraps a raw `claude` stream-json object under `msg`; `exit` marks the
 * session ended; `error` carries a terminal failure message.
 */
interface AgentFrame {
  type?: 'cc' | 'exit' | 'error';
  msg?: unknown;
  message?: string;
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
): AgentHandle {
  let sock: SecureSocket | null = null;
  let killed = false;
  let closed = false;
  // Outbound frames issued before the socket is open, flushed on open in order.
  const pending: string[] = [];

  let settle!: (r: AgentResult) => void;
  const done = new Promise<AgentResult>(resolve => {
    settle = resolve;
  });

  // Error seen (if any), reported when the socket finally closes.
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

  t.openPinnedSocket(`${origin(a)}/code`, a.pin, { Authorization: `Bearer ${token}` })
    .then(s => {
      sock = s;
      if (killed) {
        s.close();
        finish();
        return;
      }

      s.onMessage(text => {
        const f = parseAgentFrame(text);
        if (!f) return;
        try {
          if (f.type === 'cc') {
            // Re-stringify the wrapped claude object and reuse the shared
            // stream-json parser so /code and the one-shot `run` render identically.
            for (const ev of parseStreamLine(JSON.stringify(f.msg))) cb.onEvent(ev);
          } else if (f.type === 'exit') {
            cb.onExit();
          } else if (f.type === 'error') {
            errorMsg = f.message || 'The agent session failed on the server.';
            cb.onError(errorMsg);
          }
        } catch {
          // A misbehaving UI callback must not tear down the stream.
        }
      });
      s.onError(err => {
        if (closed) return;
        errorMsg = err.message;
        try {
          cb.onError(err.message);
        } catch {
          /* ignore */
        }
        finish();
      });
      s.onClose(() => finish());

      // First frame names the project (and an optional first prompt); then flush
      // any turns the user queued during the connect window.
      s.send(JSON.stringify({ project, prompt: firstPrompt ?? '' }));
      for (const text of pending) s.send(text);
      pending.length = 0;
    })
    .catch(err => {
      errorMsg = err instanceof Error ? err.message : String(err);
      try {
        cb.onError(errorMsg);
      } catch {
        /* ignore */
      }
      finish();
    });

  return {
    done,
    prompt(text: string) {
      sendFrame({ type: 'prompt', text });
    },
    kill() {
      killed = true;
      // Ask the server to kill (in case the close race loses), then drop the socket.
      if (sock) {
        sendFrame({ type: 'kill' });
        sock.close();
      }
    },
  };
}
