import { Decoration, EditorView, ViewPlugin, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/**
 * The CodeMirror 6 markdown editor that runs inside the React Native WebView.
 *
 * Source-mode markdown (the document is plain markdown text — the app's storage
 * format, so no data migration). This first milestone gives syntax highlighting;
 * Obsidian-style live-preview decorations and custom widgets are the next layer,
 * and they slot in here as CM6 decoration/widget extensions.
 *
 * Bridge with the RN side is JSON messages over `window.ReactNativeWebView`:
 *   RN → web:  window.__setDoc(markdown)   (called via injectJavaScript)
 *   web → RN:  { type: 'ready' } once mounted, { type: 'change', text } on edits.
 */

// Catppuccin Mocha, matched to the app theme.
const c = {
  base: '#1e1e2e',
  text: '#cdd6f4',
  subtext0: '#a6adc8',
  overlay1: '#7f849c',
  mauve: '#cba6f7',
  blue: '#89b4fa',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  red: '#f38ba8',
  surface0: '#313244',
};

const theme = EditorView.theme(
  {
    '&': { color: c.text, backgroundColor: c.base, fontSize: '17px' },
    '.cm-content': {
      fontFamily: '-apple-system, Roboto, sans-serif',
      lineHeight: '1.5',
      padding: '8px 24px 120px',
      caretColor: c.mauve,
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: c.mauve },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: c.surface0,
    },
    '.cm-scroller': { overflow: 'auto' },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true },
);

// How markdown tokens are painted. Syntax marks (#, *, `) are dimmed like
// Obsidian; headings are larger and bold; emphasis is rendered.
const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.8em', fontWeight: 'bold', color: c.text },
  { tag: t.heading2, fontSize: '1.5em', fontWeight: 'bold', color: c.text },
  { tag: t.heading3, fontSize: '1.25em', fontWeight: 'bold', color: c.text },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: 'bold', color: c.text },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: c.blue, textDecoration: 'underline' },
  { tag: t.url, color: c.blue },
  { tag: [t.monospace], color: c.green, fontFamily: 'monospace' },
  { tag: t.quote, color: c.subtext0 },
  { tag: t.list, color: c.mauve },
  // The literal syntax punctuation (#, *, -, `, >) — dimmed.
  { tag: [t.processingInstruction, t.meta], color: c.overlay1 },
]);

function post(msg) {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
}

/**
 * Obsidian-style live preview: hide the markdown syntax punctuation so the text
 * renders "clean", but reveal it again on whichever line(s) the cursor/selection
 * is on, so it stays fully editable. Implemented as CM6 replace-decorations
 * derived from the Lezer markdown tree.
 */
const HIDE = Decoration.replace({});
// Lezer node names for the punctuation we hide (inline emphasis/code/strike and
// the leading `#` of headings). List bullets and quote bars are left visible.
const SYNTAX_MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'StrikethroughMark',
]);

function buildLivePreview(view) {
  const { state } = view;
  // Every line touched by a selection stays "revealed" (syntax shown).
  const activeLines = new Set();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }

  const marks = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: node => {
        if (!SYNTAX_MARKS.has(node.name)) return;
        if (activeLines.has(state.doc.lineAt(node.from).number)) return;
        let end = node.to;
        // Also swallow the space after a heading's `#` so text isn't inset.
        if (node.name === 'HeaderMark' && state.doc.sliceString(end, end + 1) === ' ') {
          end += 1;
        }
        if (end > node.from) marks.push(HIDE.range(node.from, end));
      },
    });
  }
  return Decoration.set(marks, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildLivePreview(view);
    }
    update(u) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildLivePreview(u.view);
      }
    }
  },
  { decorations: v => v.decorations },
);

const extensions = [
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  markdown({ base: markdownLanguage }),
  syntaxHighlighting(highlight),
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

post({ type: 'ready' });
