import { EditorView } from '@codemirror/view';
import { EditorState, Annotation } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { highlight, answerTheme } from './theme.js';
import { previewField, askLiveField, setPreviewEffect } from './state.js';
import { cardField, previewFetcher } from './cards.js';
import { codeBlocks, codeLanguages } from './codeBlocks.js';
import { livePreview } from './livePreview.js';
import { blockquotes } from './blockquotes.js';
import { openLinks } from './links.js';
import { wholeDocDeco } from './viewPlugin.js';

// Every mounted answer view, so fetched link previews can be pushed into them.
const answerViews = new Set();

// The one kind of doc change we permit into an otherwise read-only answer view:
// the streaming card appending freshly arrived tokens (see AiCardWidget.updateDOM).
// Everything else — user edits, checkbox/card widget mutations — is still vetoed.
export const streamAppend = Annotation.define();

/**
 * Render an LLM answer as read-only markdown in a nested CodeMirror view, so it
 * gets the SAME rendering as the note (headings, lists, code cards, blockquotes,
 * links, link-preview cards, images) but can't be edited. Links tap through to
 * RN via the openLinks handler.
 *
 * Returns the view so the caller can unmountAnswerView() it when the card DOM
 * is removed.
 */
export function mountAnswerView(parent, text, { trim = true } = {}) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      // Trim trailing whitespace/newlines — otherwise a final "\n" renders as an
      // empty last line, which looks like stray padding under the answer. While
      // streaming we skip the trim so token appends stay a cheap end-insert.
      doc: trim ? (text || '').replace(/\s+$/, '') : text || '',
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
        // Scan the whole answer for decorations — this view is auto-height, so
        // CM can't measure a scroll viewport and visibleRanges would be empty.
        wholeDocDeco.of(true),
        answerTheme,
        EditorView.lineWrapping,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        // Hard stop: even the reused checkbox/card widgets can't mutate this view.
        // The lone exception is the streaming card's own token appends, tagged
        // with streamAppend, so the answer can grow while it's still arriving.
        EditorState.changeFilter.of(tr => tr.annotation(streamAppend) === true),
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
