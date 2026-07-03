import { ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { Facet } from '@codemirror/state';

/**
 * When enabled, decoration builders scan the WHOLE document instead of just
 * `view.visibleRanges`. The /ask answer views are auto-height with an
 * `overflow: visible` scroller, so CM can't measure a scroll viewport for them —
 * `visibleRanges` comes back empty in a real browser and none of the live-preview
 * decorations (hidden syntax marks, `[title](url)` links, code/quote styling) get
 * built. Answers are small, so scanning the full doc is cheap and reliable. The
 * main editor leaves this off and keeps the visible-range optimisation.
 */
export const wholeDocDeco = Facet.define({ combine: vs => vs.some(Boolean) });

/** The ranges a decoration builder should scan for the given view. */
export function decoRanges(view) {
  return view.state.facet(wholeDocDeco)
    ? [{ from: 0, to: view.state.doc.length }]
    : view.visibleRanges;
}

/**
 * A ViewPlugin whose decorations are (re)built by `build(view)`. Rebuilds on
 * document and viewport changes, plus selection changes when `selection: true`
 * (the live-preview layer needs those to reveal/hide raw markdown at the
 * caret). Removes the repeated boilerplate shared by our decoration plugins.
 *
 * It also rebuilds whenever the syntax tree changes. Markdown is parsed lazily
 * in the background, so the tree keeps filling in after the doc is set — via
 * transactions that are neither doc nor viewport changes. Without this, a static
 * read-only view (the /ask answer preview never scrolls or edits) freezes on
 * whatever partial tree existed at mount, leaving e.g. `[title](url)` links
 * un-decorated. The main editor masked this because typing/scrolling re-triggered
 * a rebuild; the answer view never does.
 */
export function decoPlugin(build, { selection = false } = {}) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = build(view);
      }
      update(u) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          (selection && u.selectionSet) ||
          syntaxTree(u.startState) !== syntaxTree(u.state)
        ) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: v => v.decorations },
  );
}
