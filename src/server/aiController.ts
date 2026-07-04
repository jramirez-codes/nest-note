/**
 * Bridges the editor's inline /ask and /pair commands to the proven client core.
 *
 * A module-level singleton (not a hook) because pairing state is global — one
 * phone, one paired laptop — and the editor lives inside a WebView whose message
 * handler is the natural call site. The heavy lifting (pinned pair exchange,
 * streaming run, stream-json parsing) is all in ./client, already proven against
 * the live server; this only wires it to editor ids and persists the pairing.
 */

import { pair as pairServer, run, checkHealth, type RunHandle } from './client';
import { createNativeTransport, isNativeTransportAvailable } from './nativeTransport';
import { loadServer, saveServer, parsePairInput, type PairedServer } from './store';
import { setServerStatus } from './status';
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

/**
 * Probe whether the paired server is reachable right now and publish the result
 * to the shared status store (which the header bubble subscribes to). Returns
 * false — and marks 'disconnected' — when the secure module is missing or no
 * server is paired, so "can't reach it" and "nothing to reach" read the same to
 * the user. Safe to call on a timer.
 */
export async function pingServer(): Promise<boolean> {
  const t = getTransport();
  const server = t ? await currentServer() : null;
  if (!t || !server) {
    setServerStatus('disconnected');
    return false;
  }
  setServerStatus('checking');
  const ok = await checkHealth(t, server);
  setServerStatus(ok ? 'connected' : 'disconnected');
  return ok;
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
    // A successful pair exchange means we just reached the server over the pin.
    setServerStatus('connected');
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

/**
 * Context threaded into a follow-up so a fresh run answers in-conversation.
 * `turns` carries a whole /chat transcript (each `{ q, a }` an earlier exchange);
 * `q`/`a` is the single-turn form still accepted for one-off follow-ups.
 */
export interface AskContext {
  q?: string;
  a?: string;
  turns?: { q?: string; a?: string }[];
}

// Each run is a fresh `claude -p` (no server-side session), so a follow-up must
// carry its own context: fold the prior exchange(s) into the prompt Claude
// receives. The card still shows only the raw follow-up question.
function buildPrompt(question: string, context?: AskContext): string {
  const turns = context?.turns?.filter(t => t.q);
  if (turns && turns.length) {
    const history = turns
      .map(t => `User: ${t.q}\n\nAssistant: ${t.a || ''}`)
      .join('\n\n');
    return (
      `You are continuing a conversation. Here is the conversation so far:\n\n` +
      `${history}\n\n` +
      `Now answer this follow-up:\n\n${question}`
    );
  }
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
  // `answer` holds committed turns; `streaming` holds the live token buffer for
  // the turn currently arriving. Deltas grow `streaming`; the turn's closing
  // full-text snapshot commits into `answer` and resets `streaming`, so the two
  // sources never double-count. onDone/onError report `answer` (+ any tail).
  let answer = '';
  let streaming = '';

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
      // Any event off the socket proves the server is live right now.
      setServerStatus('connected');
      if (ev.kind === 'assistant-delta') {
        // A freshly generated token: grow the live buffer and show it typing out.
        streaming += ev.text;
        cb.onDelta(answer + streaming);
      } else if (ev.kind === 'assistant-text') {
        // The turn's authoritative full text landed; commit it and drop the
        // delta buffer that built it so the answer doesn't double. (When the CLI
        // isn't streaming partials, this is the only event and still works.)
        answer += ev.text;
        streaming = '';
        cb.onDelta(answer);
      }
    });

    try {
      const res = await handle.done;
      if (cancelled) return;
      const partial = answer + streaming;
      if (res.isError) cb.onError(res.result || 'The run failed.', partial);
      else cb.onDone(partial || res.result);
    } catch (e) {
      if (cancelled) return;
      // The run never reached (or lost) the server — reflect that in the bubble.
      setServerStatus('disconnected');
      cb.onError(e instanceof Error ? e.message : String(e), answer + streaming);
    }
  })();

  return {
    cancel() {
      cancelled = true;
      handle?.cancel();
    },
  };
}

export interface CleanCallbacks {
  /**
   * Called once when the run completes cleanly with the cleaned page text and,
   * when a title was requested and produced, a short generated title ('' if none).
   */
  onDone: (cleaned: string, title: string) => void;
  /** Called on failure with a message; the original page text is left untouched. */
  onError: (msg: string) => void;
}

// Frame the page as a rewrite task. `guidance` (from `/clean project ideas`)
// steers how the notes get organized; empty means "just tidy them up". When
// `needTitle`, the reply is prefixed with a `TITLE:` line we parse back out.
function buildCleanPrompt(pageText: string, guidance: string, needTitle: boolean): string {
  const g = guidance.trim();
  const titleLine = needTitle
    ? 'Start your reply with a single line of the form `TITLE: <title>`, where ' +
      '<title> is a short 3–6 word plain-text title for these notes (no markdown, ' +
      'no quotes). Follow it with one blank line, then the cleaned notes.\n\n'
    : 'Return only the cleaned notes.\n\n';
  return (
    'You are a note-cleaning assistant. Rewrite the notes below into a cleaner, ' +
    'better-organized version. Preserve every piece of information and its meaning; ' +
    'fix grammar, spelling and structure; use Markdown headings, lists and task ' +
    'checkboxes where they make the notes clearer. Do not invent facts or add ' +
    'commentary.' +
    (g ? ` Organize the notes around: ${g}.` : '') +
    '\n\n' +
    titleLine +
    'Do not wrap your output in a code fence.\n\n<notes>\n' +
    pageText +
    '\n</notes>'
  );
}

// Claude occasionally wraps the whole reply in a ``` fence despite the prompt;
// unwrap a fence that spans the entire answer so it doesn't land in the note.
function stripFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/.exec(t);
  return m ? m[1].trim() : t;
}

// Tidy a raw title line into a plain, single-line, unquoted, capped title.
function cleanTitle(raw: string): string {
  let t = raw.replace(/[\r\n]+/g, ' ').trim();
  t = t.replace(/^#+\s*/, ''); // stray heading marker
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim(); // surrounding quotes
  return t.length > 60 ? t.slice(0, 60).trim() : t;
}

// Split off a leading `TITLE: …` line if present. Always stripped (even when a
// title wasn't requested) so a stray one can never leak into the note body.
function splitTitle(text: string): { title: string; body: string } {
  // Title is the rest of the first line; body is everything after it (possibly
  // empty — a title-only reply then yields no notes and is treated as a failure).
  const m = /^﻿?[ \t]*TITLE:[ \t]*([^\r\n]*)([\s\S]*)$/.exec(text);
  return m ? { title: cleanTitle(m[1]), body: m[2] } : { title: '', body: text };
}

/**
 * Rewrite `pageText` into a cleaned-up version, streamed on the same proven path
 * as {@link runAsk}. The card shows a spinner (not the stream), so only the
 * final text matters: it's handed to onDone once and the editor swaps it in
 * behind an Accept/Reject bar. When `needTitle`, the same call also produces a
 * short title (the page has none yet). Cancelling tears down the underlying run.
 */
export function runClean(
  pageText: string,
  guidance: string,
  needTitle: boolean,
  cb: CleanCallbacks,
): AskHandle {
  return runAsk(buildCleanPrompt(pageText, guidance, needTitle), {
    onDelta: () => {},
    onDone: answer => {
      const { title, body } = splitTitle(answer.trim());
      const cleaned = stripFence(body);
      // An empty rewrite would blank the note — treat it as a failure so the
      // original page text is left untouched.
      if (cleaned) cb.onDone(cleaned, needTitle ? title : '');
      else cb.onError('Cleanup returned nothing.');
    },
    // Leave the page as-is on failure; the card shows the error, notes are safe.
    onError: msg => cb.onError(msg),
  });
}

export interface IngestCallbacks {
  /** The run finished cleanly; `summary` is Claude's one-line report of what it filed. */
  onDone: (summary: string) => void;
  /** The run failed; the page must be left intact and the error shown. */
  onError: (msg: string) => void;
}

// Frame the page as a sorting task for the orchestrator MCP. Claude reads the
// existing subject servers, groups the page by topic, and files each group with
// `ingest_topic` (which creates a subject's notes store on first use). The server
// always appends its own orchestration routine, so this only has to describe the
// ingest job. We deliberately forbid questions: /ingest is fire-and-forget, and
// any genuine ambiguity becomes an optional `suggest_merge` the dashboard surfaces.
function buildIngestPrompt(pageText: string): string {
  return (
    'You are sorting a page of notes into a personal knowledge base made of ' +
    'per-subject "notes servers", managed by the orchestrator MCP.\n\n' +
    'Do exactly this, without asking the user anything:\n' +
    '1. Call list_capabilities to see which subject servers already exist.\n' +
    '2. Group the notes below by subject/topic. Reuse an existing subject slug ' +
    'whenever a note fits one; otherwise choose a short lowercase slug for a new ' +
    'subject.\n' +
    '3. For each subject, call ingest_topic(subject, summary, notes) with that ' +
    "subject's notes (lightly cleaned for grammar). Preserve every fact; invent " +
    'nothing; file every note into exactly one subject.\n' +
    '4. Only if two EXISTING subjects clearly duplicate each other may you call ' +
    'suggest_merge. Never merge on your own.\n' +
    '5. Also surface anything actionable or time-sensitive as a dashboard card ' +
    '(call list_cards first to avoid duplicates): use upsert_card with kind="task" ' +
    'for things the user needs to do (attach a date when a due date is stated) and ' +
    'kind="notification" for dated or important upcoming events/deadlines/reminders. ' +
    'Set priority (urgent | high | normal | low) as an honest urgency judgment, and ' +
    'set source to the subject slug the card came from. Only make cards for genuine ' +
    'tasks/events — not for every note.\n\n' +
    'When finished, reply with a single short line summarizing what you filed and ' +
    'where. Do not ask questions.\n\n<notes>\n' +
    pageText +
    '\n</notes>'
  );
}

/**
 * Sort `pageText` into the orchestrator's subject servers. Runs on the same proven
 * stream path as {@link runAsk} but only cares about completion: on success the
 * caller deletes the page (the notes now live in the dashboard); on failure the
 * page is left untouched. Cancelling tears down the underlying run.
 */
export function runIngest(pageText: string, cb: IngestCallbacks): AskHandle {
  return runAsk(buildIngestPrompt(pageText), {
    onDelta: () => {},
    onDone: answer => cb.onDone(answer.trim()),
    onError: msg => cb.onError(msg),
  });
}

// --- Dashboard state (read) + optional merge actions (write) -----------------
// Both talk to the Go server's /state and /action endpoints over the same pinned
// tunnel /ask uses, authenticated with the paired bearer token. They never spin up
// Claude — the server answers straight from the scaffold's files.

export interface DashboardServer {
  name: string;
  summary: string;
  tools: string[];
  /** The full markdown of this subject's notes. */
  notes: string;
}

export interface DashboardSuggestion {
  into: string;
  from: string[];
  reason: string;
}

/** Priority ranks, high→low, so the UI can sort without hard-coding the strings. */
export type CardPriority = 'urgent' | 'high' | 'normal' | 'low';

/**
 * One dashboard card, straight off the wire. Deliberately flat and kind-agnostic:
 * `kind` selects a renderer (with a generic fallback for unknown kinds), so Claude
 * can emit a new kind and it shows up with zero new code. `payload` is opaque
 * kind-specific extras a bespoke renderer may read later.
 */
export interface DashboardCard {
  id: string;
  kind: string;
  priority: CardPriority;
  /** Optional ISO date: a task's due date or a notification's event date. */
  date?: string;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  done?: boolean;
  dismissed?: boolean;
  source?: string;
  created_at?: string;
  updated_at?: string;
}

export interface DashboardState {
  servers: DashboardServer[];
  suggestions: DashboardSuggestion[];
  cards: DashboardCard[];
}

function serverOrigin(s: PairedServer): string {
  return `https://${s.host}:${s.port}`;
}

/** Fetch the dashboard's view of the MCP world (servers, their notes, suggestions). */
export async function fetchDashboardState(): Promise<DashboardState> {
  const t = getTransport();
  if (!t) throw new Error(NO_MODULE);
  const server = await currentServer();
  if (!server) throw new Error('Not connected. Pair first with “/pair <payload>”.');

  const res = await t.postPinned(`${serverOrigin(server)}/state`, server.pin, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  if (res.status === 404) {
    throw new Error('This companion server has no dashboard (started without -root).');
  }
  if (res.status !== 200) {
    setServerStatus('disconnected');
    throw new Error(`Dashboard unavailable (HTTP ${res.status}).`);
  }
  // Any answer off the socket proves the server is live right now.
  setServerStatus('connected');
  const data = JSON.parse(res.text) as Partial<DashboardState>;
  return {
    servers: Array.isArray(data.servers) ? data.servers : [],
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
    cards: Array.isArray(data.cards) ? data.cards : [],
  };
}

// postAction is the shared POST /action path: same pinned tunnel, bearer token, and
// 200-or-throw contract every dashboard write uses. Callers pass the verb-specific
// body (suggestion merges key on `into`, card actions on `id`).
async function postAction(body: Record<string, unknown>): Promise<void> {
  const t = getTransport();
  if (!t) throw new Error(NO_MODULE);
  const server = await currentServer();
  if (!server) throw new Error('Not connected.');

  const res = await t.postPinned(`${serverOrigin(server)}/action`, server.pin, {
    headers: {
      Authorization: `Bearer ${server.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`Action failed (HTTP ${res.status}).`);
}

/** Approve ('merge') or 'dismiss' an optional merge suggestion from the dashboard. */
export async function applyDashboardAction(action: {
  action: 'merge' | 'dismiss';
  into: string;
  from?: string[];
}): Promise<void> {
  return postAction(action);
}

/** Toggle a task card's done state (`done` chooses complete vs. uncomplete). */
export async function completeCard(id: string, done: boolean): Promise<void> {
  return postAction({ action: done ? 'complete' : 'uncomplete', id });
}

/** Dismiss a card so it stops showing in the dashboard. */
export async function dismissCard(id: string): Promise<void> {
  return postAction({ action: 'dismiss', id });
}
