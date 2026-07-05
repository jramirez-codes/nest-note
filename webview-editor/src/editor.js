import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Prec, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  markdown,
  markdownLanguage,
  insertNewlineContinueMarkupCommand,
} from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { autocompletion } from '@codemirror/autocomplete';

import { theme, highlight } from './theme.js';
import { post } from './bridge.js';
import {
  previewField,
  askLiveField,
  recPlayField,
  setPreviewEffect,
  setAskLive,
  clearAskLive,
  setRecPlay,
  cachePreview,
} from './state.js';
import { broadcastPreview } from './answerView.js';
import { wholeDocDeco } from './viewPlugin.js';
import { cardField, previewFetcher } from './cards.js';
import { livePreview } from './livePreview.js';
import { listIndent } from './listIndent.js';
import { codeBlocks, codeLanguages } from './codeBlocks.js';
import { blockquotes } from './blockquotes.js';
import { openLinks } from './links.js';
import { WikiLink } from './wikilinks.js';
import { slashCommandSource, aiCommandOnEnter } from './commands.js';
import { lineStartReplace } from './lineStartReplace.js';
import { encodeAiMarker, findAiLine, mergeAiDone } from './aiMarker.js';

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

// Enter that continues list / blockquote markup onto the new line. `markdown()`
// binds this by default, but its default config, on an EMPTY list item, loosens
// a tight list by inserting a blank line (`- item`⏎`- `⏎ → `- item`, blank, `- `)
// — the stray "extra line" a note-taker never wants. `nonTightLists: false`
// forces the other branch: an empty item + Enter deletes the marker and exits
// the list, matching Obsidian/Notion. Bound above `markdown()`'s own high-prec
// binding (below) so ours wins for lists.
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

// Normalize freshly-typed `*` / `+` bullet markers to `-` so asterisk/plus lists
// behave EXACTLY like dash lists (which already work perfectly). `*` doubles as
// the emphasis marker, so the incremental parser treats `* `-lists more
// ambiguously than `- `-lists — the source of the stray-bullet flicker and the
// list-continuation edge cases. Rewriting the marker to `-` at input time
// sidesteps all of it; CommonMark treats -, *, + as identical bullets, so it's
// lossless. Only a marker followed by whitespace is touched (`* x`, `* `), which
// CommonMark guarantees is a bullet — never emphasis (`*x*`, `**x**`, a lone
// `*`). Runs as a transaction filter so the `*` is swapped before it paints (no
// flash), and only over changed lines (no full-doc scan).
const THEMATIC_BREAK = /^\s*(?:[-*+]\s*){3,}$/;
const normalizeBulletMarkers = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged) return tr;
  const extra = [];
  const doc = tr.newDoc;
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const first = doc.lineAt(fromB).number;
    const last = doc.lineAt(toB).number;
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      const m = /^(\s*)([*+])\s/.exec(line.text);
      if (!m) continue;
      if (THEMATIC_BREAK.test(line.text)) continue; // "* * *" / "***" divider
      if (/^\s*[*+]\s+[-*+]/.test(line.text)) continue; // divider in progress
      const at = line.from + m[1].length;
      extra.push({ from: at, to: at + 1, insert: '-' });
    }
  });
  return extra.length ? [tr, { changes: extra, sequential: true }] : tr;
});

// Editability is compartmentalized so RN can flip a page to read-only. Subject-notebook
// pages pulled from the server are viewable but not editable on the phone — only the local
// Sandbox is edited — so those pages call window.__setReadOnly(true) after seeding content.
const editableConf = new Compartment();

const extensions = [
  editableConf.of([]),
  normalizeBulletMarkers,
  history(),
  // Highest-precedence Enter: intercept slash commands first (they turn into
  // cards), then continue/exit list & quote markup, before the plain newline.
  Prec.highest(
    keymap.of([
      { key: 'Enter', run: aiCommandOnEnter },
      { key: 'Enter', run: continueMarkup },
    ]),
  ),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  lineStartReplace,
  autocompletion({
    override: [slashCommandSource],
    icons: false,
    activateOnTyping: true,
    aboveCursor: false,
  }),
  openLinks,
  markdown({ base: markdownLanguage, codeLanguages, extensions: [WikiLink] }),
  syntaxHighlighting(highlight),
  previewField,
  askLiveField,
  recPlayField,
  cardField,
  previewFetcher,
  codeBlocks,
  blockquotes,
  livePreview,
  listIndent,
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

// RN calls this to make the page read-only (subject-notebook pages) or editable again
// (the Sandbox). Read-only turns off contentEditable so there's no caret or typing, and
// sets EditorState.readOnly so plugins/commands treat it as immutable; __setDoc still works
// (programmatic dispatches aren't blocked), so RN can seed the fetched content either way.
//
// It also flips on wholeDocDeco: a read-only page never gets the caret/scroll interaction
// that measures a viewport, so with the default visible-range scan the live-preview
// decorations wouldn't build until the first tap. Scanning the whole doc (as the /ask
// answer views already do) renders the parsed markdown immediately on the first paint.
// RN applies this BEFORE __setDoc so the seeding transaction already scans whole-doc.
window.__setReadOnly = function (on) {
  view.dispatch({
    effects: editableConf.reconfigure(
      on
        ? [
            EditorView.editable.of(false),
            EditorState.readOnly.of(true),
            wholeDocDeco.of(true),
          ]
        : [],
    ),
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

// RN toggles a /record card's playback state here (no document change): true when
// its clip starts playing, false on pause or when the clip ends. The card's
// play/pause button reflects it.
window.__recPlay = function (id, playing) {
  view.dispatch({ effects: setRecPlay.of({ id, playing: !!playing }) });
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
      insert: encodeAiMarker(mergeAiDone(found.obj, patch)),
    },
    effects,
  });
};

// RN calls this when a /clean run finishes: swap the whole document for the
// cleaned text, stashing the original as a backup inside a `review` marker that
// renders the Accept / Reject bar. It's a single dispatch, so a plain undo also
// restores the original in one step.
window.__cleanApply = function (id, cleaned) {
  const found = findAiLine(view.state, id);
  if (!found) return;
  // Backup = the current document minus the clean marker block (i.e. the page
  // text as it stands now), so edits made while cleaning are preserved on reject.
  const before = view.state.doc.sliceString(0, found.from);
  const after = view.state.doc.sliceString(found.to);
  const backup = (before + after).replace(/^\n+|\n+$/g, '');
  const marker = encodeAiMarker({ v: 1, kind: 'clean', id, status: 'review', backup });
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: marker + '\n' + cleaned },
  });
};

post({ type: 'ready' });
