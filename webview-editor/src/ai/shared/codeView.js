import { c } from '../../theme/palette.js';
import { FILE, FILE_EDIT, EYE } from '../../ui/icons.js';

// A little editor-style code pane for the /code transcript: a header bar naming
// the file (with a tool glyph + status pill) and a scrolling body whose left
// gutter carries line numbers, exactly like a coding editor. It renders three
// shapes — a plain file view (Write/Read) numbered 1..N, and a two-gutter unified
// diff (Edit/MultiEdit) with the old line numbers on the left, the new on the
// right, and +/- rails. Long lines scroll horizontally while the gutter stays
// pinned (position: sticky), never wrapping — the real-editor feel the card wants.

const MAX_ROWS = 400; // cap a pane so a huge file can't blow up the transcript

// Split into lines but drop a single trailing newline's empty tail so an N-line
// file shows N rows, not N+1.
function toLines(s) {
  const t = String(s == null ? '' : s);
  if (t === '') return [];
  const lines = t.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// A capped, horizontally-scrolling code body. `rows` is a list of
// { oldNo, newNo, mark, text, cls } — mark is '', '+', or '-'; cls tints the row.
function buildBody(rows, { twoGutter }) {
  const body = document.createElement('div');
  body.className = 'cm-cv-body';
  const clipped = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;
  for (const r of clipped) {
    const row = document.createElement('div');
    row.className = 'cm-cv-row' + (r.cls ? ' ' + r.cls : '');
    if (twoGutter) {
      const oldN = document.createElement('span');
      oldN.className = 'cm-cv-num cm-cv-num-old';
      oldN.textContent = r.oldNo == null ? '' : String(r.oldNo);
      row.appendChild(oldN);
    }
    const num = document.createElement('span');
    num.className = 'cm-cv-num';
    num.textContent = r.newNo == null ? '' : String(r.newNo);
    row.appendChild(num);
    const mark = document.createElement('span');
    mark.className = 'cm-cv-mark';
    mark.textContent = r.mark || ' ';
    row.appendChild(mark);
    const code = document.createElement('span');
    code.className = 'cm-cv-code';
    code.textContent = r.text === '' ? '​' : r.text; // keep blank rows tall
    row.appendChild(code);
    body.appendChild(row);
  }
  if (rows.length > MAX_ROWS) {
    const more = document.createElement('div');
    more.className = 'cm-cv-more';
    more.textContent = '… ' + (rows.length - MAX_ROWS) + ' more lines';
    body.appendChild(more);
  }
  return body;
}

// The header bar: tool glyph, file path (basename bold, dir muted), status pill.
function buildHead(icon, filePath, pill) {
  const head = document.createElement('div');
  head.className = 'cm-cv-head';
  const ic = document.createElement('span');
  ic.className = 'cm-cv-ico';
  ic.innerHTML = icon;
  head.appendChild(ic);

  const path = String(filePath || '');
  const slash = path.lastIndexOf('/');
  const name = document.createElement('span');
  name.className = 'cm-cv-name';
  if (slash >= 0) {
    const dir = document.createElement('span');
    dir.className = 'cm-cv-dir';
    // Wrapped in a bdi/rtl clip so a long directory ellipsises at its FRONT,
    // keeping the segment nearest the file — and the basename — always in view.
    dir.textContent = path.slice(0, slash + 1);
    name.appendChild(dir);
  }
  const base = document.createElement('span');
  base.className = 'cm-cv-base';
  base.textContent = slash >= 0 ? path.slice(slash + 1) : path;
  name.appendChild(base);
  name.title = path;
  head.appendChild(name);

  if (pill) {
    const spacer = document.createElement('span');
    spacer.className = 'cm-cv-spacer';
    head.appendChild(spacer);
    const p = document.createElement('span');
    p.className = 'cm-cv-pill ' + (pill.cls || '');
    p.textContent = pill.text;
    head.appendChild(p);
  }
  return head;
}

function paneFor(icon, filePath, pill, rows, opts) {
  const pane = document.createElement('div');
  pane.className = 'cm-cv';
  pane.appendChild(buildHead(icon, filePath, pill));
  pane.appendChild(buildBody(rows, opts || {}));
  return pane;
}

// A plain, numbered file view (Write's new content, or a Read's returned body).
// `firstLine` sets the number of the first row (Read output starts mid-file).
export function renderFileView(filePath, content, { icon, pill, firstLine } = {}) {
  const start = firstLine || 1;
  const rows = toLines(content).map((text, i) => ({ newNo: start + i, mark: '', text }));
  return paneFor(icon || FILE, filePath, pill, rows, {});
}

// A unified line diff of old→new (Edit / MultiEdit). Uses an LCS over lines so
// shared context stays put and only genuine changes get a +/- rail.
export function renderDiffView(filePath, oldStr, newStr, { pill } = {}) {
  const rows = diffRows(toLines(oldStr), toLines(newStr));
  return paneFor(FILE_EDIT, filePath, pill, rows, { twoGutter: true });
}

// LCS line diff → rows with two gutters (old line no / new line no) and marks.
function diffRows(a, b) {
  const n = a.length;
  const m = b.length;
  // DP table of LCS lengths (small hunks — n,m are edit fragments, not whole files).
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  let addN = 0;
  let delN = 0;
  const push = (mark, text, oldNo, newNo) =>
    rows.push({
      mark,
      text,
      oldNo,
      newNo,
      cls: mark === '+' ? 'cm-cv-add' : mark === '-' ? 'cm-cv-del' : '',
    });
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('', a[i], i + 1, j + 1);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('-', a[i], i + 1, null);
      delN++;
      i++;
    } else {
      push('+', b[j], null, j + 1);
      addN++;
      j++;
    }
  }
  while (i < n) {
    push('-', a[i], i + 1, null);
    delN++;
    i++;
  }
  while (j < m) {
    push('+', b[j], null, j + 1);
    addN++;
    j++;
  }
  diffRows._last = { addN, delN };
  return rows;
}

// Count adds/dels for a diff without rendering (used to label the header pill).
export function diffCounts(oldStr, newStr) {
  diffRows(toLines(oldStr), toLines(newStr));
  return diffRows._last || { addN: 0, delN: 0 };
}

export { EYE };

const NUM_W = '40px';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export const styles = {
  // The editor pane: a self-contained card with a header bar and a code body.
  '.cm-cv': {
    borderRadius: '9px',
    overflow: 'hidden',
    border: `1px solid ${c.surface0}`,
    backgroundColor: c.crust,
  },
  '.cm-cv-head': {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    padding: '6px 10px',
    backgroundColor: c.mantle,
    borderBottom: `1px solid ${c.surface0}`,
  },
  '.cm-cv-ico': { display: 'flex', flexShrink: '0', color: c.overlay1 },
  '.cm-cv-ico svg': { width: '14px', height: '14px' },
  '.cm-cv-name': {
    display: 'flex',
    alignItems: 'baseline',
    minWidth: '0',
    fontFamily: MONO,
    fontSize: '12px',
    fontWeight: '600',
    color: c.text,
  },
  // The directory shrinks and clips its FRONT (direction: rtl), so the tail
  // segment nearest the basename survives; the basename itself never shrinks.
  '.cm-cv-dir': {
    flexShrink: '1',
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    direction: 'rtl',
    color: c.overlay1,
    fontWeight: '400',
  },
  '.cm-cv-base': { flexShrink: '0', whiteSpace: 'nowrap' },
  '.cm-cv-spacer': { flex: '1', minWidth: '8px' },
  '.cm-cv-pill': {
    flexShrink: '0',
    padding: '1px 8px',
    borderRadius: '99px',
    fontFamily: MONO,
    fontSize: '10.5px',
    fontWeight: '700',
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
    color: c.crust,
    backgroundColor: c.overlay1,
  },
  '.cm-cv-pill.cm-cv-pill-new': { backgroundColor: c.green },
  '.cm-cv-pill.cm-cv-pill-edit': { backgroundColor: c.yellow },
  '.cm-cv-pill.cm-cv-pill-read': { backgroundColor: c.blue },

  // The scrolling code body. Rows lay out as flex so the gutter can stick left
  // while long code scrolls under it.
  '.cm-cv-body': {
    overflowX: 'auto',
    overflowY: 'auto',
    maxHeight: '360px',
    padding: '4px 0',
    WebkitOverflowScrolling: 'touch',
  },
  '.cm-cv-row': {
    display: 'flex',
    alignItems: 'stretch',
    width: 'max-content',
    minWidth: '100%',
    lineHeight: '1.55',
  },
  '.cm-cv-num': {
    flexShrink: '0',
    position: 'sticky',
    left: '0',
    boxSizing: 'border-box',
    width: NUM_W,
    padding: '0 8px 0 0',
    textAlign: 'right',
    fontFamily: MONO,
    fontSize: '11px',
    color: c.surface1,
    backgroundColor: c.crust,
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  '.cm-cv-num-old': { left: '0', width: NUM_W },
  // When both gutters show, the second (new) number sticks just right of the old.
  '.cm-cv-row .cm-cv-num-old + .cm-cv-num': { left: NUM_W },
  '.cm-cv-mark': {
    flexShrink: '0',
    width: '14px',
    textAlign: 'center',
    fontFamily: MONO,
    fontSize: '11.5px',
    color: c.overlay1,
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  '.cm-cv-code': {
    flex: '1',
    padding: '0 12px 0 4px',
    fontFamily: MONO,
    fontSize: '11.5px',
    color: c.subtext0,
    whiteSpace: 'pre',
    tabSize: '2',
  },
  // Diff tints — a coloured wash across the whole row plus a matching gutter.
  '.cm-cv-add': { backgroundColor: 'rgba(166,227,161,0.10)' },
  '.cm-cv-add .cm-cv-mark': { color: c.green },
  '.cm-cv-add .cm-cv-code': { color: c.green },
  '.cm-cv-add .cm-cv-num': { color: c.green, backgroundColor: 'rgba(166,227,161,0.10)' },
  '.cm-cv-del': { backgroundColor: 'rgba(243,139,168,0.10)' },
  '.cm-cv-del .cm-cv-mark': { color: c.red },
  '.cm-cv-del .cm-cv-code': { color: c.red },
  '.cm-cv-del .cm-cv-num': { color: c.red, backgroundColor: 'rgba(243,139,168,0.10)' },
  '.cm-cv-more': {
    padding: '4px 12px',
    fontFamily: MONO,
    fontSize: '11px',
    fontStyle: 'italic',
    color: c.overlay1,
  },
};
