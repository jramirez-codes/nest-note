import { c } from '../../theme/palette.js';
import { EXPAND, SEND, STOP } from '../../ui/icons.js';
import { makeCornerButton } from '../../ui/buttons.js';
import { blockSelection } from '../../ui/events.js';
import { post } from '../../bridge.js';
import { updateAiMarker, deleteCardLine } from '../marker.js';
import { openCardOverlay } from '../overlay.js';
import { mountAnswerView } from '../answerView.js';
import { applyRunBadge } from '../shared/badge.js';
import { makeComposer } from '../shared/composer.js';
import { renderCodeItem } from '../shared/transcript.js';
import { growMdView, nearBottom, scrollBottomSoon } from '../shared/streamLog.js';

/**
 * The /code agent card: a persistent Claude Code session in projects/<name>. The
 * header shows the project and a live/done badge; the body is a scrolling
 * transcript of prompts, assistant prose, tool calls and results. While the
 * session runs, a footer offers a prompt box (next turn) and Stop (kill). The
 * transcript streams from codeLive (never touching the doc) until it exits, at
 * which point a capped snapshot is folded into the marker — window.__codeEvent /
 * __codeExit / __codeError on the RN side.
 */
export function renderCode(view, widget) {
  const obj = widget.obj;
  const open = obj.open !== false;
  const id = obj.id;
  const live = widget.live;
  const status = live ? live.status : obj.status || 'done';
  const items = live ? live.items : obj.items || [];
  const running = status === 'running';

  const card = document.createElement('div');
  card.className = 'cm-ask cm-code' + (status === 'error' ? ' cm-ask-error' : '');
  blockSelection(card);

  const head = document.createElement('div');
  head.className = 'cm-ask-head cm-run-head';

  const chev = document.createElement('span');
  chev.className = 'cm-ask-chev' + (open ? ' cm-open' : '');
  chev.textContent = '▶';
  head.appendChild(chev);

  // The project name is shown as a stylized pill (mirrors the /run card's folder
  // chip), with a flex spacer after it so the status badge + corner button stay
  // right-aligned where /run's filling command chip would otherwise hold them.
  const proj = document.createElement('span');
  proj.className = 'cm-code-proj';
  proj.textContent = '✦ ' + (obj.project || '');
  proj.title = 'Project: ' + (obj.project || '');
  head.appendChild(proj);

  const spacer = document.createElement('span');
  spacer.className = 'cm-code-spacer';
  head.appendChild(spacer);

  const badge = document.createElement('span');
  applyRunBadge(badge, { kind: 'code', status });
  head.appendChild(badge);

  // Corner Expand — opens the full-page transcript view; a long-press morphs it
  // into Delete (stops the session first).
  head.appendChild(
    makeCornerButton({
      icon: EXPAND,
      label: 'Expand',
      holdTarget: card,
      onActivate: () => openCardOverlay(view, obj),
      onDelete: () => {
        if (running) post({ type: 'codeStop', id });
        deleteCardLine(view, card);
      },
    }),
  );

  head.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
  });
  head.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    updateAiMarker(view, card, { open: !open });
  });
  card.appendChild(head);

  if (open) {
    const body = document.createElement('div');
    body.className = 'cm-ask-body cm-run-body';

    const log = document.createElement('div');
    log.className = 'cm-code-log';
    // Assistant prose renders as markdown in a nested read-only view (same as the
    // /ask card); user prompts, tool calls and results stay compact rows
    // (renderCodeItem). Track every mounted view so destroy() can tear them down.
    card._mdViews = [];
    card._mdView = null;
    items.forEach((item, idx) => {
      if (item.type === 'text') {
        const box = document.createElement('div');
        box.className = 'cm-code-text';
        log.appendChild(box);
        // The last block, while the session streams, grows token-by-token; mount
        // it untrimmed so updateCode's appends stay a cheap end-insert.
        const streaming = running && idx === items.length - 1;
        const mv = mountAnswerView(box, item.text || '', { trim: !streaming });
        card._mdViews.push(mv);
        if (streaming) card._mdView = mv;
      } else {
        log.appendChild(renderCodeItem(item, items[idx - 1]));
      }
    });
    if (!items.length && running) {
      const hint = document.createElement('div');
      hint.className = 'cm-code-hint';
      hint.textContent = 'Session ready — send a message below.';
      log.appendChild(hint);
    }
    body.appendChild(log);
    card._codeLog = log;
    scrollBottomSoon(log); // start pinned to the newest output

    if (running) body.appendChild(codeFoot(id));
    card.appendChild(body);
  }

  card._codeSig = { id, open, status, count: items.length };
  return card;
}

// Footer for a live /code card: a prompt box (Enter sends the next turn) and a
// Stop button that kills the whole session.
function codeFoot(id) {
  return makeComposer({
    footClass: 'cm-ask-foot cm-run-foot',
    inputClass: 'cm-ask-followup cm-code-prompt',
    placeholder: 'Message the agent — Enter to send…',
    // RN echoes this into the transcript (window.__codeEvent user) and feeds it
    // to the running session as the next turn.
    onSubmit: input => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      post({ type: 'codePrompt', id, text });
    },
    buttons: [
      { className: 'cm-run-btn cm-code-send', icon: SEND, title: 'Send', label: 'Send', submit: true },
      {
        className: 'cm-run-btn cm-run-stop',
        icon: STOP,
        title: 'Stop session',
        label: 'Stop session',
        onTap: () => post({ type: 'codeStop', id }),
      },
    ],
  });
}

// Update a live, open, still-running /code card in place instead of letting CM
// rebuild the whole card via toDOM. This matters for interaction, not just speed:
// a full rebuild replaces the footer's prompt <input> (dropping its focus AND any
// half-typed follow-up) and swaps out the header mid-tap — so while the agent
// streams tool calls/results, the user couldn't reliably send a follow-up and the
// header's collapse tap got eaten. We keep the header + footer DOM untouched and
// only touch the transcript log: extend the growing last block (Case A) or append
// the newly-streamed blocks (Case B). Any id/open/status transition — including
// running→done, which must swap the footer for the exit badge — returns false so
// CM does rebuild via toDOM.
export function updateCode(dom, view, widget) {
  const obj = widget.obj;
  const prev = dom._codeSig;
  const log = dom._codeLog;
  const live = widget.live;
  const status = live ? live.status : obj.status || 'done';
  const items = live ? live.items : [];
  if (
    !prev ||
    !log ||
    prev.id !== obj.id ||
    !prev.open ||
    obj.open === false ||
    prev.status !== 'running' ||
    status !== 'running' ||
    items.length < prev.count // a shrink/reset is structural — rebuild.
  ) {
    return false;
  }
  const scroller = view.scrollDOM;
  const stick = nearBottom(scroller);

  // Case A — same block count: only the last (open assistant) block can have
  // grown token-by-token; extend its mounted markdown view in place.
  if (items.length === prev.count) {
    const md = dom._mdView;
    const last = items[items.length - 1];
    if (!md || !last || last.type !== 'text') return false;
    if (growMdView(md, last.text || '')) {
      log.scrollTop = log.scrollHeight;
      if (stick) scrollBottomSoon(scroller);
    }
    dom._codeSig = { id: obj.id, open: true, status: 'running', count: items.length };
    return true;
  }

  // Case B — new block(s) appended (a tool call/result, or a fresh prose block).
  // The transcript only ever appends, so we mount just the new items onto the
  // existing log; the composer and header DOM survive intact.
  const prevLast = items[prev.count - 1];
  if (dom._mdView && prevLast && prevLast.type === 'text') {
    // The previously-streaming block is now closed — settle it on its final text.
    growMdView(dom._mdView, prevLast.text || '');
  }
  dom._mdView = null;
  if (prev.count === 0) {
    const hint = log.querySelector('.cm-code-hint');
    if (hint) hint.remove();
  }
  if (!dom._mdViews) dom._mdViews = [];
  for (let idx = prev.count; idx < items.length; idx++) {
    const item = items[idx];
    if (item.type === 'text') {
      const box = document.createElement('div');
      box.className = 'cm-code-text';
      log.appendChild(box);
      const streaming = idx === items.length - 1; // running is guaranteed here
      const mv = mountAnswerView(box, item.text || '', { trim: !streaming });
      dom._mdViews.push(mv);
      if (streaming) dom._mdView = mv;
    } else {
      log.appendChild(renderCodeItem(item, items[idx - 1]));
    }
  }
  dom._codeSig = { id: obj.id, open: true, status: 'running', count: items.length };
  log.scrollTop = log.scrollHeight;
  if (stick) scrollBottomSoon(scroller);
  return true;
}

export const styles = {
  // Reuses the run card's head/badge/footer classes (.cm-run-*); the body is a
  // scrolling transcript of typed blocks rather than a single terminal log.
  '.cm-code-proj': {
    flexShrink: '0',
    maxWidth: '70%',
    padding: '2px 9px',
    borderRadius: '7px',
    backgroundColor: c.surface0,
    border: `1px solid ${c.surface1}`,
    color: c.mauve,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '12px',
    fontWeight: '600',
    lineHeight: '1.5',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-code-spacer': { flex: '1', minWidth: '0' },
  '.cm-code-log': {
    margin: '10px 0 0 0',
    padding: '4px 2px',
    maxHeight: '420px',
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    WebkitOverflowScrolling: 'touch',
  },
  // Each transcript block keeps its natural height. Without this the flex column
  // shrinks its children (default flex-shrink:1), and because a file pane wraps an
  // overflow:auto body its min-height resolves to 0 — so the panes collapse to a
  // scrunched sliver. flex-shrink:0 makes the log the sole scroller instead.
  '.cm-code-log > *': { flexShrink: '0' },
  '.cm-code-hint': {
    color: c.overlay1,
    fontSize: '13px',
    fontStyle: 'italic',
    padding: '4px 2px',
  },
  '.cm-code-prompt': { fontSize: '14px' },
  '.cm-code-prompt:focus': { borderColor: c.mauve },
  '.cm-code-send': { borderColor: c.mauve, color: c.mauve },
};
