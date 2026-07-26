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
export function makeComposer({ footClass, inputClass, placeholder, draftKey, onSubmit, buttons = [] }) {
  const foot = document.createElement('div');
  foot.className = footClass;

  const input = document.createElement('input');
  input.className = inputClass;
  input.type = 'text';
  input.placeholder = placeholder;
  const submit = () => {
    onSubmit(input);
    syncDraft(draftKey, input);
  };
  guardInput(input, submit);
  // Covers dictation as well as typing — dictateIntoInput sets .value and fires
  // a synthetic `input` event for exactly this reason.
  input.addEventListener('input', () => syncDraft(draftKey, input));
  // Adopt any text typed into this card's other box before it was mounted.
  bindDraft(draftKey, input);
  foot.appendChild(input);

  for (const spec of buttons) {
    foot.appendChild(makeButton(spec, submit));
  }
  return foot;
}

function makeButton({ tag = 'button', className, icon, title, label, submit, onTap }, doSubmit) {
  const el = document.createElement(tag);
  el.className = className;
  el.innerHTML = icon;
  if (title) el.title = title;
  if (label) el.setAttribute('aria-label', label);
  return guardTaps(el, submit ? doSubmit : onTap);
}
