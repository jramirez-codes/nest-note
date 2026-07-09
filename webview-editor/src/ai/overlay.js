// The full-page ("enlarged") view for a /run or /code card. Tapping the Expand
// corner in a card opens it; it fills the editor with just that one card's live
// terminal log or agent transcript, and stays live by re-reading the SAME live
// fields the card does on every editor update (refreshOpenOverlay is called from
// the main updateListener). Deletion lives on the card itself (a long-press
// there) — the page only views and drives the run.
//
// It mounts inside the editor DOM (view.dom), so every .cm-* component style
// applies unchanged — only the fixed-page chrome (.cm-ov*) is new. The badge,
// transcript rows, composer footer and streaming-append logic are the very same
// helpers the cards use (ai/shared/*), so a card and its expanded view can never
// visually drift.

import { c } from '../theme/palette.js';
import { BACK, INTERRUPT, STOP, SEND, PLAY } from '../ui/icons.js';
import { guardTaps, blockSelection } from '../ui/events.js';
import { post } from '../bridge.js';
import { findAiLine, rerunRunById, appendChatTurnById, isChatKind } from './marker.js';
import { runLiveField, codeLiveField, viewLiveField, askLiveField } from '../state.js';
import { mountAnswerView, unmountAnswerView } from './answerView.js';
import { renderCodeItem } from './shared/transcript.js';
import { applyRunBadge } from './shared/badge.js';
import { makeComposer } from './shared/composer.js';
import { thinkingDots } from './shared/thinking.js';
import { growPre, growMdView, scrollBottomSoon } from './shared/streamLog.js';

// The one overlay that can be open at a time. Null when nothing is enlarged.
let active = null;

// Current status + payload for a card by id, from its live field while it runs,
// falling back to the persisted marker once finished. Null once the card is gone
// (deleted) — the caller closes the overlay when that happens.
function readCard(view, id, kind) {
  if (kind === 'run') {
    const live = view.state.field(runLiveField)[id];
    if (live) return { status: live.status, out: live.out, code: live.code };
    const found = findAiLine(view.state, id);
    if (found && found.obj.kind === 'run') {
      return { status: found.obj.status || 'done', out: found.obj.out || '', code: found.obj.code };
    }
    return null;
  }
  if (kind === 'view') {
    // A view card's URL is transient (never persisted), so read it from the live
    // field; the marker only tells us the port and whether the card still exists.
    const found = findAiLine(view.state, id);
    if (!found || found.obj.kind !== 'view') return null;
    const live = view.state.field(viewLiveField)[id];
    return {
      status: live ? live.status : 'loading',
      url: live ? live.url : '',
      error: live ? live.error : '',
      port: found.obj.port,
    };
  }
  if (isChatKind(kind)) {
    // Mirror the card: the persisted turns come from the marker, while the live
    // streaming answer + status for the last turn ride in askLive (keyed by id).
    const found = findAiLine(view.state, id);
    if (!found || !isChatKind(found.obj.kind)) return null;
    const live = view.state.field(askLiveField)[id];
    const turns = found.obj.turns || [];
    const answer =
      live && live.a != null
        ? live.a
        : turns.length
          ? turns[turns.length - 1].a || ''
          : '';
    return {
      status: live ? live.status : found.obj.status || 'done',
      turns,
      answer,
      msg: found.obj.msg,
    };
  }
  const live = view.state.field(codeLiveField)[id];
  if (live) return { status: live.status, items: live.items };
  const found = findAiLine(view.state, id);
  if (found && found.obj.kind === 'code') {
    return { status: found.obj.status || 'done', items: found.obj.items || [] };
  }
  return null;
}

// Live footer for a /run page: stdin box, interrupt (⌃C), Stop (kill).
function runFoot(id) {
  return makeComposer({
    footClass: 'cm-ask-foot cm-run-foot cm-ov-foot',
    inputClass: 'cm-ask-followup cm-run-stdin',
    placeholder: 'stdin — Enter to send…',
    onSubmit: input => {
      const text = input.value;
      input.value = '';
      post({ type: 'runStdin', id, data: text + '\n' });
    },
    buttons: [
      { className: 'cm-run-btn cm-run-intr', icon: INTERRUPT, label: 'Interrupt', onTap: () => post({ type: 'runSignal', id }) },
      { className: 'cm-run-btn cm-run-stop', icon: STOP, label: 'Stop', onTap: () => post({ type: 'runStop', id }) },
    ],
  });
}

// Live footer for a /code page: a prompt box (Enter sends the next turn), Send,
// and Stop (kill the session).
function codeFoot(id) {
  return makeComposer({
    footClass: 'cm-ask-foot cm-run-foot cm-ov-foot',
    inputClass: 'cm-ask-followup cm-code-prompt',
    placeholder: 'Message the agent — Enter to send…',
    onSubmit: input => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      post({ type: 'codePrompt', id, text });
    },
    buttons: [
      { className: 'cm-run-btn cm-code-send', icon: SEND, label: 'Send', submit: true },
      { className: 'cm-run-btn cm-run-stop', icon: STOP, label: 'Stop session', onTap: () => post({ type: 'codeStop', id }) },
    ],
  });
}

// Live footer for a /chat page: a follow-up box that appends the next turn to the
// same thread (Enter or Send). Shown only while the thread is idle — never
// mid-stream — so it mirrors the card's follow-up composer.
function chatFoot(view, id) {
  return makeComposer({
    footClass: 'cm-ask-foot cm-ov-foot',
    inputClass: 'cm-ask-followup',
    placeholder: 'Ask a follow-up…',
    onSubmit: input => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      appendChatTurnById(view, id, text);
    },
    buttons: [{ tag: 'span', className: 'cm-ask-send', icon: SEND, submit: true }],
  });
}

// Tear down the nested markdown views (only /code mounts any).
function teardownMd() {
  if (!active) return;
  for (const v of active.mdViews) unmountAnswerView(v);
  active.mdViews = [];
  active.lastMd = null;
}

// Fill the page with the view card's live iframe. Swaps the src only when the URL
// changes, and shows the fetch error instead of a frame when one is set.
function renderViewOverlay(data) {
  if (data.error) {
    if (active.frame) {
      active.frame.remove();
      active.frame = null;
      active.viewUrl = null;
    }
    if (!active.errBox) {
      const box = document.createElement('div');
      box.className = 'cm-view-error cm-ov-view-error';
      active.body.appendChild(box);
      active.errBox = box;
    }
    active.errBox.textContent = data.error;
    return;
  }
  if (active.errBox) {
    active.errBox.remove();
    active.errBox = null;
  }
  if (!data.url) return; // still loading — leave the page blank until RN answers
  if (!active.frame) {
    const f = document.createElement('iframe');
    f.className = 'cm-ov-view-frame';
    f.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups');
    active.body.appendChild(f);
    active.frame = f;
  }
  if (active.viewUrl !== data.url) {
    active.frame.src = data.url;
    active.viewUrl = data.url;
  }
}

// Grow / append the /run log to match the current output (mirrors updateRun).
function renderRun(data) {
  if (!active.log) {
    const log = document.createElement('pre');
    log.className = 'cm-run-log cm-ov-log';
    active.body.appendChild(log);
    active.log = log;
    log.textContent = data.out;
    scrollBottomSoon(log);
    return;
  }
  if (growPre(active.log, data.out)) scrollBottomSoon(active.log);
}

// Render the /code transcript. Fast-path the hot case (the last assistant block
// growing token-by-token) by appending the delta into its mounted markdown view;
// any structural change (a new block, running→done) rebuilds the whole log.
function renderCode(data, running) {
  const items = data.items || [];
  const structural = !active.log || items.length !== active.count || (active.wasRunning && !running);

  if (!structural && active.lastMd) {
    const last = items[items.length - 1];
    if (last && last.type === 'text') {
      if (growMdView(active.lastMd, last.text || '')) scrollBottomSoon(active.log);
      return;
    }
  }

  teardownMd();
  let log = active.log;
  if (!log) {
    log = document.createElement('div');
    log.className = 'cm-code-log cm-ov-log';
    active.body.appendChild(log);
    active.log = log;
  } else {
    log.textContent = '';
  }
  items.forEach((item, idx) => {
    if (item.type === 'text') {
      const box = document.createElement('div');
      box.className = 'cm-code-text';
      log.appendChild(box);
      const streaming = running && idx === items.length - 1;
      const mv = mountAnswerView(box, item.text || '', { trim: !streaming });
      active.mdViews.push(mv);
      if (streaming) active.lastMd = mv;
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
  active.count = items.length;
  scrollBottomSoon(log);
}

// Render the /chat transcript. Fast-path the streaming case (the last turn's
// answer growing token-by-token) by appending the delta into its mounted markdown
// view; any structural change (a new turn, streaming→idle) rebuilds the log — the
// same shape renderCode uses, so a chat card and its page can't visually drift.
function renderChat(data, streaming) {
  const turns = data.turns || [];
  const structural = !active.log || turns.length !== active.count || (active.wasRunning && !streaming);

  if (!structural && active.lastMd && streaming) {
    if (growMdView(active.lastMd, data.answer || '')) scrollBottomSoon(active.log);
    return;
  }

  teardownMd();
  let log = active.log;
  if (!log) {
    log = document.createElement('div');
    log.className = 'cm-chat-log cm-ov-log';
    active.body.appendChild(log);
    active.log = log;
  } else {
    log.textContent = '';
  }
  turns.forEach((t, idx) => {
    const isLast = idx === turns.length - 1;
    // The opening question sits in the page header; later turns show theirs inline
    // so the thread reads as a back-and-forth (mirrors the card body).
    if (idx > 0) {
      const uq = document.createElement('div');
      uq.className = 'cm-chat-q';
      uq.textContent = t.q || '';
      log.appendChild(uq);
    }
    const answer = isLast ? data.answer : t.a || '';
    const box = document.createElement('div');
    box.className = 'cm-chat-a';
    log.appendChild(box);

    if (isLast && data.status === 'error') {
      if (answer) active.mdViews.push(mountAnswerView(box, answer));
      const err = document.createElement('div');
      err.className = 'cm-ask-answer cm-ask-answer-err';
      err.textContent = data.msg || 'Something went wrong.';
      box.appendChild(err);
    } else if (!answer && isLast && streaming) {
      box.appendChild(thinkingDots({ label: 'Thinking…' }));
    } else {
      const s = isLast && streaming;
      const mv = mountAnswerView(box, answer || '', { trim: !s });
      active.mdViews.push(mv);
      if (s) active.lastMd = mv;
    }
  });
  active.count = turns.length;
  scrollBottomSoon(log);
}

// Add/remove the live footer as the run transitions between running and finished.
function syncFoot(running) {
  if (running && !active.foot) {
    active.foot = active.kind === 'run' ? runFoot(active.id) : codeFoot(active.id);
    active.body.appendChild(active.foot);
  } else if (!running && active.foot) {
    active.foot.remove();
    active.foot = null;
  }
}

// The /chat follow-up composer is the inverse of run/code: it shows while the
// thread is IDLE and is pulled while a turn streams. Appended after the log so it
// stays pinned below the transcript.
function syncChatFoot(view, streaming) {
  if (!streaming && !active.foot) {
    active.foot = chatFoot(view, active.id);
    active.body.appendChild(active.foot);
  } else if (streaming && active.foot) {
    active.foot.remove();
    active.foot = null;
  }
}

// Re-read the current data and reconcile the page. Closes the overlay if the card
// it mirrors is gone (deleted, or a different note was seeded).
function render(view) {
  if (!active) return;
  const data = readCard(view, active.id, active.kind);
  if (!data) {
    closeOverlay();
    return;
  }
  const running = data.status === 'running';
  if (active.kind === 'view') {
    active.badge.className = 'cm-view-badge cm-view-badge-' + (data.status || 'loading');
    active.badge.textContent =
      data.status === 'ready' ? 'live' : data.status === 'error' ? 'error' : 'loading…';
    renderViewOverlay(data);
    return;
  }
  if (isChatKind(active.kind)) {
    const streaming = data.status === 'streaming';
    active.badge.className = 'cm-ask-badge';
    active.badge.textContent = streaming ? '···' : '';
    active.badge.style.display = streaming ? '' : 'none';
    renderChat(data, streaming);
    syncChatFoot(view, streaming);
    active.wasRunning = streaming;
    return;
  }
  applyRunBadge(active.badge, { kind: active.kind, status: data.status, code: data.code });
  // A finished /run shows the Run again icon in place of its status text.
  if (active.rerun) {
    active.rerun.style.display = running ? 'none' : '';
    active.badge.style.display = running ? '' : 'none';
  }
  if (active.kind === 'run') renderRun(data);
  else renderCode(data, running);
  syncFoot(running);
  active.wasRunning = running;
}

// Open the enlarged view for a card payload (must be a /run or /code marker obj).
export function openCardOverlay(view, obj) {
  if (!obj || (obj.kind !== 'run' && obj.kind !== 'code' && obj.kind !== 'view' && !isChatKind(obj.kind))) return;
  closeOverlay();
  const { id, kind } = obj;
  if (!readCard(view, id, kind)) return;

  const root = document.createElement('div');
  // The view page is full-bleed (its iframe fills the body edge-to-edge); run/code
  // keep the padded chrome.
  root.className = 'cm-ov' + (kind === 'view' ? ' cm-ov-view' : '');
  blockSelection(root);

  const head = document.createElement('div');
  head.className = 'cm-ov-head';

  const back = document.createElement('span');
  back.className = 'cm-ov-back';
  back.innerHTML = BACK;
  back.setAttribute('aria-label', 'Back');
  guardTaps(back, closeOverlay);
  head.appendChild(back);

  if (kind === 'code') {
    // Same stylized project pill as the card (.cm-code-proj), with a flex spacer
    // so the badge stays right-aligned — the enlarged view can't visually drift.
    const title = document.createElement('span');
    title.className = 'cm-code-proj cm-ov-proj';
    title.textContent = '✦ ' + (obj.project || '');
    title.title = 'Project: ' + (obj.project || '');
    head.appendChild(title);
    const spacer = document.createElement('span');
    spacer.className = 'cm-code-spacer';
    head.appendChild(spacer);
  } else if (kind === 'view') {
    const title = document.createElement('code');
    title.className = 'cm-ov-title';
    title.textContent = 'localhost:' + (obj.port || '');
    head.appendChild(title);
  } else if (isChatKind(kind)) {
    // The opening question titles the page (the body shows every later turn's
    // question inline). Prose, not monospace — so it drops the code-title styling.
    const title = document.createElement('div');
    title.className = 'cm-ov-title cm-ov-title-chat';
    const turns = obj.turns || [];
    title.textContent = turns.length ? turns[0].q || '' : '';
    head.appendChild(title);
  } else {
    const title = document.createElement('code');
    title.className = 'cm-ov-title';
    // A `/run PROJECT <cmd>` command carries its folder into the title (PROJECT ❯ cmd)
    // so the enlarged view says where it ran, matching the card's folder chip.
    title.textContent = obj.dir ? obj.dir + ' ❯ ' + (obj.cmd || '') : obj.cmd || '';
    head.appendChild(title);
  }

  const badge = document.createElement('span');
  head.appendChild(badge);

  // A finished /run swaps its status badge for this Run again icon — tap to restart
  // the same command in place (wiping the old output). Hidden while it's live; the
  // badge shows the pulsing dot then. render() toggles the two.
  let rerun = null;
  if (kind === 'run') {
    rerun = document.createElement('span');
    rerun.className = 'cm-ov-rerun';
    rerun.innerHTML = PLAY;
    rerun.title = 'Run again';
    rerun.setAttribute('aria-label', 'Run again');
    rerun.style.display = 'none';
    guardTaps(rerun, () => rerunRunById(view, id));
    head.appendChild(rerun);
  }

  // The view page fills the screen with the live iframe, so its reload lives up
  // here next to the status — tap to swap the frame's src in place, or re-ask RN
  // for the URL if the frame isn't up yet (still loading, or the fetch errored).
  if (kind === 'view') {
    const refresh = document.createElement('span');
    refresh.className = 'cm-ov-refresh';
    refresh.textContent = '⟳';
    refresh.title = 'Reload';
    guardTaps(refresh, () => {
      if (active && active.frame) active.frame.src = active.frame.src;
      else post({ type: 'view', id, port: obj.port });
    });
    head.appendChild(refresh);
  }

  root.appendChild(head);

  const body = document.createElement('div');
  body.className = 'cm-ov-body';
  root.appendChild(body);

  view.dom.appendChild(root);

  active = {
    id,
    kind,
    root,
    body,
    badge,
    rerun,
    log: null,
    foot: null,
    mdViews: [],
    lastMd: null,
    count: -1,
    wasRunning: false,
    // View-overlay only: the live iframe and the URL it's currently showing, plus
    // an error box swapped in when the fetch fails.
    frame: null,
    viewUrl: null,
    errBox: null,
  };
  render(view);
}

// Called from the editor's updateListener on every transaction so the page tracks
// streamed output/transcript growth (and closes if its card was deleted).
export function refreshOpenOverlay(view) {
  if (active) render(view);
}

// Close the enlarged view and return to the note (also called when the card is
// deleted or the note is swapped).
export function closeOverlay() {
  if (!active) return;
  teardownMd();
  active.foot = null;
  if (active.root) active.root.remove();
  active = null;
}

export const styles = {
  '.cm-ov': {
    position: 'fixed',
    inset: '0',
    zIndex: '30',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: c.base,
  },
  '.cm-ov-head': {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
    borderBottom: `1px solid ${c.surface0}`,
    backgroundColor: c.mantle,
  },
  '.cm-ov-back': {
    flexShrink: '0',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '34px',
    height: '34px',
    border: `1px solid ${c.surface1}`,
    borderRadius: '9px',
    backgroundColor: c.surface0,
    color: c.text,
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-ov-back svg': { display: 'block', width: '18px', height: '18px' },
  // Run again — a header icon button that replaces a finished run's status text.
  '.cm-ov-rerun': {
    flexShrink: '0',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '34px',
    height: '34px',
    border: `1px solid ${c.surface1}`,
    borderRadius: '9px',
    backgroundColor: c.surface0,
    color: c.teal,
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-ov-rerun svg': { display: 'block', width: '16px', height: '16px' },
  '.cm-ov-rerun:active': { backgroundColor: c.surface1, borderColor: c.teal },
  '.cm-ov-title': {
    flex: '1',
    minWidth: '0',
    color: c.teal,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '14px',
    fontWeight: '600',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  // The project pill sits in taller overlay chrome, so scale it up a touch.
  '.cm-ov-proj': { maxWidth: '75%', padding: '4px 12px', fontSize: '13px' },
  // A /chat page is titled by its opening question — prose, so it overrides the
  // monospace/teal code-title look with the card's question styling.
  '.cm-ov-title-chat': {
    color: c.text,
    fontFamily: '-apple-system, Roboto, sans-serif',
    fontWeight: '600',
  },
  // Reload for the /view page — sits beside the status badge in the header, sized
  // up to match the taller overlay chrome (cf. the card's inline reload).
  '.cm-ov-refresh': {
    flexShrink: '0',
    color: c.subtext0,
    fontSize: '20px',
    lineHeight: '1',
    padding: '0 6px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-ov-body': {
    flex: '1',
    minHeight: '0',
    display: 'flex',
    flexDirection: 'column',
    padding: '12px',
    overflow: 'hidden',
  },
  // The card's capped log/transcript grows to fill the whole page here. The
  // generous bottom padding is scroll room: the reader can scroll well past the
  // last line so it lifts clear of the footer composer instead of sitting under it.
  '.cm-ov .cm-run-log, .cm-ov .cm-code-log, .cm-ov .cm-chat-log': {
    maxHeight: 'none',
    flex: '1 1 auto',
    minHeight: '0',
    margin: '0',
    paddingBottom: '120px',
  },
  // The /chat page transcript is its own scroller (like the run/code logs), but
  // needs no chrome — just the turns stacked with the shared card styling.
  '.cm-ov .cm-chat-log': {
    overflow: 'auto',
    WebkitOverflowScrolling: 'touch',
  },
  '.cm-ov-foot': { flexShrink: '0' },
  // The view page drops the body padding so its iframe fills edge-to-edge.
  '.cm-ov-view .cm-ov-body': { padding: '0' },
  '.cm-ov-view-frame': {
    flex: '1 1 auto',
    width: '100%',
    minHeight: '0',
    border: 'none',
    backgroundColor: '#ffffff',
  },
  '.cm-ov-view-error': { padding: '16px' },
};
