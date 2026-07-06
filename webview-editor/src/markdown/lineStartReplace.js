import { EditorView } from '@codemirror/view';

/**
 * First-character-on-a-line shortcuts. When the caret sits at column 0 and the
 * user types one of these keys, swap it for the matching symbol before it lands
 * in the document. Typed anywhere else on the line, the key is left untouched.
 *
 * Runs off CodeMirror's `inputHandler`, so it only fires on genuine user typing
 * (not paste, undo, or programmatic edits) and costs a single O(1) map lookup —
 * no document scanning, no per-update work.
 */
const REPLACEMENTS = {
  '1': '/',
  '2': '@',
  '3': '#',
  '8': '*',
};

export const lineStartReplace = EditorView.inputHandler.of((view, from, to, text) => {
  const insert = REPLACEMENTS[text];
  // Only keys we map, and only when the replacement actually differs (3→3 falls
  // through to normal typing).
  if (insert === undefined || insert === text) return false;
  // Only a plain caret (no selection) typing at the very start of a line.
  if (from !== to || view.state.doc.lineAt(from).from !== from) return false;

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: 'input.type',
    scrollIntoView: true,
  });
  return true;
});
