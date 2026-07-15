import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Prec, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  markdown,
  markdownLanguage,
  insertNewlineContinueMarkupCommand,
} from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { autocompletion, startCompletion } from '@codemirror/autocomplete';

import { theme, highlight } from './theme/index.js';
import { post } from './bridge.js';
import {
  previewField,
  askLiveField,
  recPlayField,
  runLiveField,
  setPreviewEffect,
  setAskLive,
  clearAskLive,
  setRecPlay,
  setRunLog,
  clearRunLog,
  codeLiveField,
  appendCodeEvent,
  clearCodeLive,
  viewLiveField,
  setViewUrl,
  cachePreview,
  payloadField,
  setPayload,
  setPayloads,
} from './state.js';
import { broadcastPreview } from './ai/answerView.js';
import { wholeDocDeco } from './markdown/viewPlugin.js';
import { cardField, previewFetcher, viewFetcher } from './ai/cardField.js';
import { livePreview } from './markdown/livePreview.js';
import { listIndent } from './markdown/listIndent.js';
import { codeBlocks, codeLanguages } from './markdown/codeBlocks.js';
import { blockquotes } from './markdown/blockquotes.js';
import { openLinks } from './markdown/links.js';
import { WikiLink } from './markdown/wikilinks.js';
import {
  slashCommandSource,
  codeProjectSource,
  runProjectSource,
  deleteProjectSource,
  talkSubjectSource,
  aggTasksSubjectSource,
  searchSource,
  setCodeProjects,
  setTalkSubjects,
  setSearchResults,
  aiCommandOnEnter,
} from './ai/commands.js';
import { lineStartReplace } from './markdown/lineStartReplace.js';
import {
  encodeAiMarker,
  findAiLine,
  mergeAiDone,
  eachAiLine,
  migrateInlineMarkers,
  decodePayload,
  bodyFromObj,
  encodePayload,
  EXTERNAL_KINDS,
  isChatKind,
} from './ai/marker.js';
import { refreshOpenOverlay, closeOverlay } from './ai/overlay.js';

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

// Android's Gboard treats a spellcheck/autocorrect underline as an in-progress
// composition. When the user selects text that overlaps one and hits the
// keyboard's delete key, Chrome sometimes reports the deletion as a 1-character
// `beforeinput` (as if committing/clearing the composition) instead of one
// covering the whole selection — CM then only removes that one character. This
// is the same class of bug the `1`→`/` line-start shortcut above already works
// around (see slashCommandSource). Turning off autocorrect/spellcheck on the
// content DOM stops Android from ever starting that composition, so deleting a
// selection is always a plain, atomic edit.
const noAndroidComposition = EditorView.contentAttributes.of({
  autocorrect: 'off',
  autocapitalize: 'off',
  spellcheck: 'false',
});

const extensions = [
  editableConf.of([]),
  noAndroidComposition,
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
    override: [
      slashCommandSource,
      codeProjectSource,
      runProjectSource,
      deleteProjectSource,
      talkSubjectSource,
      aggTasksSubjectSource,
      searchSource,
    ],
    icons: false,
    activateOnTyping: true,
    // Picking `/code`, `/run`, `/delete`, `/talk`, `/agg-tasks` or `/search` from
    // the slash menu lands the caret on `/code `/`/run `/`/delete `/`/talk `/
    // `/agg-tasks `/`/search ` — all take a project, subject, or query first, so
    // re-open completion straight away and that list shows without waiting for a
    // keystroke. Other commands close as usual.
    activateOnCompletion: c =>
      c.label === '/code' ||
      c.label === '/run' ||
      c.label === '/delete' ||
      c.label === '/talk' ||
      c.label === '/agg-tasks' ||
      c.label === '/search',
    aboveCursor: false,
  }),
  openLinks,
  markdown({ base: markdownLanguage, codeLanguages, extensions: [WikiLink] }),
  syntaxHighlighting(highlight),
  previewField,
  askLiveField,
  recPlayField,
  runLiveField,
  codeLiveField,
  viewLiveField,
  payloadField,
  cardField,
  previewFetcher,
  viewFetcher,
  codeBlocks,
  blockquotes,
  livePreview,
  listIndent,
  theme,
  EditorView.lineWrapping,
  EditorView.updateListener.of(u => {
    if (u.docChanged) post({ type: 'change', text: u.state.doc.toString() });
    // Keep an open full-page card view in sync with the live fields it mirrors
    // (streamed output/transcript arrive as non-doc transactions), and let it
    // close itself if its card was deleted.
    refreshOpenOverlay(u.view);
  }),
];

const view = new EditorView({
  parent: document.getElementById('root'),
  state: EditorState.create({ doc: '', extensions }),
});

// Statuses where a card's run is still in flight: after seeding a document, any
// marker in one of these had a run going when the note was last shown, so RN is
// asked to re-adopt it from the app-level registry (window __setDoc → reattach).
const INFLIGHT_STATUS = new Set(['streaming', 'pending', 'running']);

// RN calls this (via injectJavaScript) to seed / replace the document without
// losing the editor instance. After seeding, scan for in-flight AI markers and
// ask RN to reattach each to its live run (repaint + resume), so swiping back to
// a note whose /ask or /code was still running picks the stream back up.
window.__setDoc = function (text) {
  // A different note is being seeded — any enlarged card view belongs to the old
  // note, so drop it before the swap (its card id won't exist in the new doc).
  closeOverlay();
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text ?? '' },
  });
  // Old notes stored card bodies inline; move them into payloadField + SQLite and
  // shrink the markers to the light form, so a large /code transcript no longer
  // bloats the note text serialized over the bridge on every keystroke. A no-op
  // for notes already migrated (their markers are already light).
  migrateInlineMarkers(view);
  eachAiLine(view.state, obj => {
    if (obj.id && INFLIGHT_STATUS.has(obj.status)) {
      post({ type: 'reattach', id: obj.id, kind: obj.kind });
    }
  });
};

// --- Speech-to-text dictation -----------------------------------------------
// The footer mic streams the recognizer's transcript in through these. `text` is
// the running transcript of the *current* utterance: partial results overwrite
// the same span in place (dictRange tracks it) so a growing phrase doesn't pile
// up, and the final result commits the span and drops a trailing space before
// the next utterance starts a fresh run at the caret. Inserts at the selection
// but never calls view.focus(), so dictating doesn't raise the soft keyboard.
let dictRange = null;
window.__dictate = function (text, isFinal) {
  // Subject-notebook pages are read-only; never mutate them (also guards a race
  // where the mic is still delivering as the user swipes onto a read-only page).
  if (view.state.readOnly) return;
  const t = text ?? '';
  if (!dictRange) {
    const at = view.state.selection.main.from;
    dictRange = { from: at, to: at };
  }
  view.dispatch({
    changes: { from: dictRange.from, to: dictRange.to, insert: t },
    selection: { anchor: dictRange.from + t.length },
    scrollIntoView: true,
  });
  if (isFinal) {
    const end = dictRange.from + t.length;
    view.dispatch({
      changes: { from: end, insert: ' ' },
      selection: { anchor: end + 1 },
    });
    dictRange = null;
  } else {
    dictRange.to = dictRange.from + t.length;
  }
};

// RN calls this when a recognition session ends (a pause, an error, or the user
// tapping the mic off): abandon the in-progress utterance span so the next chunk
// of speech starts a fresh insertion at wherever the caret is then.
window.__dictateEnd = function () {
  dictRange = null;
};

// RN calls this on load with every externalized card body for the page (one
// bundled batch, keyed by id — see NoteEditorWebView), decoded into payloadField
// so cards render their transcript/output/answer without any per-card round trip.
// Additive merge, so it never clobbers a body just migrated in from an old note.
window.__setPayloads = function (map) {
  const entries = Object.create(null);
  for (const id in map) {
    const { kind, payload } = map[id];
    entries[id] = { kind, body: decodePayload(kind, payload) };
  }
  view.dispatch({ effects: setPayloads.of(entries) });
};

// --- Throttled interim persistence ------------------------------------------
// Streamed output lives only in the live fields (askLive/runLive/codeLive), so a
// force-quit mid-run would lose everything received so far. To make output
// "tracked", fold the current partial into the marker roughly every 1.5s while a
// run streams — never per token (that would thrash the caret and save on every
// keystroke of output). Status stays in-flight, so the card keeps showing its
// live view; this only updates what's persisted for a cold reopen.
const PARTIAL_INTERVAL_MS = 1500;
const commitTimers = Object.create(null);

// Write the current live partial for `id` into its marker, keeping the in-flight
// status. No-op once the card has reached a terminal status (the terminal commit
// owns the block from then on).
function commitPartial(id) {
  const found = findAiLine(view.state, id);
  if (!found || !INFLIGHT_STATUS.has(found.obj.status)) return;
  const obj = found.obj;
  let patch = null;
  if (obj.kind === 'ask') {
    const live = view.state.field(askLiveField)[id];
    if (live) patch = { a: live.a };
  } else if (isChatKind(obj.kind)) {
    const live = view.state.field(askLiveField)[id];
    const turns = obj.turns || [];
    if (live && turns.length) {
      const next = turns.slice();
      next[next.length - 1] = { ...next[next.length - 1], a: live.a };
      patch = { turns: next };
    }
  } else if (obj.kind === 'run') {
    const live = view.state.field(runLiveField)[id];
    if (live) {
      let out = live.out;
      if (out.length > RUN_DOC_CAP) out = '…\n' + out.slice(out.length - RUN_DOC_CAP);
      patch = { out };
    }
  } else if (obj.kind === 'code') {
    const live = view.state.field(codeLiveField)[id];
    if (live) {
      const items = live.items
        .slice(Math.max(0, live.items.length - CODE_DOC_ITEMS))
        .map(({ open, ...rest }) => rest);
      patch = { items };
    }
  }
  if (!patch) return;
  const merged = { ...obj, ...patch };
  const kind = obj.kind;
  if (!EXTERNAL_KINDS.has(kind)) {
    // ask/chat stay inline — fold the partial straight into the marker as before.
    view.dispatch({
      changes: { from: found.from, to: found.to, insert: encodeAiMarker(merged) },
    });
    return;
  }
  // run/code: the light marker's text is usually unchanged (its status is still
  // in-flight), so persist the growing body to state + SQLite out of band and only
  // rewrite the doc if the light marker actually differs. This is what turns the
  // old "rewrite the whole transcript into the doc every 1.5s" into a cheap
  // out-of-band write that no longer bloats the note text on every partial.
  const marker = encodeAiMarker(merged);
  const current = view.state.doc.sliceString(found.from, found.to);
  view.dispatch({
    ...(current === marker
      ? {}
      : { changes: { from: found.from, to: found.to, insert: marker } }),
    effects: setPayload.of({ id, kind, body: bodyFromObj(kind, merged) }),
  });
  post({ type: 'cardPayload', id, kind, payload: encodePayload(kind, merged) });
}

// Throttle: schedule at most one partial commit per window while updates keep
// arriving, so continuous streaming persists ~every PARTIAL_INTERVAL_MS.
function schedulePartial(id) {
  if (commitTimers[id]) return;
  commitTimers[id] = setTimeout(() => {
    delete commitTimers[id];
    commitPartial(id);
  }, PARTIAL_INTERVAL_MS);
}

// Drop any pending partial commit for `id` — called by the terminal commits so a
// late partial can't clobber the final answer written to the marker.
function cancelPartial(id) {
  if (commitTimers[id]) {
    clearTimeout(commitTimers[id]);
    delete commitTimers[id];
  }
}

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

// RN calls this before replaying a run's buffered output on a reconnect: clear the
// live field for `id` so the replay rebuilds it from scratch (no duplication).
// `kind` picks which live field the card reads from.
window.__liveReset = function (id, kind) {
  if (kind === 'run') view.dispatch({ effects: clearRunLog.of(id) });
  else if (kind === 'code') view.dispatch({ effects: clearCodeLive.of(id) });
  else view.dispatch({ effects: clearAskLive.of(id) });
};

// RN streams answer chunks here as they arrive from the server. This updates a
// live field only (no document change), so the answer grows in place without
// disturbing the caret or triggering a save on every token.
window.__aiStream = function (id, answer) {
  view.dispatch({ effects: setAskLive.of({ id, a: answer, status: 'streaming' }) });
  schedulePartial(id);
};

// RN answers a listProjects request here with the paired laptop's project dirs,
// caching them for the `/code <name>` autocomplete. If the caret is sitting on a
// `/code ` line right now, re-open completion so a list that arrived after the
// menu first showed (the fetch is a round-trip) still populates it live.
window.__setProjects = function (names) {
  setCodeProjects(names);
  if (!view.hasFocus) return;
  const sel = view.state.selection.main;
  if (!sel.empty) return;
  const line = view.state.doc.lineAt(sel.head);
  if (/^\/ ?code\s/.test(line.text.slice(0, sel.head - line.from))) {
    startCompletion(view);
  }
};

// RN answers a listSubjects request here with the orchestrator's existing MCP
// notebook slugs, caching them for the `/talk <subject>` autocomplete. If the
// caret is sitting on a `/talk ` line right now, re-open completion so a list
// that arrived after the menu first showed (the fetch is a round-trip) still
// populates it live.
window.__setTalkSubjects = function (names) {
  setTalkSubjects(names);
  if (!view.hasFocus) return;
  const sel = view.state.selection.main;
  if (!sel.empty) return;
  const line = view.state.doc.lineAt(sel.head);
  if (/^\/ ?talk\s/.test(line.text.slice(0, sel.head - line.from))) {
    startCompletion(view);
  }
};

// RN answers a search request here with the paired laptop's matching notebook
// pages, caching them (keyed to that exact query — see setSearchResults) for
// the `/search <query>` autocomplete. If the caret is still sitting on that
// `/search ` line, re-open completion so a reply that arrives after the menu
// first showed (the search is a round trip) still populates it live.
window.__setSearchResults = function (query, results) {
  setSearchResults(query, results);
  if (!view.hasFocus) return;
  const sel = view.state.selection.main;
  if (!sel.empty) return;
  const line = view.state.doc.lineAt(sel.head);
  if (/^\/ ?search\s/.test(line.text.slice(0, sel.head - line.from))) {
    startCompletion(view);
  }
};

// RN answers a /view card's URL request here (no document change): `url` is the
// laptop's plaintext preview-proxy address for the card's port, carrying the
// bearer token as a bootstrap query. The card mounts its iframe on it. Kept in a
// live field only — the token must never be written into the note.
window.__viewUrl = function (id, url) {
  view.dispatch({ effects: setViewUrl.of({ id, url: String(url || '') }) });
};

// RN reports a /view card's URL fetch failing here (not paired, preview disabled
// on the laptop, server unreachable): the card shows the message instead of a frame.
window.__viewError = function (id, error) {
  view.dispatch({ effects: setViewUrl.of({ id, error: String(error || 'Could not load the page.') }) });
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
  cancelPartial(id);
  // Never let an empty answer overwrite content already persisted in the marker —
  // e.g. a cold-start resume that came back `gone`, or an error with no partial,
  // clears the live field first, so committing that empty would wipe a good answer.
  if (patch && !patch.a) delete patch.a;
  const found = findAiLine(view.state, id);
  const effects = [clearAskLive.of(id)];
  if (!found) {
    view.dispatch({ effects });
    return;
  }
  // ask/chat/pair/record all stay inline (none are externalized), so the marker
  // carries the whole story exactly as before.
  view.dispatch({
    changes: { from: found.from, to: found.to, insert: encodeAiMarker(mergeAiDone(found.obj, patch)) },
    effects,
  });
};

// RN streams terminal output chunks here as a /run command produces them. Like
// __aiStream this only grows a live field (no document change), so the log grows
// in place without disturbing the caret or saving on every chunk.
window.__runLog = function (id, chunk) {
  view.dispatch({ effects: setRunLog.of({ id, chunk }) });
  schedulePartial(id);
};

// A finished /run keeps no live state: fold a capped tail of its output into the
// marker (so reopening the note shows what happened) and drop the live entry.
// `patch` is { status:'done', code } on a clean exit or { status:'error', msg }.
const RUN_DOC_CAP = 8 * 1024;
function commitRun(id, patch) {
  cancelPartial(id);
  const live = view.state.field(runLiveField)[id];
  const found = findAiLine(view.state, id);
  // Fall back to the marker's persisted output if the live field is empty (a
  // resume that came back `gone` cleared it), so we don't wipe what was captured.
  let out = live && live.out ? live.out : (found && found.obj.out) || '';
  if (out.length > RUN_DOC_CAP) out = '…\n' + out.slice(out.length - RUN_DOC_CAP);
  const effects = [clearRunLog.of(id)];
  if (!found) {
    view.dispatch({ effects });
    return;
  }
  effects.push(setPayload.of({ id, kind: 'run', body: { out } }));
  view.dispatch({
    changes: { from: found.from, to: found.to, insert: encodeAiMarker({ ...found.obj, ...patch }) },
    effects,
  });
  post({ type: 'cardPayload', id, kind: 'run', payload: out });
}

// RN calls this once a /run command exits (code >= 0), was signalled/killed
// (code < 0 → the card reads "stopped"), or on a natural interrupt.
window.__runExit = function (id, code) {
  commitRun(id, { status: 'done', code });
};

// RN calls this if the run couldn't start or the connection dropped mid-run.
window.__runError = function (id, msg) {
  commitRun(id, { status: 'error', msg });
};

// RN streams /code agent events here as the session produces them (the user's
// prompts, assistant prose/tokens, tool calls and results). Like __runLog this
// only grows a live field, so the transcript builds in place without touching
// the document. `ev` is a compact {t, ...} block (see reduceCodeItems).
window.__codeEvent = function (id, ev) {
  view.dispatch({ effects: appendCodeEvent.of({ id, ev }) });
  schedulePartial(id);
};

// A finished /code session keeps no live state: fold a capped snapshot of its
// transcript into the marker (so reopening the note shows what happened) and drop
// the live entry. `patch` is { status:'done' } on a clean exit or
// { status:'error', msg } if it failed.
const CODE_DOC_ITEMS = 60; // persist at most the newest N blocks
function commitCode(id, patch) {
  cancelPartial(id);
  const live = view.state.field(codeLiveField)[id];
  const found = findAiLine(view.state, id);
  // Fall back to the marker's persisted transcript if the live field is empty (a
  // resume that came back `gone` cleared it), so we don't wipe what was captured.
  let items = live && live.items.length ? live.items : (found && found.obj.items) || [];
  // Drop the transient "open" flag and cap how much we persist.
  items = items
    .slice(Math.max(0, items.length - CODE_DOC_ITEMS))
    .map(({ open, ...rest }) => rest);
  const effects = [clearCodeLive.of(id)];
  if (!found) {
    view.dispatch({ effects });
    return;
  }
  effects.push(setPayload.of({ id, kind: 'code', body: { items } }));
  view.dispatch({
    changes: { from: found.from, to: found.to, insert: encodeAiMarker({ ...found.obj, ...patch }) },
    effects,
  });
  post({ type: 'cardPayload', id, kind: 'code', payload: JSON.stringify(items) });
}

// RN calls this when the agent session exits (Claude finished / was stopped).
window.__codeExit = function (id) {
  commitCode(id, { status: 'done' });
};

// RN calls this if the session couldn't start or the connection dropped.
window.__codeError = function (id, msg) {
  commitCode(id, { status: 'error', msg });
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
  // The backup (a whole page copy) is the clean card's externalized body — it must
  // not go inline. Light marker in the doc; backup to state + SQLite.
  const marker = encodeAiMarker({ v: 1, kind: 'clean', id, status: 'review' });
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: marker + '\n' + cleaned },
    effects: setPayload.of({ id, kind: 'clean', body: { backup } }),
  });
  post({ type: 'cardPayload', id, kind: 'clean', payload: backup });
  // The cleaned text arrived from Claude with card bodies inlined (it was handed the
  // hydrated page); pull any such bodies back out into the store + light markers.
  migrateInlineMarkers(view);
};

post({ type: 'ready' });
