// --- /ask + /pair markers ---------------------------------------------------
// An ask/pair block is persisted as a single-line HTML comment carrying a
// base64-encoded JSON payload: `<!--ai <b64>-->`. base64's alphabet can't
// contain `-->`, so the marker is robust no matter what the answer text holds
// (code, arrows, quotes), and it stays on one line so line-based detection is
// trivial. The card widget renders it; the raw marker is only ever seen if the
// widget can't mount.
const AI_MARK_RE = /^<!--ai ([A-Za-z0-9+/=]+)-->$/;

// UTF-8-safe base64 (btoa is Latin1-only; answers contain emoji/Unicode). Built
// with a loop rather than spread so large answers don't blow the call stack.
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Encode a payload object into a marker line; decode a line back to the object
// (null if the line isn't an ai marker or is malformed).
export function encodeAiMarker(obj) {
  return '<!--ai ' + b64encode(JSON.stringify(obj)) + '-->';
}
export function parseAiMarker(lineText) {
  const m = AI_MARK_RE.exec(lineText.trim());
  if (!m) return null;
  try {
    const obj = JSON.parse(b64decode(m[1]));
    return obj && obj.kind ? obj : null;
  } catch (e) {
    return null;
  }
}

export function genId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

// Locate the marker line for a given id (used by the RN → web update bridge).
export function findAiLine(state, id) {
  const doc = state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const obj = parseAiMarker(line.text);
    if (obj && obj.id === id) return { from: line.from, to: line.to, obj };
  }
  return null;
}

// Every line that is an /ask or /pair marker (yields the parsed payload + line).
export function eachAiLine(state, fn) {
  const doc = state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const obj = parseAiMarker(line.text);
    if (obj) fn(obj, line);
  }
}

// Resolve the marker line a card widget sits on, at interaction time, so edits
// above it don't invalidate a captured position (mirrors CheckboxWidget).
export function aiLineOf(view, el) {
  const pos = view.posAtDOM(el);
  return view.state.doc.lineAt(pos);
}

// Rewrite a card's persisted payload in place (toggle collapse, commit answer).
export function updateAiMarker(view, el, patch) {
  const line = aiLineOf(view, el);
  const obj = parseAiMarker(line.text);
  if (!obj) return;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: encodeAiMarker({ ...obj, ...patch }) },
  });
}

// Remove the whole line a block-card widget sits on (mirrors the /ask delete).
export function deleteCardLine(view, el) {
  const line = aiLineOf(view, el);
  const to = Math.min(line.to + 1, view.state.doc.length);
  view.dispatch({ changes: { from: line.from, to } });
}
