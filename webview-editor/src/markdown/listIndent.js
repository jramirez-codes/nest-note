import { ViewPlugin, Decoration } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { decoRanges } from './viewPlugin.js';

/**
 * Hanging indent for list items. When a bullet / checkbox / ordered-list line
 * soft-wraps, the continuation rows should line up under where the item's *text*
 * begins on the first row (like a real `<li>`), not fall back to the left margin.
 * Applied per line as:
 *
 *     padding-left: <indent>;  text-indent: -<indent>;
 *
 * The negative text-indent pulls the first row (marker included) back to the
 * margin, so the first row's geometry is unchanged; padding-left is what the
 * wrapped rows honour.
 *
 * HOW <indent> IS COMPUTED — synchronously, from the text, with canvas
 * measureText (no DOM/layout). This runs inside update() so the decoration rides
 * in the SAME transaction as the edit/seed, exactly like the other decorations
 * (livePreview bullets, code cards, quotes) — so it paints on the FIRST render.
 *
 * The earlier approach measured the rendered layout (coordsAtPos), which is
 * pixel-exact but can only be applied by a follow-up dispatch after layout. On an
 * EDITABLE view that self-heals (focus/typing keep flushing), but on a READ-ONLY
 * view (subject notebooks seeded by __setReadOnly + __setDoc, /ask answer cards)
 * nothing flushes the measure and an idle Android WebView won't even repaint an
 * internal async change until it's touched — so wrapped rows stayed flush-left
 * until the first tap. And on editable pages the very first paint had the same
 * gap before the user interacted. Measuring synchronously from text sidesteps all
 * of it; a sub-pixel off the exact layout is imperceptible.
 *
 * The rendered prefix depends on live-preview state: on the line(s) under the
 * cursor livePreview REVEALS the raw markdown (`- `, `[ ]`) so it stays editable,
 * elsewhere it swaps in the "•" dot / checkbox widget. We mirror that here — raw
 * text width on active lines, widget-metric width otherwise — and recompute on
 * selection changes so the indent tracks the caret. Read-only views never reveal,
 * so every line uses the widget metrics.
 */

// Leading indent + marker (`-`/`*`/`+` or `1.`/`1)`), the space after it, and an
// optional task checkbox — everything before the item's text. Requires at least
// one non-space char of text (the lookahead) so a bare, still-empty marker line
// isn't indented.
const LIST_PREFIX = /^\s*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(?=\S)/;

// Rendered marker metrics, in em, mirrored from theme.js so the estimate matches
// what livePreview actually paints:
//   .cm-bullet { font-size: 1.1em }                       → the "•" dot
//   .cm-task   { width: 1.05em; margin-right: 0.3em }     → the checkbox box
const BULLET_EM = 1.1;
const CHECKBOX_EM = 1.05 + 0.3;

// One shared offscreen canvas for text measurement (no layout, unlike coordsAtPos).
let CANVAS;
function measurer() {
  if (!CANVAS) CANVAS = document.createElement('canvas').getContext('2d');
  return CANVAS;
}

// True when `pos` sits inside a fenced/indented code block, where a `- ` line is
// code, not a list item.
function inCode(state, pos) {
  for (let n = syntaxTree(state).resolve(pos, 1); n; n = n.parent) {
    if (/Code/.test(n.name)) return true;
  }
  return false;
}

function buildDeco(rows) {
  return Decoration.set(
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
}

export const listIndent = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.sig = '';
      this.decorations = buildDeco(this.compute());
    }

    update(u) {
      // Recompute when the text, the visible range, the caret (which line renders
      // raw vs. widgets), or the parse (code-block detection) changes — the same
      // triggers livePreview reacts to, so the two stay in lock-step.
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.set(this.compute());
      }
    }

    // Assign fresh decorations if the indents changed. Called from update(), so no
    // dispatch is needed — CM reads `this.decorations` for this same transaction.
    set(rows) {
      const sig = rows.map(r => r.from + ':' + r.indent).join(',');
      if (sig === this.sig) return;
      this.sig = sig;
      this.decorations = buildDeco(rows);
    }

    compute() {
      const view = this.view;
      const { state } = view;

      // Lines under the selection show raw markdown (editable views only), so their
      // prefix is measured as plain text, not as the "•"/checkbox widgets.
      const active = new Set();
      if (!state.readOnly) {
        for (const r of state.selection.ranges) {
          const first = state.doc.lineAt(r.from).number;
          const last = state.doc.lineAt(r.to).number;
          for (let n = first; n <= last; n++) active.add(n);
        }
      }

      const cs = getComputedStyle(view.contentDOM);
      const fs = parseFloat(cs.fontSize) || 17;
      const fam = cs.fontFamily || 'sans-serif';
      const ctx = measurer();
      const w = (s, size) => {
        ctx.font = `${size}px ${fam}`;
        return ctx.measureText(s).width;
      };

      const rows = [];
      for (const { from, to } of decoRanges(view)) {
        for (let pos = from; pos <= to; ) {
          const line = state.doc.lineAt(pos);
          const m = LIST_PREFIX.exec(line.text);
          if (m && !inCode(state, line.from)) {
            const indent = active.has(line.number)
              ? Math.round(w(m[0], fs)) // raw markdown revealed — plain text width
              : this.widgetWidth(line.text, fs, w); // "•"/checkbox rendering
            if (indent > 0) rows.push({ from: line.from, indent });
          }
          pos = line.to + 1;
        }
      }
      return rows;
    }

    // Pixel width of the prefix as livePreview renders it (whitespace + "•" dot or
    // checkbox box + trailing spaces), via canvas advances.
    widgetWidth(text, fs, w) {
      const lead = /^[ \t]*/.exec(text)[0];
      const rest = text.slice(lead.length);
      let indent = w(lead, fs);

      const task = /^[-*+][ \t]+\[[ xX]\]([ \t]+)/.exec(rest);
      const bullet = /^[-*+]([ \t]+)/.exec(rest);
      const ordered = /^(\d+[.)])([ \t]+)/.exec(rest);
      if (task) {
        // "- " + "[ ]" collapse to the checkbox box (+ its right margin); the
        // spaces AFTER "]" survive as normal text.
        indent += fs * CHECKBOX_EM + w(task[1], fs);
      } else if (bullet) {
        // "-" renders as a "•" dot at 1.1em; the spaces after it survive.
        indent += w('•', fs * BULLET_EM) + w(bullet[1], fs);
      } else if (ordered) {
        // "1." / "12)" are left as raw text — measure them as-is.
        indent += w(ordered[1] + ordered[2], fs);
      } else {
        return 0;
      }
      return Math.round(indent);
    }
  },
  { decorations: v => v.decorations },
);
