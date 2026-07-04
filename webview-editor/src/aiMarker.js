import { post } from './bridge.js';

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
const HEADER_RE = /^(\w+):\s?(.*)$/;
// Legacy: whole line is `<!--ai <base64>-->`. base64's alphabet has no `{`,
// so this can never match a value written by the new encoder.
const LEGACY_RE = /^<!--ai ([A-Za-z0-9+/=]+)-->$/;

// Keys whose stored string value should be coerced back to a non-string type.
const BOOL_KEYS = new Set(['open']);
const NUM_KEYS = new Set(['v', 'ms', 'startedAt']);

// Statuses where the card is still in-flight and the async server callbacks
// (__aiStream / __aiDone) need to find it by id. Once a card reaches a terminal
// status nothing looks it up again, so the id is dropped to keep finished notes
// free of machine gibberish.
const INFLIGHT = new Set(['streaming', 'pending']);

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
    .replace(/^\[(user|agent|backup)\]$/gm, '&#91;$1]');
}
function unescBody(val) {
  return val.replace(/&#91;/g, '[').replace(/--&gt;/g, '-->');
}

function coerce(key, val) {
  if (BOOL_KEYS.has(key)) return val === 'true';
  if (NUM_KEYS.has(key)) return Number(val);
  return val;
}

// Encode a payload object into a multi-line marker block. Everything except the
// question/answer becomes a header line, in object-key order (so the readable
// order is v, kind, id, open, status, …).
export function encodeAiMarker(obj) {
  const { q, a, backup, turns, ...meta } = obj;
  // Chat cards keep their handle even when done: the id is how a later reply
  // (fired from the card's follow-up box) threads back into the same run. Record
  // cards keep it too — Record/Stop/Export all address the card by id.
  const keepId =
    INFLIGHT.has(obj.status) || obj.kind === 'chat' || obj.kind === 'record';
  const lines = [OPEN_LINE];
  for (const [k, val] of Object.entries(meta)) {
    if (val == null) continue;
    if (k === 'id' && !keepId) continue; // finished cards don't need the handle
    lines.push(k + ': ' + escLine(val));
  }
  if (obj.kind === 'ask') {
    lines.push(SEC_USER);
    lines.push(escLine(q || ''));
    lines.push(SEC_AGENT);
    if (a) lines.push(escBody(a));
  } else if (obj.kind === 'chat') {
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
    if (t === SEC_USER || t === SEC_AGENT || t === SEC_BACKUP) break;
    const m = HEADER_RE.exec(t);
    if (m) obj[m[1]] = coerce(m[1], unescLine(m[2]));
  }
  // Chat blocks stack many turns; walk each `[user]`/`[agent]` pair in order.
  if (obj.kind === 'chat') {
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
  let i = 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    const t = line.text.trim();

    const legacy = LEGACY_RE.exec(t);
    if (legacy) {
      const obj = parseLegacy(legacy[1]);
      if (obj) fn(obj, { from: line.from, to: line.to });
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
          fn(obj, { from: line.from, to: doc.line(j).to });
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

// Remove the whole block a card widget sits on (plus its trailing newline).
export function deleteCardLine(view, el) {
  const block = aiBlockOf(view, el);
  if (!block) return;
  const to = Math.min(block.to + 1, view.state.doc.length);
  view.dispatch({ changes: { from: block.from, to } });
}

// Reject a /clean review: swap the whole document back to the stored backup
// (the pre-clean page text), which also drops the review marker with it.
export function restoreCleanBackup(view, el) {
  const block = aiBlockOf(view, el);
  if (!block) return;
  const backup = block.obj.backup || '';
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: backup } });
}

// Append a new turn to the chat block `el` sits on and kick off its run in
// place: the transcript grows inside the SAME card (not a new one), and the full
// prior transcript rides along as context so the server answers in-conversation.
// Returns the chat id, or null if `el` isn't a chat card.
export function appendChatTurn(view, el, question) {
  const block = aiBlockOf(view, el);
  if (!block || block.obj.kind !== 'chat') return null;
  const priorTurns = (block.obj.turns || []).map(t => ({ q: t.q, a: t.a }));
  const turns = priorTurns.concat([{ q: question, a: '' }]);
  const marker = encodeAiMarker({ ...block.obj, turns, open: true, status: 'streaming' });
  view.dispatch({ changes: { from: block.from, to: block.to, insert: marker } });
  // Reuse the /ask stream path (RN correlates by id); context carries history.
  post({ type: 'ask', id: block.obj.id, question, context: { turns: priorTurns } });
  return block.obj.id;
}

// Merge a completed run's patch into a marker payload before re-encoding. For
// chat, an incoming answer belongs to the LAST (streaming) turn rather than a
// top-level `a` field, so route it there; everything else merges flat.
export function mergeAiDone(obj, patch) {
  if (obj.kind === 'chat' && 'a' in patch) {
    const { a, ...rest } = patch;
    const turns = (obj.turns || []).slice();
    if (turns.length) turns[turns.length - 1] = { ...turns[turns.length - 1], a };
    return { ...obj, ...rest, turns };
  }
  return { ...obj, ...patch };
}
