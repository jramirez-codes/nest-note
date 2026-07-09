// Fire `cb` when the user presses and holds on `el` for ~500ms without dragging.
// Works for touch (the mobile WebView) and mouse. The click that a press-release
// would otherwise emit is swallowed (capture phase) so a long-press to reveal
// the delete button doesn't also toggle/open the widget underneath.
export function attachLongPress(el, cb) {
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
