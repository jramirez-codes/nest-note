import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import { StateField } from '@codemirror/state';
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
  setRunStatus,
  clearRunLog,
} from './state.js';
import { LinkCardWidget, ImageWidget } from './widgets.js';
import { AiCardWidget } from './aiCard.js';
import { eachAiLine } from './aiMarker.js';
import { eachCardUrl, eachBlockImage } from './urls.js';
import { post } from './bridge.js';

// Block widgets must come from a StateField (the editor computes vertical layout
// before running view plugins), so the cards live here rather than in a plugin.
function buildCards(state) {
  const previews = state.field(previewField);
  const askLive = state.field(askLiveField);
  const recPlay = state.field(recPlayField);
  const runLive = state.field(runLiveField);
  // Lines touched by a selection stay raw so the URL can be edited. Read-only
  // views (the /ask answer preview) never reveal — cards always render.
  const activeLines = new Set();
  if (!state.readOnly) {
    for (const r of state.selection.ranges) {
      const first = state.doc.lineAt(r.from).number;
      const last = state.doc.lineAt(r.to).number;
      for (let n = first; n <= last; n++) activeLines.add(n);
    }
  }

  const marks = [];
  eachCardUrl(state, (url, line) => {
    if (activeLines.has(line.number)) return; // editing this line — show raw URL
    // Replace the whole URL line with the card so the raw URL is never shown.
    marks.push(
      Decoration.replace({
        widget: new LinkCardWidget(url, previews[url]),
        block: true,
      }).range(line.from, line.to),
    );
  });
  eachBlockImage(state, (url, alt, line) => {
    if (activeLines.has(line.number)) return; // editing this line — show raw text
    marks.push(
      Decoration.replace({
        widget: new ImageWidget(url, alt, true),
        block: true,
      }).range(line.from, line.to),
    );
  });
  // Ask/pair cards always render as their widget (never revealed as raw base64),
  // so the marker line is replaced whether or not the cursor is on it.
  eachAiLine(state, (obj, line) => {
    // Run cards read their live output from runLive; every other kind uses askLive.
    const live = obj.kind === 'run' ? runLive[obj.id] : askLive[obj.id];
    marks.push(
      Decoration.replace({
        widget: new AiCardWidget(obj, live, !!recPlay[obj.id]),
        block: true,
      }).range(line.from, line.to),
    );
  });
  return Decoration.set(marks, true);
}

export const cardField = StateField.define({
  create: state => buildCards(state),
  update(value, tr) {
    // Rebuild on edits, on cursor moves (reveal/hide the raw URL), when a fetched
    // preview arrives, and when a streamed answer chunk lands.
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some(
        e =>
          e.is(setPreviewEffect) ||
          e.is(setAskLive) ||
          e.is(clearAskLive) ||
          e.is(setRecPlay) ||
          e.is(setRunLog) ||
          e.is(setRunStatus) ||
          e.is(clearRunLog),
      )
    ) {
      return buildCards(tr.state);
    }
    return value.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f),
});

// Side effects (asking RN to fetch) belong in a plugin, not the pure field.
// `requested` dedupes so each URL is fetched at most once per session.
const requested = new Set();
export const previewFetcher = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.scan(view.state);
    }
    update(u) {
      if (u.docChanged) this.scan(u.state);
    }
    scan(state) {
      const previews = state.field(previewField);
      eachCardUrl(state, url => {
        if (!previews[url] && !requested.has(url)) {
          requested.add(url);
          post({ type: 'fetchPreview', url });
        }
      });
    }
  },
);
