import { c } from '../../theme/palette.js';
import { MIC, STOP, PLAY, PAUSE, EXPORT } from '../../ui/icons.js';
import { makeCornerButton } from '../../ui/buttons.js';
import { guardTaps, blockSelection } from '../../ui/events.js';
import { updateAiMarker, deleteCardLine } from '../marker.js';
import { post } from '../../bridge.js';

// mm:ss (or h:mm:ss past an hour) for a millisecond duration.
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * The /record card: one big button that toggles Record ↔ Stop, then Play ↔ Pause
 * on a finished clip. All heavy lifting (mic permission, the foreground service,
 * MediaRecorder, export) lives on the RN side; this only posts intents by id and
 * reflects the status RN commits back via __aiDone. States: idle → starting →
 * recording → stopping → stopped (or error). Only your own mic is captured —
 * Android blocks third-party apps from a phone call's remote audio.
 */
export function renderRecord(view, widget) {
  const obj = widget.obj;
  const status = obj.status || 'idle';
  const id = obj.id;
  // Set by the stopped branch; decides the top-right control (Export vs ×).
  let isStopped = false;

  const card = document.createElement('div');
  card.className = 'cm-ask cm-rec' + (status === 'error' ? ' cm-ask-error' : '');
  // Atomic, non-editable island so a long-press can't start selecting the card's
  // text on Android (which would hijack the hold-to-delete gesture).
  blockSelection(card);

  const row = document.createElement('div');
  row.className = 'cm-rec-row';

  // Taps on the card's controls must not reach CM (caret moves / card toggles).
  // A disabled control is greyed and inert (busy states).
  const tap = (el, fn, enabled = true) => {
    if (!enabled) {
      el.classList.add('cm-rec-disabled');
      return el;
    }
    return guardTaps(el, fn);
  };

  const btn = document.createElement('button');
  btn.className = 'cm-rec-btn';

  const meta = document.createElement('div');
  meta.className = 'cm-rec-meta';
  const title = document.createElement('div');
  title.className = 'cm-rec-title';
  title.textContent = obj.label || 'Voice recording';
  const sub = document.createElement('div');
  sub.className = 'cm-rec-sub';
  meta.appendChild(title);
  meta.appendChild(sub);

  const startRecording = () => {
    updateAiMarker(view, card, { status: 'starting', msg: undefined });
    post({ type: 'recordStart', id, label: obj.label || '' });
  };
  const stopRecording = () => {
    updateAiMarker(view, card, { status: 'stopping' });
    post({ type: 'recordStop', id });
  };

  if (status === 'idle' || status === 'error') {
    btn.classList.add('cm-rec-go');
    btn.innerHTML = MIC;
    sub.textContent =
      status === 'error'
        ? obj.msg || 'Recording failed — tap to try again.'
        : 'Records this device’s mic. Make sure everyone present consents.';
    tap(btn, startRecording);
  } else if (status === 'starting') {
    btn.classList.add('cm-rec-go', 'cm-rec-busy');
    btn.innerHTML = MIC;
    sub.textContent = 'Requesting microphone permission…';
    tap(btn, () => {}, false);
  } else if (status === 'recording') {
    btn.classList.add('cm-rec-stop');
    btn.innerHTML = STOP;
    // Live elapsed time: a self-updating text node so the ticking clock never
    // rewrites the document or forces a CM rebuild. Cleared in destroy().
    title.classList.add('cm-rec-live');
    const timer = document.createElement('span');
    timer.className = 'cm-rec-time';
    title.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'cm-rec-pulse';
    title.appendChild(dot);
    title.appendChild(timer);
    const startedAt = obj.startedAt || Date.now();
    const tick = () => {
      timer.textContent = fmtDuration(Date.now() - startedAt);
    };
    tick();
    card._recTimer = setInterval(tick, 500);
    sub.textContent = 'Recording — continues in the background via a notification.';
    tap(btn, stopRecording);
  } else if (status === 'stopping') {
    btn.classList.add('cm-rec-stop', 'cm-rec-busy');
    btn.innerHTML = STOP;
    sub.textContent = 'Saving…';
    tap(btn, () => {}, false);
  } else {
    // stopped: a finished clip. The round button plays / pauses it; deletion
    // lives on the Export button in the top-right, which a long-press on the card
    // morphs into Delete (makeCornerButton).
    isStopped = true;
    const playing = widget.playing;
    btn.classList.add('cm-rec-go');
    btn.innerHTML = playing ? PAUSE : PLAY;
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    tap(btn, () => {
      if (playing) post({ type: 'recordPause', id });
      else post({ type: 'recordPlay', id, file: obj.file || '' });
    });
    sub.textContent = playing
      ? 'Playing… · ' + fmtDuration(obj.ms)
      : 'Recorded ' + fmtDuration(obj.ms) + ' · hold to delete';
  }

  row.appendChild(btn);
  row.appendChild(meta);

  if (isStopped) {
    // Export in the top-right, long-pressing the card morphs it into Delete.
    row.appendChild(
      makeCornerButton({
        icon: EXPORT,
        label: 'Export',
        holdTarget: card,
        onActivate: () => post({ type: 'recordExport', id, file: obj.file || '' }),
        onDelete: () => {
          if (obj.file) post({ type: 'recordDiscard', file: obj.file });
          deleteCardLine(view, card);
        },
      }),
    );
  } else {
    // Delete × in the top-right for every non-stopped state. A card that owns the
    // live capture cancels it (stops + drops the partial); otherwise just drop its
    // file. Idle has nothing to clean up.
    const del = document.createElement('span');
    del.className = 'cm-rec-corner cm-rec-del';
    del.textContent = '×';
    tap(del, () => {
      if (status === 'starting' || status === 'recording' || status === 'stopping') {
        post({ type: 'recordCancel' });
      } else if (obj.file) {
        post({ type: 'recordDiscard', file: obj.file });
      }
      deleteCardLine(view, card);
    });
    row.appendChild(del);
  }

  card.appendChild(row);
  return card;
}

export const styles = {
  '.cm-rec': {
    display: 'block',
    padding: '10px 12px',
    maxWidth: '640px',
    // The card's title/sub text lives inside CM's contenteditable content, so a
    // long-press on the card would otherwise start Android's text selection
    // (stealing the play button's hold-to-delete gesture). Nothing in the card is
    // meant to be selected, so turn selection off for the whole card.
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
  },
  '.cm-rec-row': { display: 'flex', alignItems: 'center', gap: '12px' },
  '.cm-rec-btn': {
    flexShrink: '0',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '44px',
    height: '44px',
    padding: '0',
    border: 'none',
    borderRadius: '50%',
    cursor: 'pointer',
    // No native long-press selection/callout on the button; manipulation drops
    // the tap delay. (Hold-to-delete lives on the card + Export button now.)
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
    touchAction: 'manipulation',
    color: c.base,
  },
  '.cm-rec-btn svg': { display: 'block', width: '22px', height: '22px' },
  // Go = start / play (mauve); Stop = record-stop (red). Same button, swapped by
  // state. Armed = the play button held into Delete mode (red).
  '.cm-rec-go': { backgroundColor: c.mauve },
  '.cm-rec-stop': { backgroundColor: c.red, animation: 'cm-rec-glow 1.6s ease-in-out infinite' },
  '.cm-rec-armed': { backgroundColor: c.red },
  '.cm-rec-busy': { opacity: '0.6' },
  '.cm-rec-disabled': { cursor: 'default', opacity: '0.6', pointerEvents: 'none' },
  '.cm-rec-meta': { flex: '1', minWidth: '0' },
  '.cm-rec-title': {
    color: c.text,
    fontSize: '15px',
    fontWeight: '600',
    lineHeight: '1.3',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-rec-live': { display: 'flex', alignItems: 'center', gap: '8px' },
  '.cm-rec-time': { fontVariantNumeric: 'tabular-nums', color: c.red, fontWeight: '700' },
  '.cm-rec-pulse': {
    width: '9px',
    height: '9px',
    borderRadius: '50%',
    backgroundColor: c.red,
    animation: 'cm-ask-blink 1.2s ease-in-out infinite',
  },
  '.cm-rec-sub': { color: c.subtext0, fontSize: '12px', lineHeight: '1.35', marginTop: '2px' },
  '.cm-rec.cm-ask-error .cm-rec-sub': { color: c.red },
  '.cm-rec-del': { fontSize: '18px', lineHeight: '1', padding: '2px 4px' },
  '@keyframes cm-rec-glow': {
    '0%, 100%': { boxShadow: `0 0 0 0 ${c.red}66` },
    '50%': { boxShadow: `0 0 0 6px ${c.red}00` },
  },
};
