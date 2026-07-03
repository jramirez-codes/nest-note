import { StateEffect, StateField } from '@codemirror/state';

// Preview metadata, keyed by URL, filled in asynchronously by RN via
// window.__setPreview. Held in editor state so the card decorations recompute
// when it arrives. Value: { domain, title?, description?, image?, favicon?, error? }.
export const setPreviewEffect = StateEffect.define();

// A process-wide cache shared by the main editor and every /ask answer view, so
// a preview fetched once shows up everywhere — including answer views that mount
// AFTER the fetch completed (they seed from here on create).
const previewCache = Object.create(null);
export function cachePreview(url, data) {
  previewCache[url] = data;
}

export const previewField = StateField.define({
  create: () => Object.assign(Object.create(null), previewCache),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setPreviewEffect)) {
        next = { ...next, [e.value.url]: e.value.data };
      }
    }
    return next;
  },
});

// Live streaming answers, keyed by ask id: { a, status }. Filled token-by-token
// by RN via window.__aiStream so the answer can grow WITHOUT rewriting the
// document on every chunk — that keeps the user's caret still and avoids a save
// storm. The final answer is committed to the doc once, on completion.
export const setAskLive = StateEffect.define();
export const clearAskLive = StateEffect.define();
export const askLiveField = StateField.define({
  create: () => Object.create(null),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setAskLive)) {
        next = { ...next, [e.value.id]: { a: e.value.a, status: e.value.status } };
      } else if (e.is(clearAskLive)) {
        if (next[e.value] !== undefined) {
          next = { ...next };
          delete next[e.value];
        }
      }
    }
    return next;
  },
});
