// Unsent composer text, held outside the DOM and keyed by card id.
//
// A card's footer box and its full-page overlay's footer box are two DIFFERENT
// elements for the same conversation, and both can be mounted at once (the
// overlay is a fixed layer laid over the still-mounted card). So half-typed text
// can't live on the input alone: expanding a card built a fresh, empty box, and
// closing the page left the card's original box untouched — the text the user
// had just typed vanished in both directions.
//
// Every box registers here under its card id. The store keeps the current text
// and mirrors it into every OTHER live box for that card, so whichever one the
// user is looking at is always showing what they typed — across expand, close,
// the accordion collapsing, and CM rebuilding the card widget on an update.
// Only a send clears it (the composer writes back the emptied value).

const drafts = new Map(); // card id -> { text, boxes: Set<input> }

function slot(key) {
  let s = drafts.get(key);
  if (!s) {
    s = { text: '', boxes: new Set() };
    drafts.set(key, s);
  }
  return s;
}

// Register a composer box under `key`, seeding it with the unsent text (if any)
// and returning it. Boxes are never explicitly unregistered — they're dropped
// lazily once they leave the DOM (see syncDraft), which covers every teardown
// path: a closed overlay, a collapsed accordion, a rebuilt widget.
export function bindDraft(key, el) {
  if (!key) return el;
  const s = slot(key);
  s.boxes.add(el);
  el.value = s.text;
  return el;
}

// `el`'s value is the new truth for `key` (the user typed/dictated into it, or a
// submit handler just cleared it): store it and push it to the card's other live
// boxes. Cheap enough to call on every keystroke — a card has at most two boxes.
export function syncDraft(key, el) {
  if (!key) return;
  const s = drafts.get(key);
  if (!s) return;
  s.text = el.value;
  for (const box of s.boxes) {
    if (!box.isConnected) {
      s.boxes.delete(box); // gone from the DOM — stop mirroring into it
      continue;
    }
    // Never write into the box being typed in: assigning .value would drop the
    // caret to the end mid-sentence.
    if (box !== el && box.value !== s.text) box.value = s.text;
  }
  // Nothing typed and nothing mounted: drop the slot rather than leaving an
  // empty row behind for every card the user has ever opened.
  if (!s.text && !s.boxes.size) drafts.delete(key);
}

// Forget a card's draft entirely — it was deleted, so no box will ever show it
// again.
export function dropDraft(key) {
  if (key) drafts.delete(key);
}
