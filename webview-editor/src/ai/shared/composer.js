import { guardInput, guardTaps } from '../../ui/events.js';
import { bindDraft, syncDraft } from './drafts.js';

// One footer factory for every card composer: the /chat follow-up box, the /run
// stdin box, and the /code prompt box — plus their equivalents in the full-page
// overlay. It builds a guarded text input (Enter runs the primary submit) and a
// row of trailing buttons.
//
//   makeComposer({ footClass, inputClass, placeholder, draftKey, onSubmit, buttons })
//
// `onSubmit(input)` receives the input element so the caller owns its exact
// submit logic (trim vs. raw, skip-empty, clear, dispatch). Each button spec is
// `{ tag?, className, icon, title?, label?, submit?, onTap? }`: `submit: true`
// wires the button to the same primary submit as Enter; otherwise `onTap` runs.
//
// `draftKey` (the card's id) ties this box to any other box for the same card —
// its twin in the full-page overlay — so unsent text survives expanding and
// closing that page, and every rebuild of the card in between (see drafts.js).
// Because the store mirrors on every keystroke, the write-back after onSubmit is
// what clears it: a handler that cleared the box clears the draft, and one that
// bailed on empty input leaves it alone.
//
// The box is a one-row <textarea>, not an <input>: a long question has to wrap
// onto more lines and push the box taller, instead of scrolling out of sight
// past the right edge. Enter still submits (guardInput preventDefaults it), so
// the textarea never takes a literal newline — it only ever wraps.
export function makeComposer({ footClass, inputClass, placeholder, draftKey, onSubmit, buttons = [] }) {
  const foot = document.createElement('div');
  foot.className = footClass;

  const input = document.createElement('textarea');
  input.className = inputClass;
  input.rows = 1;
  input.placeholder = placeholder;
  // Re-measure after a submit too: onSubmit clears the box (no `input` event of
  // its own), so without this the emptied composer would keep its grown height.
  const submit = () => {
    onSubmit(input);
    syncDraft(draftKey, input);
    autoGrow(input);
  };
  guardInput(input, submit);
  // Covers dictation as well as typing — dictateIntoInput sets .value and fires
  // a synthetic `input` event for exactly this reason.
  input.addEventListener('input', () => {
    syncDraft(draftKey, input);
    autoGrow(input);
  });
  // Adopt any text typed into this card's other box before it was mounted.
  // The box isn't in the DOM yet, so autoGrow can't measure it here — a restored
  // multi-line draft is sized on the next frame, once it has laid out.
  bindDraft(draftKey, input, () => autoGrow(input));
  if (input.value) requestAnimationFrame(() => autoGrow(input));
  foot.appendChild(input);

  for (const spec of buttons) {
    foot.appendChild(makeButton(spec, submit));
  }
  return foot;
}

// Size the box to its wrapped content so every line the user typed stays
// visible. `height: auto` first so it can shrink back after a delete or a
// submit; the border-box height is the content height (scrollHeight already
// includes the padding) plus the borders. `.cm-ask-followup`'s max-height caps
// the growth and turns on the box's own scrollbar past that point.
function autoGrow(el) {
  el.style.height = 'auto';
  const cs = getComputedStyle(el);
  const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  el.style.height = el.scrollHeight + border + 'px';
}

function makeButton({ tag = 'button', className, icon, title, label, submit, onTap }, doSubmit) {
  const el = document.createElement(tag);
  el.className = className;
  el.innerHTML = icon;
  if (title) el.title = title;
  if (label) el.setAttribute('aria-label', label);
  return guardTaps(el, submit ? doSubmit : onTap);
}
