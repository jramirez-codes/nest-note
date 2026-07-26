import { c } from '../../theme/palette.js';
import { EXPAND, STOP } from '../../ui/icons.js';
import { makeCornerButton } from '../../ui/buttons.js';
import { blockSelection } from '../../ui/events.js';
import { post } from '../../bridge.js';
import { updateAiMarker, deleteCardLine } from '../marker.js';
import { openCardOverlay } from '../overlay.js';
import { applyRunBadge } from '../shared/badge.js';
import { makeComposer } from '../shared/composer.js';
import { mountCodeBlock, estimateCodeBlock } from '../shared/transcript.js';
import { createBlockList } from '../shared/blockList.js';
import { nearBottom, scrollBottomSoon } from '../shared/streamLog.js';

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
    body.appendChild(log);

    // Occlusion-virtualized transcript: only blocks near the viewport are mounted
    // (see shared/blockList), so a long session never mounts hundreds of nested
    // markdown editors at once. Assistant prose becomes a nested read-only view,
    // everything else a compact row (mountCodeBlock). The streaming block is
    // pinned mounted so token appends stay a cheap end-insert.
    const list = createBlockList({
      log,
      renderItem: mountCodeBlock,
      estimateHeight: estimateCodeBlock,
    });
    list.build(items, running);
    card._blockList = list;
    card._codeLog = log;

    if (!items.length && running) {
      const hint = document.createElement('div');
      hint.className = 'cm-code-hint';
      hint.textContent = 'Session ready — send a message below.';
      log.appendChild(hint);
    }

    if (running) body.appendChild(codeFoot(id));
    card.appendChild(body);
  }

  card._codeSig = { id, open, status, count: items.length };
  return card;
}

// Footer for a live /code card: a prompt box (Enter sends the next turn), a Stop
// button that kills the whole session, and the dictation mic (ui/mic.js — talk
// the turn into this box, tap it off to send). The mic sits last, in the corner
// itself, since it's the one that's tapped every turn.
function codeFoot(id) {
  return makeComposer({
    footClass: 'cm-ask-foot',
    inputClass: 'cm-ask-followup cm-code-prompt',
    placeholder: 'Message the agent — Enter to send…',
    draftKey: id,
    // RN echoes this into the transcript (window.__codeEvent user) and feeds it
    // to the running session as the next turn.
    onSubmit: input => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      post({ type: 'codePrompt', id, text });
    },
    buttons: [
      {
        className: 'cm-run-btn cm-run-stop',
        icon: STOP,
        title: 'Stop session',
        label: 'Stop session',
        onTap: () => post({ type: 'codeStop', id }),
      },
      { mic: true },
    ],
  });
}

// Update a live, open, still-running /code card in place instead of letting CM
// rebuild the whole card via toDOM. This matters for interaction, not just speed:
// a full rebuild replaces the footer's prompt box (dropping its focus AND any
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
  const list = dom._blockList;
  const live = widget.live;
  const status = live ? live.status : obj.status || 'done';
  const items = live ? live.items : [];
  if (
    !prev ||
    !list ||
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
  // grown token-by-token; extend its pinned streaming view in place. The block
  // list keeps the inner log pinned to the bottom; we also keep the outer editor
  // pinned if the reader was already there.
  if (items.length === prev.count) {
    const last = items[items.length - 1];
    if (!last || last.type !== 'text' || !list.hasStreaming()) return false;
    if (list.growStreaming(last.text || '') && stick) scrollBottomSoon(scroller);
    dom._codeSig = { id: obj.id, open: true, status: 'running', count: items.length };
    return true;
  }

  // Case B — new block(s) appended (a tool call/result, or a fresh prose block).
  // The transcript only ever appends, so the block list settles the previously-
  // streaming block and mounts just the new items; the composer and header DOM
  // survive intact.
  if (prev.count === 0) {
    const hint = dom._codeLog && dom._codeLog.querySelector('.cm-code-hint');
    if (hint) hint.remove();
  }
  list.appendFrom(items, prev.count, true);
  if (stick) scrollBottomSoon(scroller);
  dom._codeSig = { id: obj.id, open: true, status: 'running', count: items.length };
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
  // The footer's other button is the dictation mic, styled in ui/mic.js.
};
