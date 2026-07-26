import { c } from '../../theme/palette.js';
import { guardTaps } from '../../ui/events.js';
import { deleteCardLine } from '../marker.js';

// The /update server card: a compact status chip for a paired-laptop self-update
// (fetch → rebuild → restart). Like the /pair chip it only reflects status the RN
// side commits back via __aiDone — running (⏳) while pulling/rebuilding/restarting,
// ok (✅) once the server reconnects, error (⚠️) if a step failed. When output is
// present (a build log, especially on failure) it's shown beneath in a <pre>.
export function renderUpdate(view, widget) {
  const obj = widget.obj;
  const status = obj.status || 'running';
  const card = document.createElement('div');
  card.className =
    'cm-ask cm-ask-update' +
    (status === 'error' ? ' cm-ask-error' : status === 'ok' ? ' cm-ask-update-ok' : '');

  const row = document.createElement('div');
  row.className = 'cm-update-row';

  const icon = document.createElement('span');
  icon.textContent = status === 'ok' ? '✅' : status === 'error' ? '⚠️' : '⏳';
  row.appendChild(icon);

  const text = document.createElement('span');
  text.className = 'cm-update-msg';
  text.textContent =
    obj.msg ||
    (status === 'ok'
      ? 'Server updated'
      : status === 'error'
        ? 'Update failed'
        : 'Updating server…');
  row.appendChild(text);

  const del = document.createElement('span');
  del.className = 'cm-ask-del';
  del.textContent = '×';
  del.style.marginLeft = 'auto';
  guardTaps(del, () => deleteCardLine(view, card));
  row.appendChild(del);

  card.appendChild(row);

  if (obj.out && obj.out.trim()) {
    const pre = document.createElement('pre');
    pre.className = 'cm-update-out';
    pre.textContent = obj.out.trim();
    card.appendChild(pre);
  }
  return card;
}

export const styles = {
  '.cm-ask-update': {
    padding: '9px 12px',
    fontSize: '13px',
    color: c.subtext0,
    maxWidth: '640px',
  },
  '.cm-ask-update.cm-ask-error': { color: c.red },
  '.cm-ask-update-ok': { color: c.green, borderColor: c.green },
  '.cm-update-row': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  '.cm-update-msg': {
    flex: '1',
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '.cm-update-out': {
    margin: '8px 0 0 0',
    padding: '8px 10px',
    borderRadius: '8px',
    backgroundColor: c.crust,
    color: c.subtext0,
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    fontSize: '11.5px',
    lineHeight: '1.4',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '220px',
    overflow: 'auto',
  },
};
