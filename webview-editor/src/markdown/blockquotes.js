import { Decoration } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { decoPlugin, decoRanges } from './viewPlugin.js';
import { c } from '../theme/palette.js';

/**
 * Obsidian-style blockquotes: a continuous accent bar down the left edge of
 * every line in a `>` block, with the ends rounded. The raw `>` markers are
 * hidden by the live-preview layer; this just paints the bar + tint.
 */
function buildBlockquotes(view) {
  const { state } = view;
  const lines = new Set();
  for (const { from, to } of decoRanges(view)) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: node => {
        if (node.name !== 'Blockquote') return;
        const start = state.doc.lineAt(node.from).number;
        const end = state.doc.lineAt(node.to).number;
        for (let ln = start; ln <= end; ln++) lines.add(ln);
      },
    });
  }
  const marks = [];
  for (const ln of [...lines].sort((a, b) => a - b)) {
    let cls = 'cm-blockquote';
    // Round the ends where the quote starts/stops (nested quotes share a bar).
    if (!lines.has(ln - 1)) cls += ' cm-blockquote-first';
    if (!lines.has(ln + 1)) cls += ' cm-blockquote-last';
    marks.push(Decoration.line({ class: cls }).range(state.doc.line(ln).from));
  }
  return Decoration.set(marks, true);
}

export const blockquotes = decoPlugin(buildBlockquotes);

// A continuous accent bar down the left, muted text, and a faint surface tint.
// The raw `>` markers are hidden in live preview (see SYNTAX_MARKS).
export const styles = {
  '.cm-blockquote': {
    backgroundColor: c.mantle,
    borderLeft: `3px solid ${c.mauve}`,
    color: c.subtext0,
    paddingLeft: '16px',
  },
  '.cm-blockquote-first': {
    paddingTop: '3px',
    borderTopRightRadius: '8px',
  },
  '.cm-blockquote-last': {
    paddingBottom: '3px',
    borderBottomRightRadius: '8px',
  },
};
