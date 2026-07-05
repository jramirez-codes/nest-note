import { ViewPlugin, Decoration } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
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
 * TWO WAYS TO GET <indent>, because the marker column varies with the proportional
 * font, nesting depth, and the "•"/checkbox widgets:
 *
 *  1. EDITABLE views measure it from the rendered layout (coordsAtPos) — exact.
 *     This needs a post-layout measure pass, which is applied by a follow-up
 *     dispatch. That's fine here: focus + typing keep the frame loop flushing
 *     measures and repainting.
 *
 *  2. READ-ONLY views (subject notebooks seeded by __setReadOnly + __setDoc, /ask
 *     answer cards) can't use (1): they get no caret, no typing, no tap, so after
 *     the WebView's first paint the frame loop idles and the measure never flushes
 *     — and even if it did, an idle Android WebView won't repaint an internal async
 *     change until it's touched. So the wrapped rows stayed flush-left until the
 *     first tap. Instead we ESTIMATE the indent synchronously with canvas
 *     measureText (no DOM/layout needed) and emit the decoration inside update(),
 *     so it rides in the SAME transaction as the seeded content — exactly how the
 *     other decorations (livePreview bullets, code cards, quotes) paint on first
 *     render. A couple of sub-pixels off the exact layout is imperceptible and far
 *     better than no indent at all.
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

// Dispatched (editable path only) to force a re-render once freshly measured
// indents are ready; no state field consumes it — it just makes the transaction
// produce a view update so the plugin's new `decorations` are picked up.
const refresh = StateEffect.define();

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
      // Read-only views may already be seeded by the time this runs; editable
      // views start empty and measure lazily.
      this.decorations = view.state.readOnly ? buildDeco(this.estimate()) : Decoration.none;
      if (!view.state.readOnly) this.schedule();
    }

    update(u) {
      const relevant =
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state);
      if (u.state.readOnly) {
        // Synchronous, canvas-based estimate emitted in-update so it paints with
        // the content (see file header). No measure pass, no follow-up dispatch.
        if (relevant) this.set(this.estimate());
      } else if (relevant || u.geometryChanged) {
        // Editable: exact layout measurement, applied via a follow-up dispatch.
        this.schedule();
      }
    }

    // Set `decorations` from freshly computed rows, if they changed. Called from
    // update() (read-only estimate) — no dispatch needed, CM reads the field for
    // this same transaction.
    set(rows) {
      const sig = rows.map(r => r.from + ':' + r.indent).join(',');
      if (sig === this.sig) return;
      this.sig = sig;
      this.decorations = buildDeco(rows);
    }

    // --- Read-only estimate (canvas measureText, no layout) -------------------
    estimate() {
      const view = this.view;
      const { state } = view;
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
          if (LIST_PREFIX.test(line.text) && !inCode(state, line.from)) {
            const indent = this.prefixWidth(line.text, fs, w);
            if (indent > 0) rows.push({ from: line.from, indent });
          }
          pos = line.to + 1;
        }
      }
      return rows;
    }

    // Pixel width of the rendered prefix (whitespace + marker/checkbox + spaces),
    // matching what livePreview paints, via canvas advances.
    prefixWidth(text, fs, w) {
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

    // --- Editable exact measurement (coordsAtPos, needs layout) ----------------
    // A subject page's editor is CONSTRUCTED editable (empty), so the constructor
    // queues one of these measures; it then flips read-only (via __setReadOnly)
    // and is seeded. When that stale measure finally fires it must NOT run: a
    // read-only view's frame never properly flushes, so read() would get empty
    // coords and apply() would wipe the synchronous estimate — the exact bug that
    // left the indent gone until the first tap (while the /ask answer view, which
    // is read-only from construction and so never queues a measure, worked). Once
    // read-only, the estimate owns the decorations.
    schedule() {
      if (this.view.state.readOnly) return;
      this.view.requestMeasure({
        key: this,
        read: () => this.read(),
        write: rows => this.apply(rows),
      });
    }

    read() {
      const view = this.view;
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

    apply(rows) {
      // Guard the same stale-measure case as schedule(): if the view went
      // read-only after this measure was queued, the estimate is authoritative —
      // don't let a late DOM read clobber it.
      if (this.view.state.readOnly) return;
      const sig = rows.map(r => r.from + ':' + r.indent).join(',');
      if (sig === this.sig) return;
      this.sig = sig;
      this.decorations = buildDeco(rows);
      // Measurement ran in a measure pass; dispatch out of it so CM re-reads the
      // updated decorations. Guarded by the signature so a stable layout is quiet.
      this.view.dispatch({ effects: refresh.of(null) });
    }
  },
  { decorations: v => v.decorations },
);
