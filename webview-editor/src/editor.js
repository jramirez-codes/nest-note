import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { autocompletion } from '@codemirror/autocomplete';

import { theme, highlight } from './theme.js';
import { post } from './bridge.js';
import {
  previewField,
  askLiveField,
  setPreviewEffect,
  setAskLive,
  clearAskLive,
  cachePreview,
} from './state.js';
import { broadcastPreview } from './answerView.js';
import { cardField, previewFetcher } from './cards.js';
import { livePreview } from './livePreview.js';
import { codeBlocks, codeLanguages } from './codeBlocks.js';
import { blockquotes } from './blockquotes.js';
import { openLinks } from './links.js';
import { slashCommandSource, aiCommandOnEnter } from './commands.js';
import { encodeAiMarker, findAiLine } from './aiMarker.js';

/**
 * The CodeMirror 6 markdown editor that runs inside the React Native WebView.
 * The pieces live in sibling modules (theme, widgets, cards, live-preview,
 * commands, …); this entry point just assembles them and owns the RN bridge.
 *
 * Source-mode markdown (the document is plain markdown text — the app's storage
 * format, so no data migration). On top of syntax highlighting it adds
 * Obsidian-style live-preview decorations, interactive task checkboxes, link /
 * image / code cards, and the /ask + /pair AI cards.
 *
 * Bridge with the RN side is JSON messages over `window.ReactNativeWebView`:
 *   RN → web:  window.__setDoc / __setPreview / __aiStream / __aiDone
 *   web → RN:  { type: 'ready' } once mounted, { type: 'change', text } on edits.
 */

const extensions = [
  history(),
  // Highest precedence Enter: intercept slash commands before the newline.
  keymap.of([{ key: 'Enter', run: aiCommandOnEnter }]),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  autocompletion({
    override: [slashCommandSource],
    icons: false,
    activateOnTyping: true,
    aboveCursor: false,
  }),
  openLinks,
  markdown({ base: markdownLanguage, codeLanguages }),
  syntaxHighlighting(highlight),
  previewField,
  askLiveField,
  cardField,
  previewFetcher,
  codeBlocks,
  blockquotes,
  livePreview,
  theme,
  EditorView.lineWrapping,
  EditorView.updateListener.of(u => {
    if (u.docChanged) post({ type: 'change', text: u.state.doc.toString() });
  }),
];

const view = new EditorView({
  parent: document.getElementById('root'),
  state: EditorState.create({ doc: '', extensions }),
});

// RN calls this (via injectJavaScript) to seed / replace the document without
// losing the editor instance.
window.__setDoc = function (text) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text ?? '' },
  });
};

// RN calls this (via injectJavaScript) once it has fetched a link's metadata;
// the card for that URL then re-renders from the loading state.
window.__setPreview = function (url, data) {
  // Cache so answer views mounted later can seed from it, update the main
  // editor, and push into any open answer views.
  cachePreview(url, data);
  view.dispatch({ effects: setPreviewEffect.of({ url, data }) });
  broadcastPreview(url, data);
};

// RN streams answer chunks here as they arrive from the server. This updates a
// live field only (no document change), so the answer grows in place without
// disturbing the caret or triggering a save on every token.
window.__aiStream = function (id, answer) {
  view.dispatch({ effects: setAskLive.of({ id, a: answer, status: 'streaming' }) });
};

// RN calls this once a run finishes (or a pairing resolves): the outcome is
// committed to the document (so it persists) and the live entry is cleared.
// `patch` merges into the marker payload, e.g. { a, status:'done' } for an
// answer or { status:'ok'|'error', msg } for pairing.
window.__aiDone = function (id, patch) {
  const found = findAiLine(view.state, id);
  const effects = [clearAskLive.of(id)];
  if (!found) {
    view.dispatch({ effects });
    return;
  }
  view.dispatch({
    changes: {
      from: found.from,
      to: found.to,
      insert: encodeAiMarker({ ...found.obj, ...patch }),
    },
    effects,
  });
};

post({ type: 'ready' });
