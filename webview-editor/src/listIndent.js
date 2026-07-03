import { ViewPlugin, Decoration } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { decoRanges } from './viewPlugin.js';

/**
 * Hanging indent for list items. When a bullet / checkbox / ordered-list line
 * soft-wraps, the continuation rows should line up under where the item's *text*
 * begins on the first row (like a real `<li>`), not fall back to the left margin.
 *
 * The editor font is proportional and the marker column varies (nesting depth,
 * the "•"/checkbox widget, multi-digit numbers), so the indent can't be a fixed
 * value — it's measured from the rendered layout. For each visible list line we
 * read the x-offset where the text starts and apply:
 *
 *     padding-left: <indent>;  text-indent: -<indent>;
 *
 * The negative text-indent pulls the first row (marker included) back to the
 * margin, so the first row's geometry is unchanged; padding-left is what the
 * wrapped rows honour. Because the first row doesn't move, re-measuring yields
 * the same indent — the computation is stable and doesn't feed back on itself.
 */

// Leading indent + marker (`-`/`*`/`+` or `1.`/`1)`), the space after it, and an
// optional task checkbox — everything before the item's text. Requires at least
// one non-space char of text (the lookahead) so a bare, still-empty marker line
// isn't indented.
const LIST_PREFIX = /^\s*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(?=\S)/;

// Dispatched only to force a re-render once freshly measured indents are ready;
// no state field consumes it — it just makes the transaction produce a view
// update so the plugin's new `decorations` are picked up.
const refresh = StateEffect.define();

// True when `pos` sits inside a fenced/indented code block, where a `- ` line is
// code, not a list item.
function inCode(state, pos) {
  for (let n = syntaxTree(state).resolve(pos, 1); n; n = n.parent) {
    if (/Code/.test(n.name)) return true;
  }
  return false;
}

export const listIndent = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = Decoration.none;
      this.sig = '';
      this.schedule(view);
    }

    update(u) {
      if (u.docChanged || u.viewportChanged || u.geometryChanged) {
        this.schedule(u.view);
      }
    }

    schedule(view) {
      view.requestMeasure({
        key: this,
        read: () => this.read(view),
        write: rows => this.write(view, rows),
      });
    }

    read(view) {
      const { state } = view;
      const rows = [];
      for (const { from, to } of decoRanges(view)) {
        for (let pos = from; pos <= to; ) {
          const line = state.doc.lineAt(pos);
          const m = LIST_PREFIX.exec(line.text);
          if (m && !inCode(state, line.from)) {
            const start = view.coordsAtPos(line.from);
            const text = view.coordsAtPos(line.from + m[0].length);
            if (start && text) {
              const indent = Math.round(text.left - start.left);
              if (indent > 0) rows.push({ from: line.from, indent });
            }
          }
          pos = line.to + 1;
        }
      }
      return rows;
    }

    write(view, rows) {
      const sig = rows.map(r => r.from + ':' + r.indent).join(',');
      if (sig === this.sig) return;
      this.sig = sig;
      this.decorations = Decoration.set(
        rows.map(({ from, indent }) =>
          Decoration.line({
            attributes: {
              // `!important` to beat the theme's `.cm-line{padding:0 !important}`
              // (an inline !important still wins over a stylesheet one).
              style: `padding-left:${indent}px!important;text-indent:-${indent}px`,
            },
          }).range(from),
        ),
        true,
      );
      // The measurement ran in a measure pass; dispatch out of it so CM re-reads
      // the updated decorations. Guarded by the signature above so a stable
      // layout doesn't keep firing.
      view.dispatch({ effects: refresh.of(null) });
    }
  },
  { decorations: v => v.decorations },
);
