import { c } from '../../theme/palette.js';
import { mountAnswerView } from '../answerView.js';
import { renderFileView, renderDiffView, diffCounts, EYE } from './codeView.js';

// Build one /code transcript block for the virtualized list (shared/blockList).
// Assistant prose mounts a nested read-only markdown view (returned so it can be
// torn down when the block scrolls out); everything else is a static row from
// renderCodeItem. Used by the /code card body and its full-page overlay.
export function mountCodeBlock(item, prev, streaming) {
  if (item.type === 'text') {
    const box = document.createElement('div');
    box.className = 'cm-code-text';
    // While streaming, skip the trailing trim so token appends stay a cheap
    // end-insert (matches the old inline mount path).
    const view = mountAnswerView(box, item.text || '', { trim: !streaming });
    return { node: box, view };
  }
  return { node: renderCodeItem(item, prev), view: null };
}

// A cheap height guess (px) for a block that has never been mounted — used only
// for a transcript restored from disk, since a live session mounts every block at
// birth (bottom of the log, in view) and measures it before it scrolls away.
export function estimateCodeBlock(item) {
  if (item.type === 'tool') return 32;
  const t = item.text || '';
  const lines = t.split('\n').length + Math.ceil(t.length / 60);
  if (item.type === 'user') return 24 + Math.min(lines, 12) * 22;
  return 24 + Math.min(lines, 400) * 19;
}

// One-line summary of a tool's input for the compact call row (objects → JSON).
function shortenInput(input) {
  let s = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

// Normalise a tool name to its bare form (Claude's tools arrive plain, but MCP
// tools come namespaced like "mcp__x__Edit") so the file-tool switch is robust.
function baseName(name) {
  const s = String(name || '');
  const parts = s.split('__');
  return parts[parts.length - 1] || s;
}

// Tool input arrives as an object, but a defensive JSON string is possible.
function asObj(input) {
  if (input && typeof input === 'object') return input;
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }
  return null;
}

// Read output is `cat -n` style — lines like "␣␣␣␣␣12→text" or "␣␣12\ttext". If a
// result looks like that, peel the numbers off so we can re-render our own gutter
// starting at the file's real first line.
function parseNumbered(text) {
  const lines = String(text || '').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return null;
  const re = /^\s*(\d+)[\t→]/;
  let matched = 0;
  let first = null;
  const stripped = [];
  for (const ln of lines) {
    const m = ln.match(re);
    if (m) {
      matched++;
      if (first == null) first = parseInt(m[1], 10);
      stripped.push(ln.replace(re, ''));
    } else {
      stripped.push(ln);
    }
  }
  // Require most lines to carry a number (guards against ordinary prose output).
  if (matched < Math.max(2, lines.length * 0.6)) return null;
  return { first: first || 1, text: stripped.join('\n') };
}

// Build the DOM for one /code transcript block. Assistant prose is handled by
// the caller (it mounts a nested markdown answer view); this renders everything
// else — user prompts, tool calls (file tools get an editor-style pane) and
// results. Shared by the /code card body and its full-page overlay.
export function renderCodeItem(item, prev) {
  if (item.type === 'user') {
    const el = document.createElement('div');
    el.className = 'cm-code-user';
    el.textContent = item.text || '';
    return el;
  }
  if (item.type === 'tool') {
    const pane = fileToolPane(item);
    if (pane) return pane;
    return compactTool(item);
  }
  if (item.type === 'result') {
    const numbered = parseNumbered(item.text);
    // A numbered result following a Read call is the file's content — render it
    // as a read-only editor pane, borrowing the path from that Read call.
    if (numbered && !item.isError && prev && prev.type === 'tool' && baseName(prev.name) === 'Read') {
      const file = (asObj(prev.input) || {}).file_path || '';
      return renderFileView(file, numbered.text, {
        icon: EYE,
        pill: { text: 'read', cls: 'cm-cv-pill-read' },
        firstLine: numbered.first,
      });
    }
    return compactResult(item);
  }
  // Assistant prose (fallback — normally the caller mounts a markdown view).
  const el = document.createElement('div');
  el.className = 'cm-code-text';
  el.textContent = item.text || '';
  return el;
}

// If this tool call touches a file, render it as an editor pane; else return null
// so the caller falls back to the compact row.
function fileToolPane(item) {
  const name = baseName(item.name);
  const input = asObj(item.input);
  if (!input) return null;
  const file = input.file_path || input.path || input.notebook_path || '';
  if (name === 'Write') {
    return renderFileView(file, input.content ?? '', {
      pill: { text: 'created', cls: 'cm-cv-pill-new' },
    });
  }
  if (name === 'Edit' || name === 'NotebookEdit') {
    const oldS = input.old_string ?? input.old_source ?? '';
    const newS = input.new_string ?? input.new_source ?? '';
    const { addN, delN } = diffCounts(oldS, newS);
    return renderDiffView(file, oldS, newS, {
      pill: { text: `+${addN} -${delN}`, cls: 'cm-cv-pill-edit' },
    });
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const frag = document.createDocumentFragment();
    let addN = 0;
    let delN = 0;
    input.edits.forEach(e => {
      const cnt = diffCounts(e.old_string ?? '', e.new_string ?? '');
      addN += cnt.addN;
      delN += cnt.delN;
    });
    frag.appendChild(
      renderDiffView(
        file,
        input.edits.map(e => e.old_string ?? '').join('\n'),
        input.edits.map(e => e.new_string ?? '').join('\n'),
        { pill: { text: `+${addN} -${delN}`, cls: 'cm-cv-pill-edit' } },
      ),
    );
    return frag;
  }
  if (name === 'Read') {
    // The content lands in the following result; show a slim "read" header here.
    const el = document.createElement('div');
    el.className = 'cm-code-read';
    const ico = document.createElement('span');
    ico.className = 'cm-code-read-ico';
    ico.innerHTML = EYE;
    el.appendChild(ico);
    const label = document.createElement('span');
    label.textContent = file || 'file';
    el.appendChild(label);
    return el;
  }
  return null;
}

// A non-file tool call: monospace, muted, the name accented.
function compactTool(item) {
  const el = document.createElement('div');
  el.className = 'cm-code-tool';
  const name = document.createElement('span');
  name.className = 'cm-code-tool-name';
  name.textContent = baseName(item.name) || 'tool';
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

// A plain tool result: dimmer, in the crust well like the terminal log.
function compactResult(item) {
  const el = document.createElement('div');
  el.className = 'cm-code-result' + (item.isError ? ' cm-code-result-err' : '');
  const text = (item.text || '').replace(/\s+$/, '');
  el.textContent = text.length > 600 ? text.slice(0, 600) + '…' : text;
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
  // A Read call, before its content pane arrives: a slim eye + path chip.
  '.cm-code-read': {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    padding: '4px 10px',
    color: c.overlay1,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11.5px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-code-read-ico': { display: 'flex', flexShrink: '0', color: c.blue },
  '.cm-code-read-ico svg': { width: '13px', height: '13px' },
  // A tool call: monospace, muted, the name accented.
  '.cm-code-tool': {
    display: 'flex',
    alignItems: 'baseline',
    gap: '2px',
    padding: '5px 10px',
    borderRadius: '7px',
    backgroundColor: c.mantle,
    color: c.subtext0,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '12px',
    lineHeight: '1.4',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  },
  '.cm-code-tool-name': { color: c.yellow, fontWeight: '600', flexShrink: '0' },
  '.cm-code-tool-args': {
    color: c.overlay1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
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
