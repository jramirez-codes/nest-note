import { c } from '../../theme/palette.js';
import { EXPAND, INTERRUPT, STOP } from '../../ui/icons.js';
import { makeCornerButton } from '../../ui/buttons.js';
import { copyText } from '../../ui/clipboard.js';
import { blockSelection } from '../../ui/events.js';
import { post } from '../../bridge.js';
import { updateAiMarker, deleteCardLine } from '../marker.js';
import { openCardOverlay } from '../overlay.js';
import { applyRunBadge } from '../shared/badge.js';
import { makePill } from '../shared/pill.js';
import { makeComposer } from '../shared/composer.js';
import { growPre, nearBottom, scrollBottomSoon } from '../shared/streamLog.js';

/**
 * The /run terminal card: a shell command's output streamed live from the paired
 * laptop. The header shows the command and toggles the log accordion; the body is
 * a scrolling <pre> fed chunk-by-chunk from the runLive field (never the
 * document, so no caret jump / save storm). While running it offers a stdin box,
 * an interrupt (⌃C) and a Stop; once finished the badge shows the exit code. All
 * process lifecycle lives on the RN side — this only posts intents by id and
 * reflects the status RN commits via __runExit / __runError.
 */
export function renderRun(view, widget) {
  const obj = widget.obj;
  const open = obj.open !== false;
  const id = obj.id;
  const live = widget.live;
  const status = live ? live.status : obj.status || 'done';
  const out = live ? live.out : obj.out || '';
  const code = live && live.code != null ? live.code : obj.code;
  const running = status === 'running';

  const card = document.createElement('div');
  card.className = 'cm-ask cm-run' + (status === 'error' ? ' cm-ask-error' : '');
  blockSelection(card);

  const head = document.createElement('div');
  head.className = 'cm-ask-head cm-run-head';

  const chev = document.createElement('span');
  chev.className = 'cm-ask-chev' + (open ? ' cm-open' : '');
  chev.textContent = '▶';
  head.appendChild(chev);

  // `/run PROJECT <cmd>` ran the command inside a project folder — show it as a
  // small chip so the card records where the output came from.
  if (obj.dir) {
    head.appendChild(
      makePill({ label: obj.dir, title: 'Project folder: ' + obj.dir, className: 'cm-run-dir' }),
    );
  }

  const cmd = document.createElement('code');
  cmd.className = 'cm-run-cmd';
  cmd.textContent = obj.cmd || '';
  head.appendChild(cmd);

  const badge = document.createElement('span');
  applyRunBadge(badge, { kind: 'run', status, code });
  head.appendChild(badge);

  // Corner Expand — opens the full-page log view; a long-press morphs it into
  // Delete (stops the run before removing). Arming Delete also copies the
  // original `/run …` invocation to the clipboard so it's easy to re-run/tweak.
  head.appendChild(
    makeCornerButton({
      icon: EXPAND,
      label: 'Expand',
      holdTarget: card,
      onActivate: () => openCardOverlay(view, obj),
      onArm: () =>
        copyText('/run ' + (obj.dir ? obj.dir + ' ' : '') + (obj.cmd || '')),
      onDelete: () => {
        if (running) post({ type: 'runStop', id });
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

    const log = document.createElement('pre');
    log.className = 'cm-run-log';
    log.textContent = out;
    body.appendChild(log);
    card._runLog = log;
    scrollBottomSoon(log); // start pinned to the newest output

    if (running) body.appendChild(runFoot(id));
    card.appendChild(body);
  }

  card._runSig = { id, open, status };
  return card;
}

// Footer for a live /run card: a stdin box, a Stop, and an interrupt (⌃C). Stop
// sits inboard and the interrupt takes the corner, matching /code — the killer is
// the one you reach past, the everyday control is the one under your thumb.
function runFoot(id) {
  return makeComposer({
    footClass: 'cm-ask-foot',
    inputClass: 'cm-ask-followup cm-run-stdin',
    placeholder: 'stdin — Enter to send…',
    draftKey: id,
    // A submitted line carries its newline, matching what a terminal sends.
    onSubmit: input => {
      const text = input.value;
      input.value = '';
      post({ type: 'runStdin', id, data: text + '\n' });
    },
    buttons: [
      {
        className: 'cm-run-btn cm-run-stop',
        icon: STOP,
        title: 'Stop (kill)',
        label: 'Stop',
        onTap: () => post({ type: 'runStop', id }),
      },
      {
        className: 'cm-run-btn cm-run-intr',
        icon: INTERRUPT,
        title: 'Interrupt (⌃C)',
        label: 'Interrupt',
        onTap: () => post({ type: 'runSignal', id }),
      },
    ],
  });
}

// Fast-path the hot case — the same open, still-running card getting more output
// — by appending only the new tail to the <pre>. Any structural change (open
// toggle, running→done/error, id change) returns false so CM rebuilds via toDOM
// (which swaps the footer for the exit badge).
export function updateRun(dom, view, widget) {
  const obj = widget.obj;
  const prev = dom._runSig;
  const log = dom._runLog;
  const live = widget.live;
  const status = live ? live.status : obj.status || 'done';
  if (
    !prev ||
    !log ||
    prev.id !== obj.id ||
    !prev.open ||
    obj.open === false ||
    prev.status !== 'running' ||
    status !== 'running'
  ) {
    return false;
  }
  const out = live ? live.out : '';
  const scroller = view.scrollDOM;
  const stick = nearBottom(scroller);
  if (growPre(log, out)) {
    // Keep the log itself pinned to the bottom, and the page too if it was.
    log.scrollTop = log.scrollHeight;
    if (stick) scrollBottomSoon(scroller);
  }
  dom._runSig = { id: obj.id, open: true, status: 'running' };
  return true;
}

export const styles = {
  // Reuses the ask card shell (.cm-ask); the header shows the command in a
  // monospace chip and a status badge (badge.js), the body is a scrolling
  // terminal log, and while live a footer holds the stdin box + interrupt/stop.
  '.cm-run-head': { gap: '8px' },
  // Sizing/truncation come from the shared `.cm-pill` (shared/pill); the folder is
  // secondary to the command beside it, so it only dials the chip down a notch.
  '.cm-run-dir': {
    padding: '1px 7px',
    borderRadius: '6px',
    color: c.subtext0,
    fontSize: '11px',
  },
  '.cm-run-cmd': {
    flex: '1',
    minWidth: '0',
    color: c.teal,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '13px',
    fontWeight: '600',
    lineHeight: '1.4',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-run-log': {
    margin: '10px 0 0 0',
    // Even inset all round. The stdin footer is outside this bordered box and
    // already sits 12px below it, so extra bottom padding bought nothing — it just
    // made a short (or finished) log look bottom-heavy inside its own border. The
    // overlay adds real scroll room for the full-page log.
    padding: '10px',
    maxHeight: '340px',
    overflow: 'auto',
    backgroundColor: c.crust,
    border: `1px solid ${c.surface0}`,
    borderRadius: '8px',
    color: c.subtext0,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '12px',
    lineHeight: '1.45',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    WebkitOverflowScrolling: 'touch',
  },
  '.cm-run-stdin': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '13px',
  },
  '.cm-run-stdin:focus': { borderColor: c.teal },
  // Sized to sit over the composer box's bottom-right corner (`.cm-foot-actions`
  // in ask.js), which is also why the background stays opaque.
  '.cm-run-btn': {
    flexShrink: '0',
    boxSizing: 'border-box', // 30px total, borders in — see `.cm-ask-followup`
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '30px',
    height: '30px',
    padding: '0',
    border: `1px solid ${c.surface1}`,
    borderRadius: '8px',
    backgroundColor: c.surface0,
    color: c.text,
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-run-btn svg': { width: '17px', height: '17px' },
  '.cm-run-stop': { borderColor: c.red, color: c.red },
};
