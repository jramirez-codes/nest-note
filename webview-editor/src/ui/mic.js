// The mic toggle that sits in the bottom-right corner of every card composer box
// (the /chat + /talk follow-up box and the /code prompt box), where a Send button
// used to be.
//
// Speech-to-text itself is owned by React Native — the footer mic's recognizer
// (useDictation) streams its transcript back in through window.__dictate, which
// routes into whichever composer input has the caret. So this button does two
// things: it puts the caret in ITS composer's box, and it asks RN to flip the
// session on or off (`{type:'dictate', on}`).
//
// Because the transcript follows the caret, "tap the mic on this widget" reads as
// "talk into THIS box":
//   • mic off                     → focus this box, ask RN to start
//   • mic live, caret elsewhere   → hop the caret here; the session keeps running
//   • mic live, caret already here → ask RN to stop (a true toggle)
//
// Stopping goes through the same mic-off handoff as the footer mic, which fires
// an Enter where the caret sits (see __dictateActive in index.js) — so ending a
// session inside a composer submits what was dictated, which is what the Send
// button used to be for.
//
// Every mounted button is registered here so RN flipping the session repaints
// them all in place (cards are rebuilt often; a stale button would lie about the
// mic's state).

import { post } from '../bridge.js';
import { c } from '../theme/palette.js';
import { MIC } from './icons.js';
import { guardTaps } from './events.js';

// Whether a dictation session is live right now, mirrored from __dictateActive.
let live = false;
// Mounted mic buttons, repainted on every session flip. Detached ones are pruned
// as we go rather than tracked by teardown — a card rebuild simply drops its DOM.
const buttons = new Set();

function paint(el) {
  const label = live ? 'Stop dictation' : 'Dictate';
  el.classList.toggle('cm-mic-live', live);
  el.title = label;
  el.setAttribute('aria-label', label);
}

/** Called from __dictateActive whenever RN starts/ends a session. */
export function setMicLive(on) {
  live = !!on;
  for (const el of buttons) {
    if (el.isConnected) paint(el);
    else buttons.delete(el);
  }
}

function focusEnd(input) {
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

function tapMic(input) {
  if (live && document.activeElement === input) {
    post({ type: 'dictate', on: false });
    return;
  }
  // Focus first either way: the caret is what decides where the next chunk of
  // speech lands, and a session that's already running redirects the moment it
  // moves. RN suppresses the soft keyboard for the focused box once the session
  // is live (__dictateActive → suppressKeyboard), so this box stays keyboard-free
  // while the mic runs — and keeps a normal keyboard if the mic never comes up.
  focusEnd(input);
  if (!live) post({ type: 'dictate', on: true });
}

/** A composer's mic button. Same look on every card it lands on. */
export function makeMicButton(input) {
  const el = document.createElement('span');
  el.className = 'cm-mic-btn';
  el.innerHTML = MIC;
  guardTaps(el, () => tapMic(input));
  buttons.add(el);
  paint(el);
  return el;
}

// Coloured exactly like the footer strip's mic bubble (PageIndicator), because
// it's the same mic: a recessed surface with a de-emphasized glyph when idle,
// accent-filled with a cut-out glyph while a session runs. Only the silhouette
// differs — a rounded square sized to sit over the composer box next to /run's
// and /code's controls (`.cm-foot-actions` in ask.js), rather than the footer's
// circle. It has to stay opaque: text wraps under it.
export const styles = {
  '.cm-mic-btn': {
    flexShrink: '0',
    boxSizing: 'border-box', // 30px total, borders in — see `.cm-ask-followup`
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '30px',
    height: '30px',
    padding: '0',
    border: `1px solid ${c.surface1}`,
    borderRadius: '8px',
    backgroundColor: c.surface0,
    color: c.overlay0,
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-mic-btn svg': { display: 'block', width: '17px', height: '17px' },
  '.cm-mic-btn.cm-mic-live': {
    backgroundColor: c.mauve,
    borderColor: c.mauve,
    color: c.base,
  },
};
