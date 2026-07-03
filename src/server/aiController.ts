/**
 * Bridges the editor's inline /ask and /pair commands to the proven client core.
 *
 * A module-level singleton (not a hook) because pairing state is global — one
 * phone, one paired laptop — and the editor lives inside a WebView whose message
 * handler is the natural call site. The heavy lifting (pinned pair exchange,
 * streaming run, stream-json parsing) is all in ./client, already proven against
 * the live server; this only wires it to editor ids and persists the pairing.
 */

import { pair as pairServer, run, type RunHandle } from './client';
import { createNativeTransport, isNativeTransportAvailable } from './nativeTransport';
import { loadServer, saveServer, parsePairInput, type PairedServer } from './store';
import type { Transport } from './transport';

let transport: Transport | null = null;
function getTransport(): Transport | null {
  if (!isNativeTransportAvailable()) return null;
  if (!transport) transport = createNativeTransport();
  return transport;
}

// The paired server, cached after the first load so /ask needn't hit SQLite each
// time. `loaded` distinguishes "not yet read" from "read, and there is none".
let cachedServer: PairedServer | null = null;
let loaded = false;
async function currentServer(): Promise<PairedServer | null> {
  if (!loaded) {
    cachedServer = await loadServer();
    loaded = true;
  }
  return cachedServer;
}

const NO_MODULE =
  'The secure connection module isn’t in this build. Rebuild the app (not just a ' +
  'JS reload) to enable the assistant.';

/** Redeem a pasted pairing payload for a token and remember the server. */
export async function pairFromPayload(text: string): Promise<{ ok: boolean; msg: string }> {
  const t = getTransport();
  if (!t) return { ok: false, msg: NO_MODULE };

  const payload = parsePairInput(text);
  if (!payload) {
    return { ok: false, msg: 'That isn’t a valid pairing payload.' };
  }
  try {
    const address = { host: payload.host, port: payload.port, pin: payload.pin };
    const token = await pairServer(t, address, payload.code);
    cachedServer = { ...address, token };
    loaded = true;
    await saveServer(cachedServer);
    return { ok: true, msg: `Connected to ${payload.host}:${payload.port}` };
  } catch (e) {
    return { ok: false, msg: e instanceof Error ? e.message : String(e) };
  }
}

export interface AskCallbacks {
  /** Called with the full answer-so-far on every streamed chunk. */
  onDelta: (answer: string) => void;
  /** Called once with the final answer text when the run completes cleanly. */
  onDone: (answer: string) => void;
  /** Called on failure, with any partial answer streamed before the error. */
  onError: (msg: string, partial: string) => void;
}

export interface AskHandle {
  cancel(): void;
}

/** A prior card's question/answer, threaded into a follow-up so it has context. */
export interface AskContext {
  q?: string;
  a?: string;
}

// Each run is a fresh `claude -p` (no server-side session), so a follow-up must
// carry its own context: fold the parent Q&A into the prompt Claude receives.
// The card still shows only the raw follow-up question.
function buildPrompt(question: string, context?: AskContext): string {
  if (!context || !context.q) return question;
  return (
    `You are continuing a conversation. Earlier you were asked:\n\n${context.q}\n\n` +
    (context.a ? `You answered:\n\n${context.a}\n\n` : '') +
    `Now answer this follow-up:\n\n${question}`
  );
}

/**
 * Stream an answer for `question`. Returns immediately; callbacks fire as the
 * answer arrives. Cancelling stops the underlying run (which disconnects the
 * socket, killing the server-side Claude process). `context`, when present,
 * threads a prior card's Q&A into the prompt so follow-ups stay in-conversation.
 */
export function runAsk(question: string, cb: AskCallbacks, context?: AskContext): AskHandle {
  let cancelled = false;
  let handle: RunHandle | null = null;
  let answer = '';

  (async () => {
    const t = getTransport();
    if (!t) {
      cb.onError(NO_MODULE, '');
      return;
    }
    const server = await currentServer();
    if (!server) {
      cb.onError('Not connected. Pair first with “/pair <payload>”.', '');
      return;
    }
    if (cancelled) return;

    handle = run(t, server, server.token, buildPrompt(question, context), ev => {
      if (ev.kind === 'assistant-text') {
        answer += ev.text;
        cb.onDelta(answer);
      }
    });

    try {
      const res = await handle.done;
      if (cancelled) return;
      if (res.isError) cb.onError(res.result || 'The run failed.', answer);
      else cb.onDone(answer || res.result);
    } catch (e) {
      if (cancelled) return;
      cb.onError(e instanceof Error ? e.message : String(e), answer);
    }
  })();

  return {
    cancel() {
      cancelled = true;
      handle?.cancel();
    },
  };
}
