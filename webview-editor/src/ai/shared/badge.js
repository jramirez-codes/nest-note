import { c } from '../../theme/palette.js';

// Paint the status badge shared by the /run + /code cards and their overlay: a
// pulsing dot while live, then the exit code (run) / "done" (code) / "error" /
// "stopped" (killed by signal → negative exit code). One rule set, so a card and
// its expanded view can never show a different status.
export function applyRunBadge(badge, { kind, status, code }) {
  badge.className = 'cm-run-badge';
  if (status === 'running') {
    badge.classList.add('cm-run-badge-live');
    badge.textContent = '●';
  } else if (status === 'error') {
    badge.classList.add('cm-run-badge-err');
    badge.textContent = 'error';
  } else if (kind === 'code') {
    badge.classList.add('cm-run-badge-ok');
    badge.textContent = 'done';
  } else if (code != null && code < 0) {
    // Negative code = killed by signal (Stop) — read as "stopped", not "exit -1".
    badge.classList.add('cm-run-badge-err');
    badge.textContent = 'stopped';
  } else {
    badge.classList.add(code === 0 ? 'cm-run-badge-ok' : 'cm-run-badge-err');
    badge.textContent = 'exit ' + (code == null ? '?' : code);
  }
  return badge;
}

export const styles = {
  '.cm-run-badge': {
    flexShrink: '0',
    fontSize: '11px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    color: c.overlay1,
    alignSelf: 'center',
  },
  '.cm-run-badge-live': { color: c.green, animation: 'cm-ask-blink 1.2s infinite both' },
  '.cm-run-badge-ok': { color: c.green },
  '.cm-run-badge-err': { color: c.red },
};
