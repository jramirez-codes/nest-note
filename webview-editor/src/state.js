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

// Live terminal output for /run cards, keyed by run id: { out, status, code }.
// Filled chunk-by-chunk by RN via window.__runLog so the log grows WITHOUT
// rewriting the document (no caret jump, no save storm) — exactly like askLive.
// Only a bounded tail is kept in memory; on completion a capped snapshot is
// committed to the doc once and the live entry cleared.
const RUN_CAP = 64 * 1024;
export const setRunLog = StateEffect.define();
export const setRunStatus = StateEffect.define();
export const clearRunLog = StateEffect.define();
export const runLiveField = StateField.define({
  create: () => Object.create(null),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setRunLog)) {
        const { id, chunk } = e.value;
        const prev = next[id] || { out: '', status: 'running' };
        let out = prev.out + chunk;
        if (out.length > RUN_CAP) out = out.slice(out.length - RUN_CAP);
        next = { ...next, [id]: { ...prev, out } };
      } else if (e.is(setRunStatus)) {
        const { id, status, code } = e.value;
        const prev = next[id] || { out: '', status: 'running' };
        next = { ...next, [id]: { ...prev, status, code } };
      } else if (e.is(clearRunLog)) {
        if (next[e.value] !== undefined) {
          next = { ...next };
          delete next[e.value];
        }
      }
    }
    return next;
  },
});

// Live transcript for /code agent cards, keyed by session id: { items, status }.
// A persistent Claude Code session streams a mix of blocks — the user's prompts,
// assistant prose, tool calls and their results — and RN feeds them here as
// discrete events (window.__codeEvent) so the transcript grows WITHOUT rewriting
// the document, exactly like runLive. On completion a capped snapshot of `items`
// is committed to the marker once and the live entry cleared.
//
// Each item is one of:
//   { type:'user',   text }              a prompt the user sent
//   { type:'text',   text, open }        assistant prose (open while streaming)
//   { type:'tool',   name, input }       a tool call
//   { type:'result', text, isError }     a tool's output
const CODE_ITEM_CAP = 400; // keep the newest N blocks in memory
const CODE_TEXT_CAP = 16 * 1024; // per assistant text block
export const appendCodeEvent = StateEffect.define();
export const setCodeStatus = StateEffect.define();
export const clearCodeLive = StateEffect.define();
export const codeLiveField = StateField.define({
  create: () => Object.create(null),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(appendCodeEvent)) {
        const { id, ev } = e.value;
        const prev = next[id] || { items: [], status: 'running' };
        next = { ...next, [id]: { ...prev, items: reduceCodeItems(prev.items, ev) } };
      } else if (e.is(setCodeStatus)) {
        const { id, status } = e.value;
        const prev = next[id] || { items: [], status: 'running' };
        next = { ...next, [id]: { ...prev, status } };
      } else if (e.is(clearCodeLive)) {
        if (next[e.value] !== undefined) {
          next = { ...next };
          delete next[e.value];
        }
      }
    }
    return next;
  },
});

// Fold one streamed event into the transcript. Assistant tokens (delta) extend
// the open text block so prose types out in place; anything else closes it. The
// final full-text block (t:'text') replaces whatever the deltas built, so a
// dropped delta can't leave the block subtly wrong.
function reduceCodeItems(items, ev) {
  const out = items.slice();
  const last = out[out.length - 1];
  const openText = last && last.type === 'text' && last.open ? last : null;
  const closeOpen = () => {
    if (openText) out[out.length - 1] = { ...openText, open: false };
  };
  switch (ev.t) {
    case 'delta':
      if (openText) {
        out[out.length - 1] = {
          ...openText,
          text: capText(openText.text + (ev.text || '')),
        };
      } else {
        out.push({ type: 'text', text: capText(ev.text || ''), open: true });
      }
      break;
    case 'text':
      if (openText) out[out.length - 1] = { type: 'text', text: capText(ev.text || ''), open: false };
      else out.push({ type: 'text', text: capText(ev.text || ''), open: false });
      break;
    case 'tool':
      closeOpen();
      out.push({ type: 'tool', name: ev.name || '', input: ev.input || '' });
      break;
    case 'toolresult':
      closeOpen();
      out.push({ type: 'result', text: ev.text || '', isError: !!ev.isError });
      break;
    case 'user':
      closeOpen();
      out.push({ type: 'user', text: ev.text || '' });
      break;
    default:
      return items; // unknown event — no change
  }
  return out.length > CODE_ITEM_CAP ? out.slice(out.length - CODE_ITEM_CAP) : out;
}

function capText(s) {
  return s.length > CODE_TEXT_CAP ? s.slice(s.length - CODE_TEXT_CAP) : s;
}

// Live iframe URL for /view cards, keyed by view id: { url, error, status }.
// The URL carries the bearer token (as a bootstrap query the proxy turns into a
// cookie), so it must never touch the document — it lives here only, refilled by
// RN via window.__viewUrl on every mount (see the viewFetcher plugin). status is
// 'loading' until RN answers, then 'ready' (url set) or 'error' (message set).
export const setViewUrl = StateEffect.define();
export const clearViewLive = StateEffect.define();
export const viewLiveField = StateField.define({
  create: () => Object.create(null),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setViewUrl)) {
        const { id, url, error } = e.value;
        next = {
          ...next,
          [id]: {
            url: url || '',
            error: error || '',
            status: error ? 'error' : url ? 'ready' : 'loading',
          },
        };
      } else if (e.is(clearViewLive)) {
        if (next[e.value] !== undefined) {
          next = { ...next };
          delete next[e.value];
        }
      }
    }
    return next;
  },
});

// Externalized card bodies, keyed by card id: { kind, body, v }. The heavy body
// of an /ask, /chat, /clean, /run or /code card (its answer, transcript, output
// or backup) lives HERE and in SQLite on the RN side — NOT inline in the note
// markdown — so a large transcript can't bloat the document that is serialized
// over the bridge on every keystroke (the /code crash). eachAiLine merges `body`
// back onto the parsed marker object, so every renderer keeps reading obj.items/
// out/a/turns/backup unchanged. `v` bumps on each write so a card re-renders when
// its persisted body changes. RN seeds this on load (window.__setPayloads) and
// the commit paths (index.js) write to it as cards stream/finish.
//
// `body` is the shape merged onto the marker object, per kind:
//   code  -> { items }   chat -> { turns }   run -> { out }
//   ask   -> { a }       clean -> { backup }
export const setPayload = StateEffect.define(); // { id, kind, body }
export const setPayloads = StateEffect.define(); // { [id]: { kind, body } } (merge)
export const clearPayload = StateEffect.define(); // id
export const payloadField = StateField.define({
  create: () => Object.create(null),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setPayload)) {
        const { id, kind, body } = e.value;
        const prev = next[id];
        next = { ...next, [id]: { kind, body, v: (prev ? prev.v : 0) + 1 } };
      } else if (e.is(setPayloads)) {
        next = { ...next };
        for (const id in e.value) {
          const prev = next[id];
          next[id] = { ...e.value[id], v: (prev ? prev.v : 0) + 1 };
        }
      } else if (e.is(clearPayload)) {
        if (next[e.value] !== undefined) {
          next = { ...next };
          delete next[e.value];
        }
      }
    }
    return next;
  },
});

// Which /record card (by id) is currently playing back, so its button shows
// Pause. Ephemeral like askLive — playback state never touches the document.
// RN drives it via window.__recPlay (set true on play, false on pause/end).
export const setRecPlay = StateEffect.define();
export const recPlayField = StateField.define({
  create: () => Object.create(null),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setRecPlay)) {
        const { id, playing } = e.value;
        if (playing) {
          next = { ...next, [id]: true };
        } else if (next[id] !== undefined) {
          next = { ...next };
          delete next[id];
        }
      }
    }
    return next;
  },
});
