// Copy / delete / corner affordances shared by the code, link, image, /ask and
// /run + /code cards. Behaviour lives here; the glyphs come from ./icons and the
// hold-to-delete gesture from ./longPress, so each button is a thin assembly.

import { c } from '../theme/palette.js';
import { COPY, CHECK, TRASH } from './icons.js';
import { copyText } from './clipboard.js';
import { attachLongPress } from './longPress.js';
import { guardTaps } from './events.js';

function setBtnIcon(btn, icon, label) {
  btn.innerHTML = icon;
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

// The shared copy button (code cards and link cards use the same UI). Copies
// `text`, flips to a check briefly, and swallows the tap so it doesn't reach
// the surrounding widget (which would open the link / move the caret). `inline`
// sits it in a flex header (e.g. /chat, /talk) instead of pinning it absolute.
export function makeCopyButton(text, { inline } = {}) {
  const btn = document.createElement('span');
  btn.className = 'cm-copy-btn' + (inline ? ' cm-copy-inline' : '');
  setBtnIcon(btn, COPY, 'Copy');
  btn.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    copyText(text);
    setBtnIcon(btn, CHECK, 'Copied');
    btn.classList.add('cm-copied');
    setTimeout(() => {
      setBtnIcon(btn, COPY, 'Copy');
      btn.classList.remove('cm-copied');
    }, 1200);
  });
  return btn;
}

// A header button that is "Copy" by default and morphs into "Delete" after a
// long-press anywhere on `holdTarget`. It reverts to "Copy" a few seconds later
// if delete isn't tapped. Shared by the /ask card, link card and block image.
export function makeCardActionButton({ copyValue, onDelete, holdTarget, inline }) {
  const btn = document.createElement('span');
  btn.className = 'cm-copy-btn' + (inline ? ' cm-copy-inline' : '');
  let mode = 'copy';
  let revert = null;

  const toCopy = () => {
    mode = 'copy';
    setBtnIcon(btn, COPY, 'Copy');
    btn.classList.remove('cm-copied', 'cm-del-btn');
  };
  const toDelete = () => {
    mode = 'delete';
    setBtnIcon(btn, TRASH, 'Delete');
    btn.classList.remove('cm-copied');
    btn.classList.add('cm-del-btn');
    if (revert) clearTimeout(revert);
    revert = setTimeout(toCopy, 3000);
  };
  toCopy();

  // Keep the press off the surrounding card, but DON'T preventDefault on
  // touchstart — that cancels the emulated click, making the button untappable.
  btn.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (revert) clearTimeout(revert);
    if (mode === 'delete') {
      onDelete();
      return;
    }
    if (!copyValue) return;
    copyText(copyValue);
    setBtnIcon(btn, CHECK, 'Copied');
    btn.classList.add('cm-copied');
    setTimeout(toCopy, 1200);
  });

  attachLongPress(holdTarget, toDelete);
  return btn;
}

// A top-right corner control that shows `icon` (Export / Expand) and morphs into
// Delete after a long-press anywhere on `holdTarget`, reverting after 3s if not
// tapped. Tapping runs `onActivate` in the default state or `onDelete` when
// armed. Optional `onArm` fires the moment it morphs into Delete (used by /run to
// copy the command to the clipboard). Shared by the finished /record card
// (Export), the /run + /code cards (Expand), and now /chat + /talk — the same
// hold-to-delete gesture everywhere.
export function makeCornerButton({ icon, label, holdTarget, onActivate, onDelete, onArm }) {
  const corner = document.createElement('span');
  corner.className = 'cm-rec-corner cm-rec-export';
  let mode = 'default';
  let revert = null;
  const toDefault = () => {
    mode = 'default';
    corner.innerHTML = icon;
    corner.classList.remove('cm-rec-corner-del');
    corner.setAttribute('aria-label', label);
  };
  const toDelete = () => {
    const wasArmed = mode === 'delete';
    mode = 'delete';
    corner.innerHTML = TRASH;
    corner.classList.add('cm-rec-corner-del');
    corner.setAttribute('aria-label', 'Delete');
    if (revert) clearTimeout(revert);
    revert = setTimeout(toDefault, 3000);
    // Only on the transition into Delete, not on a re-hold while already armed.
    if (!wasArmed && onArm) onArm();
  };
  toDefault();
  guardTaps(corner, () => {
    if (revert) clearTimeout(revert);
    if (mode === 'delete') onDelete();
    else onActivate();
  });
  attachLongPress(holdTarget, toDelete);
  return corner;
}

export const styles = {
  '.cm-copy-btn': {
    position: 'absolute',
    top: '0.55em',
    right: '0.7em',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '6px',
    color: c.subtext0,
    backgroundColor: c.surface0,
    border: `1px solid ${c.surface1}`,
    borderRadius: '7px',
    cursor: 'pointer',
    userSelect: 'none',
    zIndex: '2',
  },
  '.cm-copy-btn svg': {
    display: 'block',
    width: '16px',
    height: '16px',
  },
  '.cm-copy-btn.cm-copied': {
    color: c.green,
    borderColor: c.green,
  },
  // Delete mode (after a long-press on the card).
  '.cm-copy-btn.cm-del-btn': {
    color: c.red,
    borderColor: c.red,
  },
  // Header variant: sits inline in the flex header instead of pinned absolute.
  '.cm-copy-btn.cm-copy-inline': {
    position: 'static',
    flexShrink: '0',
    alignSelf: 'center',
  },

  // Shared top-right corner control (makeCornerButton): the Export/Expand glyph,
  // and its armed-Delete state — a red-bordered rounded box matching the /ask
  // card's delete button. `.cm-rec-corner` is also worn by the /record card's
  // plain × (non-stopped states); the × glyph sizing lives with that card.
  '.cm-rec-corner': {
    flexShrink: '0',
    alignSelf: 'flex-start',
    color: c.overlay1,
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-rec-export': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2px',
  },
  '.cm-rec-export svg': { display: 'block', width: '19px', height: '19px' },
  '.cm-rec-export:active': { color: c.mauve },
  '.cm-rec-corner-del': {
    color: c.red,
    backgroundColor: c.surface0,
    border: `1px solid ${c.red}`,
    borderRadius: '7px',
    padding: '6px',
  },
  '.cm-rec-corner-del svg': { width: '16px', height: '16px' },
};
