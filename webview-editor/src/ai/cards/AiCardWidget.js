import { WidgetType } from '@codemirror/view';
import { c } from '../../theme/palette.js';
import { unmountAnswerView } from '../answerView.js';
import { renderAsk, updateAskStream } from './ask.js';
import { renderChat } from './chat.js';
import { renderPair } from './pair.js';
import { renderClean } from './clean.js';
import { renderIngest } from './ingest.js';
import { renderRecord } from './record.js';
import { renderRun, updateRun } from './run.js';
import { renderCode, updateCode } from './code.js';
import { renderView } from './view.js';
import { renderUpdate } from './update.js';

// A stable token for a /code card's live transcript: block count, the length of
// the last (only growing) block, and status. Any streamed event changes one of
// these, so it flips the widget's eq and re-renders — while a pure delta append
// keeps the count and hits the append fast-path (updateCode).
function codeLiveToken(live) {
  const n = live.items.length;
  const last = n ? live.items[n - 1] : null;
  const lastLen = last && typeof last.text === 'string' ? last.text.length : 0;
  return n + ':' + lastLen + ':' + live.status;
}

/**
 * The block widget for every AI card. CodeMirror needs one WidgetType per
 * decoration, so this stays a single class — but it's a thin dispatcher: the
 * per-kind render/update logic lives in the sibling modules (ask, chat, pair,
 * clean, ingest, record, run, code), and this owns only the render signature
 * (what makes CM rebuild), the toDOM/updateDOM routing, and teardown.
 *
 * The card payload is markdown-persisted (see ../marker.js); live streamed
 * output rides in the state fields (askLive / runLive / codeLive) and reaches
 * the card as `live` so it can grow without rewriting the document.
 */
export class AiCardWidget extends WidgetType {
  constructor(obj, live, playing, payloadV) {
    super();
    this.obj = obj;
    this.live = live || null;
    // Only meaningful for a /record card: is its clip playing back right now.
    this.playing = !!playing;
    // Version of this card's externalized body (payloadField[id].v); folded into
    // sig so a persisted-body change re-renders even when obj's shape is unchanged.
    this.payloadV = payloadV || 0;
  }
  // The live answer applies to the turn currently streaming — the sole turn for
  // /ask, the last turn for a /chat transcript.
  get answer() {
    if (this.live && this.live.a != null) return this.live.a;
    if (this.obj.kind === 'chat') {
      const turns = this.obj.turns || [];
      return turns.length ? turns[turns.length - 1].a || '' : '';
    }
    return this.obj.a || '';
  }
  get status() {
    return this.live ? this.live.status : this.obj.status || 'done';
  }
  get sig() {
    const o = this.obj;
    const turnsSig = o.turns
      ? o.turns.map(t => (t.q || '') + ' ' + (t.a || '')).join('')
      : '';
    return [
      o.kind,
      o.id,
      o.q,
      o.msg,
      o.open,
      this.status,
      this.answer,
      turnsSig,
      // Record-card fields: any transition rebuilds the widget (the live timer
      // updates its own text node without touching these, so it won't churn).
      o.label,
      o.file,
      o.ms,
      o.startedAt,
      this.playing,
      // Run-card fields: the command, the persisted output (finished cards), and
      // a live token (output length + exit code) so each streamed chunk flips eq.
      o.cmd,
      o.code,
      o.out,
      o.kind === 'run' && this.live ? this.live.out.length + ':' + (this.live.code ?? '') : '',
      // Code-card fields: the project, the persisted transcript (finished cards),
      // and a live token (block count + last block length + status) so each
      // streamed event flips eq and the transcript re-renders.
      o.project,
      o.items ? o.items.length : '',
      o.kind === 'code' && this.live ? codeLiveToken(this.live) : '',
      // View-card fields: the target port, and a live token (fetch status + the
      // token-bearing url) so the card flips from loading to the mounted iframe
      // — or to an error — as soon as RN answers window.__viewUrl.
      o.port,
      o.kind === 'view' && this.live
        ? (this.live.status || '') + ':' + (this.live.url || '') + ':' + (this.live.error || '')
        : '',
      // Externalized-body version: flips when a persisted transcript/output/answer
      // changes (streaming commit, migration, seed) so the card re-renders.
      this.payloadV,
    ].join('');
  }
  eq(other) {
    return other.sig === this.sig;
  }
  toDOM(view) {
    switch (this.obj.kind) {
      case 'pair':
        return renderPair(view, this);
      case 'clean':
        return renderClean(view, this);
      case 'ingest':
        return renderIngest(view, this);
      case 'chat':
        return renderChat(view, this);
      case 'record':
        return renderRecord(view, this);
      case 'run':
        return renderRun(view, this);
      case 'code':
        return renderCode(view, this);
      case 'view':
        return renderView(view, this);
      case 'update':
        return renderUpdate(view, this);
      default:
        return renderAsk(view, this);
    }
  }
  // CM calls this when the widget changed (eq false) before falling back to a
  // full toDOM. Only the streaming cards have a fast path (append the delta in
  // place); every other change returns false so CM rebuilds via toDOM.
  updateDOM(dom, view) {
    if (this.obj.kind === 'run') return updateRun(dom, view, this);
    if (this.obj.kind === 'code') return updateCode(dom, view, this);
    if (this.obj.kind === 'ask' || this.obj.kind === 'chat') return updateAskStream(dom, view, this);
    return false;
  }
  // Tear down the nested answer editor(s) when CM discards this card's DOM
  // (answer changed, card collapsed, or line deleted), so we don't leak
  // EditorViews. A /chat card mounts one view per turn (dom._mdViews); /ask and
  // its streaming last turn keep a single dom._mdView. A /record card leaves a
  // running interval (the live timer) that must be cleared here.
  destroy(dom) {
    if (!dom) return;
    const views = dom._mdViews || (dom._mdView ? [dom._mdView] : []);
    for (const v of views) unmountAnswerView(v);
    dom._mdViews = null;
    dom._mdView = null;
    if (dom._recTimer) {
      clearInterval(dom._recTimer);
      dom._recTimer = null;
    }
  }
  ignoreEvent() {
    return true;
  }
}

// The shared card shell: the `.cm-ask` container, its collapsible header (chevron
// + title + streaming badge), body divider, the "Thinking…" dots, and the blink
// keyframe reused by the /run live badge and /record pulse. Per-card modules add
// their own fragments on top.
export const styles = {
  '.cm-ask': {
    margin: '10px 0',
    border: `1px solid ${c.surface0}`,
    borderRadius: '12px',
    backgroundColor: c.mantle,
    overflow: 'hidden',
    fontFamily: '-apple-system, Roboto, sans-serif',
    maxWidth: '640px',
    WebkitTouchCallout: 'none',
  },
  '.cm-ask-error': { borderColor: c.red },
  '.cm-ask-head': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '11px 12px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-ask-chev': {
    color: c.mauve,
    fontSize: '13px',
    lineHeight: '1.5',
    transition: 'transform 0.12s ease',
    transform: 'rotate(0deg)',
  },
  '.cm-ask-chev.cm-open': { transform: 'rotate(90deg)' },
  '.cm-ask-q': {
    flex: '1',
    minWidth: '0',
    color: c.text,
    fontSize: '15px',
    fontWeight: '600',
    lineHeight: '1.4',
    // Keep the title to one line — a long question truncates with an ellipsis
    // instead of wrapping or pushing the card wider than the screen (matches the
    // /run, /view and /code header chips).
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-ask-badge': {
    flexShrink: '0',
    fontSize: '11px',
    color: c.overlay1,
    alignSelf: 'center',
  },
  // Still used by the /pair chip's dismiss button.
  '.cm-ask-del': {
    flexShrink: '0',
    color: c.overlay1,
    fontSize: '16px',
    lineHeight: '1',
    padding: '0 2px',
    cursor: 'pointer',
  },
  '.cm-ask-body': {
    position: 'relative',
    padding: '0 12px 12px 12px',
    borderTop: `1px solid ${c.surface0}`,
  },
  '.cm-ask-thinking': {
    display: 'inline-flex',
    gap: '4px',
    alignItems: 'center',
    paddingTop: '12px',
    color: c.overlay1,
    fontSize: '13px',
  },
  '.cm-ask-dot': {
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    backgroundColor: c.overlay1,
    display: 'inline-block',
    animation: 'cm-ask-blink 1.2s infinite both',
  },
  '.cm-ask-dot:nth-child(2)': { animationDelay: '0.2s' },
  '.cm-ask-dot:nth-child(3)': { animationDelay: '0.4s' },
  '@keyframes cm-ask-blink': {
    '0%, 80%, 100%': { opacity: '0.25' },
    '40%': { opacity: '1' },
  },
};
