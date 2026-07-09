import { c } from '../../theme/palette.js';
import { guardTaps } from '../../ui/events.js';
import { deleteCardLine, restoreCleanBackup } from '../marker.js';
import { thinkingDots } from '../shared/thinking.js';

// A card button that keeps its taps away from CM and runs `onTap` on click.
// Exported so the /ingest chip can reuse the same Dismiss button.
export function cleanButton(label, cls, onTap) {
  const btn = document.createElement('button');
  btn.className = 'cm-clean-btn ' + cls;
  btn.textContent = label;
  return guardTaps(btn, onTap);
}

// The /clean bar: a slim status chip while the page is being rewritten, then an
// Accept / Reject review bar once the cleaned text has replaced the doc. Accept
// drops this marker (keeping the new text); Reject restores the backup.
export function renderClean(view, widget) {
  const obj = widget.obj;
  const status = obj.status || 'review';
  const card = document.createElement('div');
  card.className =
    'cm-ask cm-clean' +
    (status === 'error' ? ' cm-ask-error' : status === 'review' ? ' cm-clean-review' : '');

  const icon = document.createElement('span');
  icon.className = 'cm-clean-icon';
  icon.textContent = status === 'error' ? '⚠️' : '✨';
  card.appendChild(icon);

  const text = document.createElement('span');
  text.className = 'cm-clean-text';
  card.appendChild(text);

  if (status === 'streaming') {
    text.textContent = obj.msg || 'Cleaning up your notes…';
    card.appendChild(thinkingDots({ tag: 'span', className: 'cm-ask-thinking cm-clean-dots' }));
  } else if (status === 'error') {
    text.textContent = obj.msg || 'Cleanup failed.';
    card.appendChild(cleanButton('Dismiss', 'cm-clean-reject', () => deleteCardLine(view, card)));
  } else {
    text.textContent = 'Cleaned up — review the changes';
    const actions = document.createElement('span');
    actions.className = 'cm-clean-actions';
    actions.appendChild(
      cleanButton('Reject', 'cm-clean-reject', () => restoreCleanBackup(view, card)),
    );
    actions.appendChild(
      cleanButton('Accept', 'cm-clean-accept', () => deleteCardLine(view, card)),
    );
    card.appendChild(actions);
  }
  return card;
}

export const styles = {
  '.cm-clean': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '9px 12px',
    fontSize: '13px',
    color: c.subtext0,
    maxWidth: '640px',
  },
  '.cm-clean-review': {
    borderColor: c.mauve,
    backgroundColor: c.surface0,
    color: c.text,
  },
  '.cm-clean-icon': { flexShrink: '0', fontSize: '14px' },
  '.cm-clean-text': { flex: '1', minWidth: '0' },
  '.cm-clean-dots': { flexShrink: '0', paddingTop: '0' },
  '.cm-clean-actions': { flexShrink: '0', display: 'flex', gap: '8px' },
  '.cm-clean-btn': {
    fontFamily: '-apple-system, Roboto, sans-serif',
    fontSize: '13px',
    fontWeight: '600',
    padding: '6px 14px',
    borderRadius: '8px',
    border: 'none',
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-clean-accept': { color: c.base, backgroundColor: c.green },
  '.cm-clean-reject': { color: c.subtext0, backgroundColor: c.surface1 },
};
