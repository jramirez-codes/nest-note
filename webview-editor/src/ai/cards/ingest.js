import { deleteCardLine } from '../marker.js';
import { thinkingDots } from '../shared/thinking.js';
import { cleanButton } from './clean.js';

// The /ingest chip: a slim status bar while the page is being sorted into the
// dashboard's subject servers. On success the RN side deletes the whole page, so
// this card vanishes with it — there is no "done" state to render. On error the
// page is left intact and the chip offers a Dismiss. Reuses the /clean styles.
export function renderIngest(view, widget) {
  const obj = widget.obj;
  const status = obj.status || 'streaming';
  const card = document.createElement('div');
  card.className = 'cm-ask cm-clean' + (status === 'error' ? ' cm-ask-error' : '');

  const icon = document.createElement('span');
  icon.className = 'cm-clean-icon';
  icon.textContent = status === 'error' ? '⚠️' : '📥';
  card.appendChild(icon);

  const text = document.createElement('span');
  text.className = 'cm-clean-text';
  card.appendChild(text);

  if (status === 'error') {
    text.textContent = obj.msg || 'Ingest failed — your notes are untouched.';
    card.appendChild(cleanButton('Dismiss', 'cm-clean-reject', () => deleteCardLine(view, card)));
  } else {
    text.textContent = obj.msg || 'Sorting into your dashboard…';
    card.appendChild(thinkingDots({ tag: 'span', className: 'cm-ask-thinking cm-clean-dots' }));
  }
  return card;
}
