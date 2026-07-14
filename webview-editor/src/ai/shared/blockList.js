// An occlusion-virtualized list of transcript blocks inside a scrolling `log`.
// Only blocks within the viewport (± MARGIN) are mounted as live DOM; the rest
// collapse to a height-pinned placeholder so the scrollbar geometry stays exact
// and scrolling doesn't jump. This keeps a long /code session from mounting
// hundreds of nested markdown editors at once — the mounted count is bounded by
// the viewport, not the transcript length (mirrors how a terminal only paints
// its visible rows). Shared by the /code card body and its full-page overlay.
//
// The streaming (last, open) block is pinned mounted and never virtualized, so
// token appends (growStreaming) can never race the observer unmounting it.
//
//   renderItem(item, prev, streaming) -> { node, view }
//     node: the block's DOM; view: its answer EditorView (for teardown) or null.
//   estimateHeight(item) -> px: a cheap height guess for a block that has never
//     been mounted (a transcript restored from disk). Once a block is mounted its
//     real height is measured and pinned, so estimates only affect first paint and
//     self-correct the moment a block scrolls through the viewport.

import { unmountAnswerView } from '../answerView.js';
import { growMdView, nearBottom, scrollBottomSoon } from './streamLog.js';

const MARGIN = '400px 0px'; // pre-mount this far above & below the viewport

export function createBlockList({ log, renderItem, estimateHeight }) {
  const slots = [];
  let streaming = null; // the slot we never unmount (its view is being appended to)
  let dead = false;

  const io = new IntersectionObserver(
    entries => {
      for (const e of entries) {
        const slot = e.target.__slot;
        if (!slot) continue;
        if (e.isIntersecting) mount(slot);
        else unmount(slot);
      }
    },
    { root: log, rootMargin: MARGIN },
  );

  const est = item => Math.max(24, Math.floor(estimateHeight ? estimateHeight(item) : 60));

  function makeSlot(item, prev) {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-vblock';
    const slot = { item, prev, wrapper, mounted: false, view: null, reserved: est(item) };
    wrapper.__slot = slot;
    wrapper.style.minHeight = slot.reserved + 'px';
    return slot;
  }

  // Is the block entirely above the viewport? Measured against the live rects so
  // it's correct regardless of the wrapper's offsetParent.
  function isAbove(el) {
    return el.getBoundingClientRect().bottom <= log.getBoundingClientRect().top;
  }

  function mount(slot) {
    if (dead || slot.mounted) return;
    const wasAbove = isAbove(slot.wrapper);
    const before = slot.reserved;
    slot.wrapper.style.minHeight = '';
    slot.wrapper.style.height = '';
    const { node, view } = renderItem(slot.item, slot.prev, slot === streaming);
    slot.wrapper.appendChild(node);
    slot.view = view || null;
    slot.mounted = true;
    // Measure once laid out. If a restored block that was only estimated snaps to
    // a different real height above the viewport, nudge scrollTop so what the
    // reader is looking at doesn't shift.
    requestAnimationFrame(() => {
      if (dead || !slot.mounted) return;
      const h = slot.wrapper.offsetHeight;
      if (!h) return;
      slot.reserved = h;
      if (wasAbove && h !== before) log.scrollTop += h - before;
    });
  }

  function unmount(slot) {
    if (!slot.mounted || slot === streaming) return;
    const h = slot.wrapper.offsetHeight || slot.reserved;
    slot.reserved = h;
    if (slot.view) unmountAnswerView(slot.view);
    slot.view = null;
    slot.wrapper.replaceChildren();
    slot.wrapper.style.height = h + 'px'; // pin — the scrollbar stays identical
    slot.mounted = false;
  }

  function clear() {
    io.disconnect();
    for (const s of slots) if (s.view) unmountAnswerView(s.view);
    slots.length = 0;
    streaming = null;
  }

  function addSlots(items, from) {
    for (let i = from; i < items.length; i++) {
      const slot = makeSlot(items[i], items[i - 1]);
      slots.push(slot);
      log.appendChild(slot.wrapper);
      io.observe(slot.wrapper);
    }
  }

  // Pin the last block as the streaming one (eagerly mounted) when the session is
  // live and it's assistant prose — the only block that grows token-by-token.
  function markStreaming(items, running) {
    const n = items.length;
    if (running && n && items[n - 1].type === 'text') {
      streaming = slots[n - 1];
      mount(streaming); // eager: growStreaming appends into it immediately
    } else {
      streaming = null;
    }
  }

  return {
    // Full (re)build from scratch — first open, or a structural change.
    build(items, running) {
      clear();
      log.replaceChildren();
      addSlots(items, 0);
      markStreaming(items, running);
      scrollBottomSoon(log);
    },
    // Append newly-streamed blocks [from..], settling the block that had been
    // streaming onto its final text first. Cheaper than build — the header,
    // composer and every earlier block stay put.
    appendFrom(items, from, running) {
      if (streaming && streaming.view) growMdView(streaming.view, items[from - 1]?.text || '');
      streaming = null;
      addSlots(items, from);
      markStreaming(items, running);
      scrollBottomSoon(log);
    },
    // Extend the live streaming block token-by-token. Returns true if it changed.
    growStreaming(text) {
      if (!streaming || !streaming.view) return false;
      const stick = nearBottom(log);
      const changed = growMdView(streaming.view, text);
      if (changed && stick) log.scrollTop = log.scrollHeight;
      return changed;
    },
    hasStreaming() {
      return !!(streaming && streaming.view);
    },
    destroy() {
      dead = true;
      clear();
    },
  };
}
