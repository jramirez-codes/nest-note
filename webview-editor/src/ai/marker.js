import { post } from '../bridge.js';
import { payloadField, setPayload, clearPayload } from '../state.js';
import { dropDraft } from './shared/drafts.js';

// --- /ask + /pair markers ---------------------------------------------------
// An ask/pair block is persisted as a multi-line HTML comment so the raw text
// stays human- and AI-reviewer-readable (a reviewer reads the note's markdown
// source and needs to see the user↔agent exchange in the clear):
//
//   <!--ai
//   kind: ask
//   id: a1b2c3d4
//   open: true
//   status: done
//   [user]
//   How do I center a div?
//   [agent]
//   Use flexbox: display:flex; justify-content:center; align-items:center;
//   -->
//
// Metadata rides in `key: value` header lines; the question and answer live in
// labeled `[user]` / `[agent]` sections. The answer is the only genuinely
// multi-line field and it comes last, bounded only by the closing `-->`, so the
// single sequence that would break the HTML comment — a literal `-->` in the
// content — is escaped to `--&gt;` on write and restored on read. `[user]` /
// `[agent]` occurring inside the answer are harmless: the parser splits on the
// first of each. The card widget renders the block; the raw form is only ever
// seen in the stored markdown (and by the reviewing AI).
//
// Legacy notes stored the payload as a single-line base64 comment
// (`<!--ai <b64>-->`); that form is still decoded for back-compat, and any edit
// rewrites the block into the readable multi-line form above.

const OPEN_LINE = '<!--ai';
const CLOSE_LINE = '-->';
const SEC_USER = '[user]';
const SEC_AGENT = '[agent]';
// A /clean review marker stashes the pre-clean document here, so Reject can
// restore it — multi-line, like the answer, so it's the block's last section.
const SEC_BACKUP = '[backup]';
// The /code agent transcript, stored as a single line of JSON (an array of typed
// blocks) — see encodeAiMarker / parseBlockBody.
const SEC_TRANSCRIPT = '[transcript]';
// A /run terminal card stashes its final output tail here — multi-line like the
// answer/backup, so it's the block's last section.
const SEC_OUTPUT = '[output]';
const HEADER_RE = /^(\w+):\s?(.*)$/;
// Legacy: whole line is `<!--ai <base64>-->`. base64's alphabet has no `{`,
// so this can never match a value written by the new encoder.
const LEGACY_RE = /^<!--ai ([A-Za-z0-9+/=]+)-->$/;

// Keys whose stored string value should be coerced back to a non-string type.
const BOOL_KEYS = new Set(['open']);
// `seq` is the last server frame sequence the persisted partial reflects, so a
// cold start can resume a durable session from just past it (see runRegistry).
const NUM_KEYS = new Set(['v', 'ms', 'startedAt', 'code', 'seq', 'port']);

// The card kinds whose bulky body is stored OUT of the document — in payloadField
// (in memory) and SQLite (on disk), keyed by the marker id — rather than inline.
// These are the big, machine-ish payloads: a /code transcript, /run output, and
// the /clean backup (a whole-page copy). Light markers for these keep only header
// lines; eachAiLine merges the body back onto the parsed object so every renderer/
// overlay reads obj.items/out/backup exactly as before. See state.js payloadField.
//
// /ask + /chat deliberately stay INLINE: their bodies are model prose (the
// reviewable user↔agent exchange this file is built around), the question is card
// identity that must ride in the marker, and they're rarely large enough to be the
// bridge/parse problem that /code is.
export const EXTERNAL_KINDS = new Set(['clean', 'run', 'code']);

// obj -> the { field: value } object that carries an externalized kind's body
// (what gets merged back onto a marker), or null for kinds with no stored body.
export function bodyFromObj(kind, obj) {
  switch (kind) {
    case 'code':
      return { items: obj.items || [] };
    case 'run':
      return { out: obj.out || '' };
    case 'clean':
      return { backup: obj.backup || '' };
    default:
      return null;
  }
}

// obj -> the string persisted to SQLite for `kind` (JSON for the /code transcript
// array, raw text otherwise).
export function encodePayload(kind, obj) {
  if (kind === 'code') return JSON.stringify(obj.items || []);
  if (kind === 'run') return obj.out || '';
  if (kind === 'clean') return obj.backup || '';
  return '';
}

// Stored string -> the body object merged onto a marker (inverse of encodePayload).
export function decodePayload(kind, payload) {
  if (kind === 'code') {
    try {
      return { items: JSON.parse(payload) };
    } catch {
      return { items: [] };
    }
  }
  if (kind === 'run') return { out: payload };
  if (kind === 'clean') return { backup: payload };
  return {};
}

// Statuses where the card is still in-flight and the async server callbacks
// (__aiStream / __aiDone) need to find it by id. Once a card reaches a terminal
// status nothing looks it up again, so the id is dropped to keep finished notes
// free of machine gibberish.
const INFLIGHT = new Set(['streaming', 'pending', 'running']);

// UTF-8-safe base64 decode, kept only to read legacy markers (btoa/atob are
// Latin1-only; answers contain emoji/Unicode).
function b64decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Single-line fields (headers + the question): keep them on one line and safe
// from the comment terminator. `-->` can't survive in a comment, so escape it;
// newlines are collapsed so a stray one can't masquerade as a header/section.
function escLine(val) {
  return String(val).replace(/-->/g, '--&gt;').replace(/\r?\n/g, '\\n');
}
function unescLine(val) {
  return val.replace(/\\n/g, '\n').replace(/--&gt;/g, '-->');
}
// The answer keeps its real newlines; the comment terminator is escaped, and a
// content line that is exactly a section label (`[user]`/`[agent]`/`[backup]`)
// has its leading bracket escaped so it can't masquerade as a real section
// divider — this is what lets a chat transcript stack many `[user]`/`[agent]`
// turns in one block and still parse back turn-for-turn.
function escBody(val) {
  return String(val)
    .replace(/-->/g, '--&gt;')
    .replace(/^\[(user|agent|backup|output|transcript)\]$/gm, '&#91;$1]');
}
function unescBody(val) {
  return val.replace(/&#91;/g, '[').replace(/--&gt;/g, '-->');
}

// /talk cards (kind:'notes-chat') share /chat's multi-turn marker shape and
// follow-up mechanics — this is the one place that says so, so every kind-shape
// check below only has to grow this list, not itself.
export function isChatKind(kind) {
  return kind === 'chat' || kind === 'notes-chat';
}

function coerce(key, val) {
  if (BOOL_KEYS.has(key)) return val === 'true';
  if (NUM_KEYS.has(key)) return Number(val);
  return val;
}

// Emit the header lines (everything except the body sections), in object-key
// order (so the readable order is v, kind, id, open, status, …). Shared by the
// light and full encoders below.
function emitHeaders(obj) {
  const { q, a, backup, turns, out, items, ...meta } = obj;
  // Externalized cards keep their handle for good: the id is the key their body
  // is stored under (payloadField + SQLite). Chat threads a follow-up by id;
  // record addresses its clip by id; view re-fetches its transient (token-bearing)
  // proxy URL by id on every mount (see viewFetcher).
  const keepId =
    INFLIGHT.has(obj.status) ||
    EXTERNAL_KINDS.has(obj.kind) ||
    isChatKind(obj.kind) ||
    obj.kind === 'record' ||
    obj.kind === 'view';
  const lines = [OPEN_LINE];
  for (const [k, val] of Object.entries(meta)) {
    if (val == null) continue;
    if (k === 'id' && !keepId) continue; // finished cards don't need the handle
    lines.push(k + ': ' + escLine(val));
  }
  return lines;
}

// Header-only marker: no body sections. Used for the externalized kinds, whose
// body lives in payloadField + SQLite — that's what keeps `pages.content` small so
// a large /code transcript can't bloat the note text serialized over the bridge on
// every keystroke.
function encodeLight(obj) {
  const lines = emitHeaders(obj);
  lines.push(CLOSE_LINE);
  return lines.join('\n');
}

// The marker written to the DOCUMENT. Externalized kinds (code/run/clean) get the
// light, header-only form; every other kind (ask/chat/pair/ingest/record/view)
// stays fully inline exactly as before — /ask + /chat keep their question and prose
// in the marker so the raw note stays human/AI-reviewable. Every existing caller
// (commands.js, the commit paths) gets the right form for free.
export function encodeAiMarker(obj) {
  return EXTERNAL_KINDS.has(obj.kind) ? encodeLight(obj) : encodeAiMarkerFull(obj);
}

// The FULLY-INLINED marker: headers PLUS the body sections. Used only to
// reconstruct the whole page in the clear (serializeFull → /ingest, /clean) and by
// the migration path — never written back to the live document. This is the
// mirror of parseBlockBody, and the pre-externalization encodeAiMarker.
export function encodeAiMarkerFull(obj) {
  const { q, a, backup, turns, out, items } = obj;
  const lines = emitHeaders(obj);
  if (obj.kind === 'ask') {
    lines.push(SEC_USER);
    lines.push(escLine(q || ''));
    lines.push(SEC_AGENT);
    if (a) lines.push(escBody(a));
  } else if (isChatKind(obj.kind)) {
    // One `[user]`/`[agent]` pair per turn, in order; the last turn's answer may
    // be empty while it's still streaming.
    for (const t of turns || []) {
      lines.push(SEC_USER);
      lines.push(escLine(t.q || ''));
      lines.push(SEC_AGENT);
      if (t.a) lines.push(escBody(t.a));
    }
  } else if (obj.kind === 'clean' && backup != null) {
    lines.push(SEC_BACKUP);
    lines.push(escBody(backup));
  } else if ((obj.kind === 'run' || obj.kind === 'update') && out != null) {
    // /update reuses the /run output section for its captured pull+build log. It
    // stays inline (not externalized) — the log is capped small on the server.
    lines.push(SEC_OUTPUT);
    lines.push(escBody(out));
  } else if (obj.kind === 'code' && items != null) {
    // JSON.stringify emits no literal newlines, so the whole transcript is one
    // body line; escBody only has to guard the comment terminator.
    lines.push(SEC_TRANSCRIPT);
    lines.push(escBody(JSON.stringify(items)));
  }
  lines.push(CLOSE_LINE);
  return lines.join('\n');
}

// Parse the inner lines of a multi-line block (everything between `<!--ai` and
// `-->`) back into a payload object, or null if it isn't a valid marker.
function parseBlockBody(bodyLines) {
  const obj = {};
  let i = 0;
  for (; i < bodyLines.length; i++) {
    const t = bodyLines[i];
    if (
      t === SEC_USER ||
      t === SEC_AGENT ||
      t === SEC_BACKUP ||
      t === SEC_OUTPUT ||
      t === SEC_TRANSCRIPT
    )
      break;
    const m = HEADER_RE.exec(t);
    if (m) obj[m[1]] = coerce(m[1], unescLine(m[2]));
  }
  // Chat-shaped blocks stack many turns; walk each `[user]`/`[agent]` pair in order.
  if (isChatKind(obj.kind)) {
    const turns = [];
    while (i < bodyLines.length) {
      if (bodyLines[i] !== SEC_USER) {
        i++;
        continue;
      }
      i++;
      const qLines = [];
      for (; i < bodyLines.length && bodyLines[i] !== SEC_AGENT && bodyLines[i] !== SEC_USER; i++) {
        qLines.push(bodyLines[i]);
      }
      let a = '';
      if (bodyLines[i] === SEC_AGENT) {
        i++;
        const aLines = [];
        for (; i < bodyLines.length && bodyLines[i] !== SEC_USER; i++) aLines.push(bodyLines[i]);
        a = unescBody(aLines.join('\n'));
      }
      turns.push({ q: unescLine(qLines.join('\n')).trim(), a });
    }
    obj.turns = turns;
    return obj;
  }
  if (bodyLines[i] === SEC_USER) {
    i++;
    const qLines = [];
    for (; i < bodyLines.length && bodyLines[i] !== SEC_AGENT; i++) qLines.push(bodyLines[i]);
    obj.q = unescLine(qLines.join('\n')).trim();
  }
  if (bodyLines[i] === SEC_AGENT) {
    obj.a = unescBody(bodyLines.slice(i + 1).join('\n'));
  } else if (bodyLines[i] === SEC_BACKUP) {
    obj.backup = unescBody(bodyLines.slice(i + 1).join('\n'));
  } else if (bodyLines[i] === SEC_OUTPUT) {
    obj.out = unescBody(bodyLines.slice(i + 1).join('\n'));
  } else if (bodyLines[i] === SEC_TRANSCRIPT) {
    try {
      obj.items = JSON.parse(unescBody(bodyLines.slice(i + 1).join('\n')));
    } catch {
      obj.items = [];
    }
  }
  return obj.kind ? obj : null;
}

// Decode a legacy single-line base64 marker payload.
function parseLegacy(b64) {
  try {
    const obj = JSON.parse(b64decode(b64));
    return obj && obj.kind ? obj : null;
  } catch (e) {
    return null;
  }
}

export function genId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

// Walk every ai marker block in the document, calling fn(obj, range) with the
// parsed payload and its `{ from, to }` document span. Handles both the
// multi-line form and legacy single-line base64 markers. This is the one place
// that knows the block layout; the helpers below build on it.
export function eachAiLine(state, fn) {
  const doc = state.doc;
  // Merge each card's externalized body (payloadField) back onto the parsed
  // marker object, so downstream readers see obj.items/out/a/turns/backup exactly
  // as when the body lived inline. `false` = don't throw where the field is absent
  // (nested answer-view editors, tests). The stored body overrides any inline body
  // still present mid-migration (they're the same data).
  const payloads = state.field(payloadField, false) || null;
  const merge = obj => {
    if (payloads && obj.id && payloads[obj.id]) Object.assign(obj, payloads[obj.id].body);
    return obj;
  };
  let i = 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    const t = line.text.trim();

    const legacy = LEGACY_RE.exec(t);
    if (legacy) {
      const obj = parseLegacy(legacy[1]);
      if (obj) fn(merge(obj), { from: line.from, to: line.to });
      i++;
      continue;
    }

    if (t === OPEN_LINE) {
      // Scan forward to the closing `-->`. Content never contains a bare `-->`
      // (it's escaped), so the first match is always our terminator.
      let j = i + 1;
      while (j <= doc.lines && doc.line(j).text.trim() !== CLOSE_LINE) j++;
      if (j <= doc.lines) {
        const bodyLines = [];
        for (let k = i + 1; k < j; k++) bodyLines.push(doc.line(k).text);
        const obj = parseBlockBody(bodyLines);
        if (obj) {
          fn(merge(obj), { from: line.from, to: doc.line(j).to });
          i = j + 1;
          continue;
        }
      }
      // Unterminated or unparsable — don't swallow the rest of the doc.
      i++;
      continue;
    }
    i++;
  }
}

// Reconstruct the whole page markdown with every externalized card body inlined
// again — the "hydrated" form. Consumers that need the complete page in the clear
// (/ingest → orchestrator, /clean → Claude) use this instead of doc.toString(),
// which now yields only light markers. eachAiLine has already merged each body
// onto obj, so encodeAiMarkerFull re-emits it.
// `skip` (optional { from, to }) omits one doc range — the `/ingest` or `/clean`
// command line that triggered the call — from the emitted text, matching the old
// "whole page minus this command line" behaviour.
export function serializeFull(state, skip) {
  const doc = state.doc;
  const parts = [];
  let pos = 0;
  const pushText = (from, to) => {
    if (skip && skip.from >= from && skip.to <= to) {
      parts.push(doc.sliceString(from, skip.from));
      parts.push(doc.sliceString(skip.to, to));
    } else {
      parts.push(doc.sliceString(from, to));
    }
  };
  eachAiLine(state, (obj, range) => {
    pushText(pos, range.from);
    parts.push(encodeAiMarkerFull(obj));
    pos = range.to;
  });
  pushText(pos, doc.length);
  return parts.join('');
}

// An externalized block still carries its body inline if it has one of their body
// section labels, or is a legacy single-line base64 marker.
const SECTION_LABEL_RE = /\n\[(backup|output|transcript)\]/;

// One-time, self-healing migration, run right after a document is seeded (and
// after /clean inserts its cleaned text). Any externalized card still holding its
// body INLINE — an old note, or freshly-inserted cleaned text — is moved into
// payloadField + SQLite and its marker rewritten to the light form, shrinking the
// note text so a large /code transcript no longer rides the bridge on every
// keystroke. Already-light markers are left untouched (idempotent).
export function migrateInlineMarkers(view) {
  const state = view.state;
  const doc = state.doc;
  const changes = [];
  const effects = [];
  const posts = [];
  eachAiLine(state, (obj, range) => {
    if (!EXTERNAL_KINDS.has(obj.kind) || !obj.id) return;
    const raw = doc.sliceString(range.from, range.to);
    if (!SECTION_LABEL_RE.test(raw) && !LEGACY_RE.test(raw.trim())) return; // already light
    const kind = obj.kind;
    effects.push(setPayload.of({ id: obj.id, kind, body: bodyFromObj(kind, obj) }));
    posts.push({ type: 'cardPayload', id: obj.id, kind, payload: encodePayload(kind, obj) });
    changes.push({ from: range.from, to: range.to, insert: encodeAiMarker(obj) });
  });
  if (changes.length) view.dispatch({ changes, effects });
  for (const p of posts) post(p);
}

// Locate the marker block for a given id (used by the RN → web update bridge).
// Named findAiLine for historical reasons; it returns the whole block span.
export function findAiLine(state, id) {
  let found = null;
  eachAiLine(state, (obj, range) => {
    if (!found && obj.id === id) found = { from: range.from, to: range.to, obj };
  });
  return found;
}

// Resolve the marker block a card widget sits on, at interaction time, so edits
// above it don't invalidate a captured position (mirrors CheckboxWidget).
export function aiBlockOf(view, el) {
  const pos = view.posAtDOM(el);
  let found = null;
  eachAiLine(view.state, (obj, range) => {
    if (!found && pos >= range.from && pos <= range.to) found = { ...range, obj };
  });
  return found;
}

// Rewrite a card's persisted payload in place (toggle collapse, commit answer).
export function updateAiMarker(view, el, patch) {
  const block = aiBlockOf(view, el);
  if (!block) return;
  view.dispatch({
    changes: {
      from: block.from,
      to: block.to,
      insert: encodeAiMarker({ ...block.obj, ...patch }),
    },
  });
}

// Remove the whole block a card widget sits on (plus its trailing newline), and
// drop its externalized body from state + SQLite so no orphan row is left behind.
export function deleteCardLine(view, el) {
  const block = aiBlockOf(view, el);
  if (!block) return;
  const to = Math.min(block.to + 1, view.state.doc.length);
  const id = block.obj.id;
  view.dispatch({
    changes: { from: block.from, to },
    ...(id ? { effects: clearPayload.of(id) } : {}),
  });
  if (id && EXTERNAL_KINDS.has(block.obj.kind)) post({ type: 'cardDelete', id });
  dropDraft(id); // no composer will ever show this card's unsent text again
}

// Reject a /clean review: swap the whole document back to the stored backup
// (the pre-clean page text), which also drops the review marker with it.
export function restoreCleanBackup(view, el) {
  const block = aiBlockOf(view, el);
  if (!block) return;
  const backup = block.obj.backup || '';
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: backup } });
  // The clean card is gone with the swap; drop its (now orphan) backup row.
  if (block.obj.id) post({ type: 'cardDelete', id: block.obj.id });
}

// Append a new turn to the chat block `el` sits on and kick off its run in
// place: the transcript grows inside the SAME card (not a new one), and the full
// prior transcript rides along as context so the server answers in-conversation.
// Returns the chat id, or null if `el` isn't a chat card.
export function appendChatTurn(view, el, question) {
  const block = aiBlockOf(view, el);
  if (!block || !isChatKind(block.obj.kind)) return null;
  return appendChatTurnById(view, block.obj.id, question);
}

// Same as appendChatTurn but addressed by chat id (not DOM), so the full-page
// overlay — which has no marker-line DOM to resolve — can drive the thread too.
// Returns the chat id, or null if no chat-shaped card carries it.
export function appendChatTurnById(view, id, question) {
  const found = findAiLine(view.state, id);
  if (!found || !isChatKind(found.obj.kind)) return null;
  const priorTurns = (found.obj.turns || []).map(t => ({ q: t.q, a: t.a }));
  const turns = priorTurns.concat([{ q: question, a: '' }]);
  const marker = encodeAiMarker({ ...found.obj, turns, open: true, status: 'streaming' });
  view.dispatch({ changes: { from: found.from, to: found.to, insert: marker } });
  // /talk threads carry a fixed subject and run through the orchestrator-aware
  // prompt; plain /chat reuses the /ask stream path. Both correlate by id.
  if (found.obj.kind === 'notes-chat') {
    post({ type: 'notesChat', id, subject: found.obj.subject, question, context: { turns: priorTurns } });
  } else {
    post({ type: 'ask', id, question, context: { turns: priorTurns } });
  }
  return id;
}

// Re-run a finished /run card in place: reset it to running, wipe the previous
// run's captured output (the doc payloadField AND its SQLite row), and re-post the
// same command by id — RN starts a fresh process and streams into the SAME card.
// Reusing the id is safe end-to-end: the RN registry replaces the stale entry and
// the server drops the finished-and-lingering session for a fresh one. Addressed by
// id (not DOM) so the full-page overlay can drive it too. Returns the id, or null
// if no run card carries it.
export function rerunRunById(view, id) {
  const found = findAiLine(view.state, id);
  if (!found || found.obj.kind !== 'run') return null;
  const { cmd, dir } = found.obj;
  const marker = encodeAiMarker({ ...found.obj, status: 'running', open: true });
  view.dispatch({
    changes: { from: found.from, to: found.to, insert: marker },
    effects: clearPayload.of(id),
  });
  // Overwrite the last run's output on disk too, so a reload before the fresh run
  // finishes doesn't show the old logs.
  post({ type: 'cardPayload', id, kind: 'run', payload: '' });
  post({ type: 'run', id, cmd, dir });
  return id;
}

// Merge a completed run's patch into a marker payload before re-encoding. For
// chat, an incoming answer belongs to the LAST (streaming) turn rather than a
// top-level `a` field, so route it there; everything else merges flat.
export function mergeAiDone(obj, patch) {
  if (isChatKind(obj.kind) && 'a' in patch) {
    const { a, ...rest } = patch;
    const turns = (obj.turns || []).slice();
    if (turns.length) turns[turns.length - 1] = { ...turns[turns.length - 1], a };
    return { ...obj, ...rest, turns };
  }
  return { ...obj, ...patch };
}
