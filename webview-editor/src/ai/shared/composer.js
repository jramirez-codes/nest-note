import { guardInput, guardTaps } from '../../ui/events.js';

// One footer factory for every card composer: the /chat follow-up box, the /run
// stdin box, and the /code prompt box — plus their equivalents in the full-page
// overlay. It builds a guarded text input (Enter runs the primary submit) and a
// row of trailing buttons.
//
//   makeComposer({ footClass, inputClass, placeholder, onSubmit, buttons })
//
// `onSubmit(input)` receives the input element so the caller owns its exact
// submit logic (trim vs. raw, skip-empty, clear, dispatch). Each button spec is
// `{ tag?, className, icon, title?, label?, submit?, onTap? }`: `submit: true`
// wires the button to the same primary submit as Enter; otherwise `onTap` runs.
export function makeComposer({ footClass, inputClass, placeholder, onSubmit, buttons = [] }) {
  const foot = document.createElement('div');
  foot.className = footClass;

  const input = document.createElement('input');
  input.className = inputClass;
  input.type = 'text';
  input.placeholder = placeholder;
  const submit = () => onSubmit(input);
  guardInput(input, submit);
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
