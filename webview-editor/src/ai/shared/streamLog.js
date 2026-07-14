// The "grow a live log and keep it pinned to the bottom" logic shared by the
// /run and /code cards and their full-page overlay. Streamed output is
// cumulative, so an append is normally a cheap end-insert; a wholesale replace
// is the fallback for when the in-memory tail cap has dropped earlier text.

import { streamAppend } from '../answerView.js';

// Was the reader pinned near the bottom of `scroller` (the editor viewport)
// BEFORE an append grew the content? Must be measured first — once we append,
// scrollHeight jumps and the check is meaningless. If they'd scrolled up to
// re-read, we leave them be.
export function nearBottom(scroller) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
}

// Re-pin `el` to its newest content after the DOM reflows. rAF waits for the
// grown view to lay out; otherwise scrollHeight is still stale.
export function scrollBottomSoon(el) {
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}

// Reconcile a <pre> terminal log to `next` (the cumulative, tail-capped output)
// with the cheapest possible DOM edit. The log is kept as a SINGLE text node so
// the common case — more output appended at the end — is one native appendData,
// which reflows only the last line rather than re-laying-out the whole log.
//
// Once the in-memory tail cap (RUN_CAP) starts sliding the window, `next` no
// longer starts with what's shown: the front dropped and a fresh tail arrived.
// Rather than rewrite the entire <pre> on every chunk (O(n) reflow per chunk —
// the freeze this fixes), we locate the retained overlap and edit only the ends:
// deleteData the chars that fell off the front, appendData the new tail. Returns
// true if the DOM changed.
export function growPre(pre, next) {
  let node = pre.firstChild;
  if (!node || node.nodeType !== 3) {
    // No text node yet (empty log): seed one.
    if (next === '') return false;
    pre.textContent = next;
    return true;
  }
  const cur = node.data;
  if (next === cur) return false;
  // Fast path — pure append (the window hasn't started sliding yet).
  if (next.startsWith(cur)) {
    node.appendData(next.slice(cur.length));
    return true;
  }
  // Slide path — anchor on the tail of what's shown to find where it sits in
  // `next`; everything before it fell off the front, everything after is new.
  const K = Math.min(cur.length, 256);
  const at = next.lastIndexOf(cur.slice(cur.length - K));
  const drop = at < 0 ? -1 : cur.length - K - at;
  if (drop < 0) {
    // No clean overlap (a reset, or the tail moved further than the anchor) —
    // fall back to a single full replace.
    node.data = next;
    return true;
  }
  if (drop > 0) node.deleteData(0, drop);
  node.appendData(next.slice(at + K));
  return true;
}

// Append the streamed tail into a nested read-only markdown answer view, tagged
// streamAppend so the read-only changeFilter lets it through. Returns true if it
// changed. Used for assistant prose in /ask, /chat and /code.
export function growMdView(mdView, next) {
  const cur = mdView.state.doc.toString();
  if (next === cur) return false;
  const change = next.startsWith(cur)
    ? { from: cur.length, insert: next.slice(cur.length) }
    : { from: 0, to: mdView.state.doc.length, insert: next };
  mdView.dispatch({ changes: change, annotations: streamAppend.of(true) });
  return true;
}
