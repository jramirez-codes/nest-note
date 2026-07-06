// Pointer/keyboard guards shared by every interactive card control. Inside CM's
// contenteditable content, a raw tap would move the caret or toggle the card, so
// controls must claim their own events before they bubble.

// Make `el` a tappable control: swallow the surrounding editor's mousedown/click
// (which would move the caret or open the card) and run `fn` on tap. Returns el
// so it composes inline. Note the touchstart is passive + stop-only — we must NOT
// preventDefault it, or the emulated click never fires and the control is dead.
export function guardTaps(el, fn) {
  el.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
  });
  el.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
  el.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  });
  return el;
}

// Make `el` an atomic, non-editable island and hard-block text selection: on
// Android a long-press would otherwise begin selecting the card's own text
// (firing `selectstart`), hijacking the hold-to-delete gesture. Belt to the CSS
// `user-select: none` — some WebView builds still start selection without it.
// Used by the /record, /run and /code cards and the full-page overlay.
export function blockSelection(el) {
  el.setAttribute('contenteditable', 'false');
  el.addEventListener('selectstart', e => e.preventDefault());
  return el;
}

// Wire a text `input` inside a card footer: keep its pointer/key events off CM
// (which would move the caret or toggle the card) while typing normally, and run
// `onEnter` when Enter is pressed.
export function guardInput(input, onEnter) {
  const stop = e => e.stopPropagation();
  input.addEventListener('mousedown', stop);
  input.addEventListener('touchstart', stop, { passive: true });
  input.addEventListener('click', stop);
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      onEnter();
    }
  });
  return input;
}
