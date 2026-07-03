import { ViewPlugin } from '@codemirror/view';

/**
 * A ViewPlugin whose decorations are (re)built by `build(view)`. Rebuilds on
 * document and viewport changes, plus selection changes when `selection: true`
 * (the live-preview layer needs those to reveal/hide raw markdown at the
 * caret). Removes the repeated boilerplate shared by our decoration plugins.
 */
export function decoPlugin(build, { selection = false } = {}) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = build(view);
      }
      update(u) {
        if (u.docChanged || u.viewportChanged || (selection && u.selectionSet)) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: v => v.decorations },
  );
}
