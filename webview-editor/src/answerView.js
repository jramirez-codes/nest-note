import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { highlight, answerTheme } from './theme.js';
import { previewField, askLiveField, setPreviewEffect } from './state.js';
import { cardField, previewFetcher } from './cards.js';
import { codeBlocks, codeLanguages } from './codeBlocks.js';
import { livePreview } from './livePreview.js';
import { blockquotes } from './blockquotes.js';
import { openLinks } from './links.js';

// Every mounted answer view, so fetched link previews can be pushed into them.
const answerViews = new Set();

/**
 * Render an LLM answer as read-only markdown in a nested CodeMirror view, so it
 * gets the SAME rendering as the note (headings, lists, code cards, blockquotes,
 * links, link-preview cards, images) but can't be edited. Links tap through to
 * RN via the openLinks handler.
 *
 * Returns the view so the caller can unmountAnswerView() it when the card DOM
 * is removed.
 */
export function mountAnswerView(parent, text) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      // Trim trailing whitespace/newlines — otherwise a final "\n" renders as an
      // empty last line, which looks like stray padding under the answer.
      doc: (text || '').replace(/\s+$/, ''),
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages }),
        syntaxHighlighting(highlight),
        openLinks,
        previewField,
        askLiveField,
        cardField,
        previewFetcher,
        livePreview,
        codeBlocks,
        blockquotes,
        answerTheme,
        EditorView.lineWrapping,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        // Hard stop: even the reused checkbox/card widgets can't mutate this view.
        EditorState.changeFilter.of(() => false),
      ],
    }),
  });
  answerViews.add(view);
  // Built detached (the card isn't in the document yet); re-measure once it is
  // so line heights/wrapping are correct.
  requestAnimationFrame(() => view.requestMeasure());
  return view;
}

export function unmountAnswerView(view) {
  if (!view) return;
  answerViews.delete(view);
  view.destroy();
}

// Push a freshly fetched preview into every open answer view (the main editor is
// updated separately). Called from window.__setPreview in editor.js.
export function broadcastPreview(url, data) {
  for (const view of answerViews) {
    view.dispatch({ effects: setPreviewEffect.of({ url, data }) });
  }
}
