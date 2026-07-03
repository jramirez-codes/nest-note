// Copy / delete affordances shared by the code, link, image and /ask cards.

// An html-source WebView is not a secure context, so navigator.clipboard is
// unavailable; the execCommand path works from within a tap (user gesture).
function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      return;
    }
  } catch (e) {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } catch (e) {}
  document.body.removeChild(ta);
}

// Inline (offline-safe) icons drawn with currentColor, so the button's color
// classes (green when copied, red in delete mode) tint them for free.
const SVG_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const ICON_COPY =
  SVG_OPEN +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK = SVG_OPEN + '<polyline points="20 6 9 17 4 12"/></svg>';
const ICON_TRASH =
  SVG_OPEN +
  '<polyline points="3 6 5 6 21 6"/>' +
  '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
  '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

function setBtnIcon(btn, icon, label) {
  btn.innerHTML = icon;
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

// The shared copy button (code cards and link cards use the same UI). Copies
// `text`, flips to a check briefly, and swallows the tap so it doesn't reach
// the surrounding widget (which would open the link / move the caret).
export function makeCopyButton(text) {
  const btn = document.createElement('span');
  btn.className = 'cm-copy-btn';
  setBtnIcon(btn, ICON_COPY, 'Copy');
  btn.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    copyText(text);
    setBtnIcon(btn, ICON_CHECK, 'Copied');
    btn.classList.add('cm-copied');
    setTimeout(() => {
      setBtnIcon(btn, ICON_COPY, 'Copy');
      btn.classList.remove('cm-copied');
    }, 1200);
  });
  return btn;
}

// Fire `cb` when the user presses and holds on `el` for ~500ms without dragging.
// Works for touch (the mobile WebView) and mouse. The click that a press-release
// would otherwise emit is swallowed (capture phase) so a long-press to reveal
// the delete button doesn't also toggle/open the widget underneath.
function attachLongPress(el, cb) {
  let timer = null;
  let fired = false;
  let sx = 0;
  let sy = 0;
  const MOVE_CANCEL = 10;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const start = (x, y) => {
    sx = x;
    sy = y;
    fired = false;
    clear();
    timer = setTimeout(() => {
      fired = true;
      cb();
    }, 500);
  };
  const move = (x, y) => {
    if (Math.abs(x - sx) > MOVE_CANCEL || Math.abs(y - sy) > MOVE_CANCEL) clear();
  };
  el.addEventListener(
    'touchstart',
    e => start(e.touches[0].clientX, e.touches[0].clientY),
    { passive: true },
  );
  el.addEventListener('touchmove', e => move(e.touches[0].clientX, e.touches[0].clientY), {
    passive: true,
  });
  el.addEventListener('touchend', clear);
  el.addEventListener('touchcancel', clear);
  el.addEventListener('mousedown', e => start(e.clientX, e.clientY));
  el.addEventListener('mousemove', e => move(e.clientX, e.clientY));
  el.addEventListener('mouseup', clear);
  el.addEventListener('mouseleave', clear);
  el.addEventListener(
    'click',
    e => {
      // Swallow the click that a long-press release emits (so it doesn't toggle
      // or open the card) — but never swallow a real tap on the action button.
      if (fired && !(e.target.closest && e.target.closest('.cm-copy-btn'))) {
        e.preventDefault();
        e.stopPropagation();
      }
      fired = false;
    },
    true,
  );
}

// A header button that is "Copy" by default and morphs into "Delete" after a
// long-press anywhere on `holdTarget`. It reverts to "Copy" a few seconds later
// if delete isn't tapped. Shared by the /ask card and the link card.
export function makeCardActionButton({ copyValue, onDelete, holdTarget, inline }) {
  const btn = document.createElement('span');
  btn.className = 'cm-copy-btn' + (inline ? ' cm-copy-inline' : '');
  let mode = 'copy';
  let revert = null;

  const toCopy = () => {
    mode = 'copy';
    setBtnIcon(btn, ICON_COPY, 'Copy');
    btn.classList.remove('cm-copied', 'cm-del-btn');
  };
  const toDelete = () => {
    mode = 'delete';
    setBtnIcon(btn, ICON_TRASH, 'Delete');
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
    setBtnIcon(btn, ICON_CHECK, 'Copied');
    btn.classList.add('cm-copied');
    setTimeout(toCopy, 1200);
  });

  attachLongPress(holdTarget, toDelete);
  return btn;
}
