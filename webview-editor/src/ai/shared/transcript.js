import { c } from '../../theme/palette.js';

// One-line summary of a tool's input for the compact call row (objects → JSON).
function shortenInput(input) {
  let s = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

// Build the DOM for one /code transcript block. Assistant prose is handled by
// the caller (it mounts a nested markdown answer view); this renders the compact,
// muted rows — user prompts, tool calls and tool results. Shared by the /code
// card body and its full-page overlay, so both render a transcript identically.
export function renderCodeItem(item) {
  if (item.type === 'user') {
    const el = document.createElement('div');
    el.className = 'cm-code-user';
    el.textContent = item.text || '';
    return el;
  }
  if (item.type === 'tool') {
    const el = document.createElement('div');
    el.className = 'cm-code-tool';
    const name = document.createElement('span');
    name.className = 'cm-code-tool-name';
    name.textContent = '⚙ ' + (item.name || 'tool');
    el.appendChild(name);
    const arg = shortenInput(item.input);
    if (arg) {
      const args = document.createElement('span');
      args.className = 'cm-code-tool-args';
      args.textContent = ' ' + arg;
      el.appendChild(args);
    }
    return el;
  }
  if (item.type === 'result') {
    const el = document.createElement('div');
    el.className = 'cm-code-result' + (item.isError ? ' cm-code-result-err' : '');
    const text = (item.text || '').replace(/\s+$/, '');
    el.textContent = text.length > 600 ? text.slice(0, 600) + '…' : text;
    return el;
  }
  // Assistant prose (fallback — normally the caller mounts a markdown view).
  const el = document.createElement('div');
  el.className = 'cm-code-text';
  el.textContent = item.text || '';
  return el;
}

export const styles = {
  // A prompt the user sent — set off with an accent rail on the left.
  '.cm-code-user': {
    padding: '6px 10px',
    borderLeft: `2px solid ${c.mauve}`,
    color: c.text,
    fontSize: '14px',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  // Assistant prose — wraps a nested read-only markdown view (mountAnswerView),
  // so it renders like the /ask answer. Only spacing lives here; the nested
  // view's answerTheme owns typography.
  '.cm-code-text': {
    padding: '0 2px',
  },
  // A tool call: monospace, muted, the name accented.
  '.cm-code-tool': {
    padding: '5px 10px',
    borderRadius: '7px',
    backgroundColor: c.mantle,
    color: c.subtext0,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '12px',
    lineHeight: '1.4',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  '.cm-code-tool-name': { color: c.yellow, fontWeight: '600' },
  '.cm-code-tool-args': { color: c.overlay1 },
  // A tool result: dimmer, in the crust well like the terminal log.
  '.cm-code-result': {
    padding: '6px 10px',
    backgroundColor: c.crust,
    border: `1px solid ${c.surface0}`,
    borderRadius: '7px',
    color: c.subtext0,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11.5px',
    lineHeight: '1.45',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  '.cm-code-result-err': { color: c.red, borderColor: c.red },
};
