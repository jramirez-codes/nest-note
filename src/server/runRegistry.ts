/**
 * App-level registry of live AI runs, so a run outlives the note page that
 * started it.
 *
 * The problem it solves: every /ask, /clean, /ingest, /run and /code run used to
 * be owned by the per-page NoteEditorWebView in useRef maps, and cancelled on
 * unmount. But PaperPager unmounts a page the moment you swipe away from it (and
 * swapping notebooks tears the whole editor down), so navigating away killed the
 * run — and the socket close killed the laptop-side process with it.
 *
 * This module hoists that ownership to a single long-lived singleton (the same
 * pattern aiController uses for the transport/server singletons). A run is keyed
 * by its card id — the same id the RN↔WebView bridge already correlates on — and
 * keeps streaming into an in-memory buffer whether or not any WebView is watching.
 * A component "attaches" a sink (its inject bridge + page-coupled callbacks) while
 * mounted and "detaches" on unmount WITHOUT cancelling; a freshly-mounted page
 * re-attaches by id and is repainted from the buffer, then rides the live stream
 * to completion. Only an explicit user Stop/× (or a terminal result) ends a run.
 */

import { runAsk, runClean, runIngest, type AskContext } from './aiController';
import { runCommand } from './codeController';
import { startCode } from './agentController';
import type { StreamEvent } from './protocol';
import type { SessionOpts } from './client';

// Strip ANSI escape / color sequences so a dev server's output reads as plain
// text in the terminal card (v1 renders no color), and normalise CRLF to LF.
// (Moved here from NoteEditorWebView so /run's output shaping lives with the run.)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r\n/g, '\n');
}

/** One compact transcript block the editor's codeLive reducer understands. */
export type CodeBlock =
  | { t: 'delta'; text: string }
  | { t: 'text'; text: string }
  | { t: 'user'; text: string }
  | { t: 'tool'; name: string; input: unknown }
  | { t: 'toolresult'; text: string; isError: boolean };

// Map a parsed Claude stream event to a /code transcript block, or null for the
// events the card doesn't render (session init, per-turn result markers, other).
function codeEventToBlock(ev: StreamEvent): CodeBlock | null {
  switch (ev.kind) {
    case 'assistant-delta':
      return { t: 'delta', text: ev.text };
    case 'assistant-text':
      return { t: 'text', text: ev.text };
    case 'user-prompt':
      // A user turn echoed by the server (so it replays on reconnect).
      return { t: 'user', text: ev.text };
    case 'tool-use':
      return { t: 'tool', name: ev.name, input: ev.input };
    case 'tool-result':
      return { t: 'toolresult', text: ev.text, isError: ev.isError };
    default:
      return null;
  }
}

const j = JSON.stringify;

/**
 * The bridge a mounted page hands the registry: how to render into the CURRENT
 * WebView, plus the two page-coupled side effects that don't go through the
 * WebView (a /clean title and a finished /ingest). `inject` receives a JS
 * statement WITHOUT a trailing `true;` — the caller appends it.
 */
export interface RunSink {
  inject(js: string): void;
  /** /clean produced a title for a page that had none. */
  onSetTitle?(title: string): void;
  /** /ingest filed the page into the dashboard; the page is now deleted. */
  onIngested?(): void;
}

type Kind = 'ask' | 'clean' | 'ingest' | 'run' | 'code';

// A coalesced /code transcript item, mirroring the webview's reduceCodeItems so a
// re-attach can repaint compactly (accumulated tokens as one text block) instead
// of replaying thousands of deltas. `open` marks prose still streaming.
type CodeItem =
  | { type: 'text'; text: string; open: boolean }
  | { type: 'user'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'result'; text: string; isError: boolean };

// The union of control surfaces across the run kinds, all optional so any of the
// concrete handles (AskHandle/RunHandle/CodeHandle) assigns cleanly and the
// forwarders can probe for the method a given kind supports.
interface RunHandleLike {
  cancel?(): void;
  stop?(): void;
  prompt?(text: string): void;
  sendStdin?(data: string): void;
  interrupt?(): void;
}

interface Entry {
  kind: Kind;
  handle: RunHandleLike;
  sink: RunSink | null;
  // Live buffer for repaint on re-attach (kind-specific; only one is used).
  askAnswer: string; // ask
  runLog: string; // run
  codeItems: CodeItem[]; // code
  // Set once a terminal callback has fired. `pendingApply` holds the terminal
  // effect when no sink was attached at completion, to be flushed on next attach.
  settled: boolean;
  pendingApply: ((sink: RunSink) => void) | null;
}

const CODE_TEXT_CAP = 16 * 1024; // per assistant text block, matches state.js
function capText(t: string): string {
  return t.length > CODE_TEXT_CAP ? '…' + t.slice(t.length - CODE_TEXT_CAP) : t;
}

// Fold one compact block into the coalesced buffer, mirroring reduceCodeItems in
// webview-editor/src/state.js so re-attach repaints identically.
function reduce(items: CodeItem[], b: CodeBlock): CodeItem[] {
  const out = items.slice();
  const last = out[out.length - 1];
  const openText = last && last.type === 'text' && last.open ? last : null;
  const closeOpen = () => {
    if (openText) out[out.length - 1] = { ...openText, open: false };
  };
  switch (b.t) {
    case 'delta':
      if (openText) out[out.length - 1] = { ...openText, text: capText(openText.text + b.text) };
      else out.push({ type: 'text', text: capText(b.text), open: true });
      break;
    case 'text':
      if (openText) out[out.length - 1] = { type: 'text', text: capText(b.text), open: false };
      else out.push({ type: 'text', text: capText(b.text), open: false });
      break;
    case 'user':
      closeOpen();
      out.push({ type: 'user', text: b.text });
      break;
    case 'tool':
      closeOpen();
      out.push({ type: 'tool', name: b.name, input: b.input });
      break;
    case 'toolresult':
      closeOpen();
      out.push({ type: 'result', text: b.text, isError: b.isError });
      break;
  }
  return out;
}

// Turn a coalesced item back into the compact block a __codeEvent replay needs.
// An open text block replays as a delta (stays open, so a following live delta
// extends it seamlessly); a closed one as authoritative text.
function itemToBlock(it: CodeItem): CodeBlock {
  switch (it.type) {
    case 'text':
      return it.open ? { t: 'delta', text: it.text } : { t: 'text', text: it.text };
    case 'user':
      return { t: 'user', text: it.text };
    case 'tool':
      return { t: 'tool', name: it.name, input: it.input };
    case 'result':
      return { t: 'toolresult', text: it.text, isError: it.isError };
  }
}

const runs = new Map<string, Entry>();

// Build the durable-session options handed to a controller. `id` opts the run
// into a server session that survives disconnects; `onReset` fires just before a
// reconnect replays the buffered tail — we clear our buffer AND the webview live
// field so the replay rebuilds cleanly instead of duplicating. `resetKind` picks
// which live field to clear (run/code/else→ask).
function makeSession(id: string, resetKind: 'run' | 'code' | 'ask', resumeOnly: boolean): SessionOpts {
  return {
    id,
    resumeOnly,
    onReset: () => {
      const e = runs.get(id);
      if (!e) return;
      e.askAnswer = '';
      e.runLog = '';
      e.codeItems = [];
      e.sink?.inject(`window.__liveReset(${j(id)}, ${j(resetKind)})`);
    },
  };
}

/** Is there a live run for this card id right now? */
export function has(id: string): boolean {
  return runs.has(id);
}

// Emit a JS statement to the attached WebView, if any. When detached the buffer
// still advances; the statement is simply dropped (the run keeps going).
function emit(e: Entry, js: string): void {
  e.sink?.inject(js);
}

// Record a terminal result. If a sink is attached, apply it now and drop the
// entry; otherwise stash it to flush the moment a page re-attaches (so a run that
// finished while you were on another page still commits its result to the note).
function settle(id: string, apply: (sink: RunSink) => void): void {
  const e = runs.get(id);
  if (!e || e.settled) return;
  e.settled = true;
  if (e.sink) {
    apply(e.sink);
    runs.delete(id);
  } else {
    e.pendingApply = apply;
  }
}

// Replace any existing entry for this id (a chat follow-up reuses the id; a stale
// terminal entry may still be lingering) and register the fresh one.
function put(id: string, entry: Entry): Entry {
  const prev = runs.get(id);
  if (prev) {
    prev.handle.cancel?.();
    prev.handle.stop?.();
  }
  runs.set(id, entry);
  return entry;
}

function base(kind: Kind, handle: Entry['handle'], sink: RunSink): Entry {
  return {
    kind,
    handle,
    sink,
    askAnswer: '',
    runLog: '',
    codeItems: [],
    settled: false,
    pendingApply: null,
  };
}

/**
 * Start (or restart) an /ask — also the /chat follow-up path, which reuses the
 * card id and threads prior turns through `context`. Streams the answer into the
 * card and commits the final answer (or error) to the note.
 */
export function startAsk(
  id: string,
  question: string,
  sink: RunSink,
  context?: AskContext,
  resumeOnly = false,
): void {
  const handle = runAsk(
    question,
    {
      onDelta: answer => {
        const e = runs.get(id);
        if (!e) return;
        e.askAnswer = answer;
        emit(e, `window.__aiStream(${j(id)}, ${j(answer)});`);
      },
      onDone: answer =>
        settle(id, s =>
          s.inject(`window.__aiDone(${j(id)}, ${j({ a: answer, status: 'done' })});`),
        ),
      onError: (msg, partial) =>
        settle(id, s =>
          s.inject(
            `window.__aiDone(${j(id)}, ${j({ a: partial, status: 'error', msg })});`,
          ),
        ),
    },
    makeSession(id, 'ask', resumeOnly),
    context,
  );
  put(id, base('ask', handle, sink));
}

/** Start a /clean rewrite. On success swaps in the cleaned text behind Accept/Reject. */
export function startClean(
  id: string,
  pageText: string,
  guidance: string,
  needTitle: boolean,
  sink: RunSink,
  resumeOnly = false,
): void {
  const handle = runClean(
    pageText,
    guidance,
    needTitle,
    {
      onDone: (cleaned, title) =>
        settle(id, s => {
          s.inject(`window.__cleanApply(${j(id)}, ${j(cleaned)});`);
          if (title) s.onSetTitle?.(title);
        }),
      onError: msg =>
        settle(id, s =>
          s.inject(`window.__aiDone(${j(id)}, ${j({ status: 'error', msg })});`),
        ),
    },
    makeSession(id, 'ask', resumeOnly),
  );
  put(id, base('clean', handle, sink));
}

/** Start an /ingest. On success the page is filed and deleted (via the sink). */
export function startIngest(id: string, pageText: string, sink: RunSink, resumeOnly = false): void {
  const handle = runIngest(
    pageText,
    {
      onDone: () => settle(id, s => s.onIngested?.()),
      onError: msg =>
        settle(id, s =>
          s.inject(`window.__aiDone(${j(id)}, ${j({ status: 'error', msg })});`),
        ),
    },
    makeSession(id, 'ask', resumeOnly),
  );
  put(id, base('ingest', handle, sink));
}

/**
 * Start a /run terminal session, streaming stdout/stderr into the card. `dir` is
 * the project subdir (from `/run PROJECT <cmd>`) the command starts in; omitted on
 * a resume, where the server already holds the session's directory.
 */
export function startRun(
  id: string,
  cmd: string,
  sink: RunSink,
  dir?: string,
  resumeOnly = false,
): void {
  const handle = runCommand(
    cmd,
    dir,
    {
      onLog: (_stream, chunk) => {
        const e = runs.get(id);
        if (!e) return;
        const clean = stripAnsi(chunk);
        e.runLog += clean;
        emit(e, `window.__runLog(${j(id)}, ${j(clean)});`);
      },
      onExit: code => settle(id, s => s.inject(`window.__runExit(${j(id)}, ${code});`)),
      onError: msg => settle(id, s => s.inject(`window.__runError(${j(id)}, ${j(msg)});`)),
    },
    makeSession(id, 'run', resumeOnly),
  );
  put(id, base('run', handle, sink));
}

/** Open a persistent /code agent session in project `name`, streaming its transcript. */
export function startCodeRun(id: string, name: string, sink: RunSink, resumeOnly = false): void {
  const handle = startCode(
    name,
    undefined,
    {
      onEvent: ev => {
        const e = runs.get(id);
        if (!e) return;
        const block = codeEventToBlock(ev);
        if (!block) return;
        e.codeItems = reduce(e.codeItems, block);
        emit(e, `window.__codeEvent(${j(id)}, ${j(block)});`);
      },
      onExit: () => settle(id, s => s.inject(`window.__codeExit(${j(id)});`)),
      onError: msg => settle(id, s => s.inject(`window.__codeError(${j(id)}, ${j(msg)});`)),
    },
    makeSession(id, 'code', resumeOnly),
  );
  put(id, base('code', handle, sink));
}

/**
 * Send a follow-up prompt to a running /code session. The transcript echo comes
 * from the SERVER (a `userprompt` frame → 'user-prompt' event), not locally, so a
 * reconnect replay stays faithful — we just forward the turn here.
 */
export function codePrompt(id: string, text: string): void {
  const e = runs.get(id);
  if (!e || e.kind !== 'code') return;
  e.handle.prompt?.(text);
}

/** Feed a line to a running /run process's stdin. */
export function runStdin(id: string, data: string): void {
  runs.get(id)?.handle.sendStdin?.(data);
}

/** Ctrl-C a running /run process (SIGINT to its group). */
export function runInterrupt(id: string): void {
  runs.get(id)?.handle.interrupt?.();
}

/**
 * Explicitly stop a run (user hit × / Stop, or the card is being finalized by the
 * caller). Tears down the underlying handle — which closes the socket and, for
 * now, kills the laptop process — and drops the entry.
 */
export function stop(id: string): void {
  const e = runs.get(id);
  if (!e) return;
  e.handle.cancel?.();
  e.handle.stop?.();
  runs.delete(id);
}

/**
 * A freshly-mounted page attaches its sink to a run by id and is repainted from
 * the buffer. Returns 'attached' if a live run was adopted, 'settled' if a run
 * that finished while detached was flushed into the note just now, or 'none' if
 * there is no such run (the caller then finalizes the card as interrupted).
 */
export function attach(id: string, sink: RunSink): 'attached' | 'settled' | 'none' {
  const e = runs.get(id);
  if (!e) return 'none';
  e.sink = sink;

  // Repaint whatever has streamed so far into the fresh WebView.
  if (e.kind === 'ask' && e.askAnswer) {
    sink.inject(`window.__aiStream(${j(id)}, ${j(e.askAnswer)});`);
  } else if (e.kind === 'run' && e.runLog) {
    sink.inject(`window.__runLog(${j(id)}, ${j(e.runLog)});`);
  } else if (e.kind === 'code') {
    for (const it of e.codeItems) {
      sink.inject(`window.__codeEvent(${j(id)}, ${j(itemToBlock(it))});`);
    }
  }

  // If it finished while nobody was watching, flush the terminal result now.
  if (e.pendingApply) {
    e.pendingApply(sink);
    runs.delete(id);
    return 'settled';
  }
  return 'attached';
}

/**
 * A page is unmounting: stop rendering into its (dying) WebView but leave the run
 * alive and buffering. Only detaches the sink if the id is still owned by the
 * passed-in sink — a re-attach by another mount must not be clobbered.
 */
export function detach(id: string, sink: RunSink): void {
  const e = runs.get(id);
  if (e && e.sink === sink) e.sink = null;
}

/**
 * Cold-start resume: the registry has no live entry for this in-flight card (the
 * app was restarted), so open a resume-only server session for it and stream it
 * back in. If the server still has the session it replays the buffered tail and
 * continues live; if it was already reaped the client gets `gone` and finalizes
 * the card as interrupted. `kind` comes from the persisted marker.
 */
export function resume(id: string, kind: string, sink: RunSink): void {
  switch (kind) {
    case 'run':
      startRun(id, '', sink, undefined, true);
      break;
    case 'code':
      startCodeRun(id, '', sink, true);
      break;
    case 'clean':
      startClean(id, '', '', false, sink, true);
      break;
    case 'ingest':
      startIngest(id, '', sink, true);
      break;
    case 'pair':
      // Pairing is a one-shot request, not a durable session; a pending pair card
      // orphaned by an app restart just resolves to interrupted (no socket).
      sink.inject(
        `window.__aiDone(${j(id)}, ${j({ status: 'error', msg: 'Pairing was interrupted.' })});`,
      );
      break;
    default: // ask / chat
      startAsk(id, '', sink, undefined, true);
      break;
  }
}
