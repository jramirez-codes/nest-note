import { c } from '../../theme/palette.js';
import { guardTaps } from '../../ui/events.js';
import { deleteCardLine } from '../marker.js';

// The /pair chip: a compact connection status line (pending / connected / failed)
// with a dismiss ×. The actual pairing handshake lives on the RN side; this only
// reflects the status RN commits back via __aiDone and offers to remove itself.
export function renderPair(view, widget) {
  const obj = widget.obj;
  const status = obj.status || 'pending';
  const card = document.createElement('div');
  card.className =
    'cm-ask cm-ask-pair' +
    (status === 'error' ? ' cm-ask-error' : status === 'ok' ? ' cm-ask-pair-ok' : '');

  const icon = document.createElement('span');
  icon.textContent = status === 'ok' ? '🔗' : status === 'error' ? '⚠️' : '⏳';
  card.appendChild(icon);

  const text = document.createElement('span');
  text.textContent =
    obj.msg ||
    (status === 'ok' ? 'Connected' : status === 'error' ? 'Pairing failed' : 'Pairing…');
  card.appendChild(text);

  const del = document.createElement('span');
  del.className = 'cm-ask-del';
  del.textContent = '×';
  del.style.marginLeft = 'auto';
  guardTaps(del, () => deleteCardLine(view, card));
  card.appendChild(del);
  return card;
}

export const styles = {
  '.cm-ask-pair': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '9px 12px',
    fontSize: '13px',
    color: c.subtext0,
    maxWidth: '640px',
  },
  '.cm-ask-pair.cm-ask-error': { color: c.red },
  '.cm-ask-pair-ok': { color: c.green, borderColor: c.green },
};
