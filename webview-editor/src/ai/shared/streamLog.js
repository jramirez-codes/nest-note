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

// Append the streamed tail into a <pre> log (or replace wholesale if the tail
// cap dropped earlier text). Returns true if the DOM changed.
export function growPre(pre, next) {
  const cur = pre.textContent;
  if (next === cur) return false;
  if (next.startsWith(cur)) pre.appendChild(document.createTextNode(next.slice(cur.length)));
  else pre.textContent = next;
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
