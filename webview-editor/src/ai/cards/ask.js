import { c } from '../../theme/palette.js';
import { makeCardActionButton } from '../../ui/buttons.js';
import { updateAiMarker, deleteCardLine } from '../marker.js';
import { mountAnswerView } from '../answerView.js';
import { thinkingDots } from '../shared/thinking.js';
import { growMdView, nearBottom, scrollBottomSoon } from '../shared/streamLog.js';

/**
 * The /ask card: the question is always visible in the header; tapping it
 * expands/collapses the accordion holding the streamed answer. The question +
 * collapse state persist in the doc; the answer streams from a live field until
 * it's committed to the marker on completion. /ask is one-shot — no follow-up box
 * (use /chat for a threaded conversation).
 */
export function renderAsk(view, widget) {
  const obj = widget.obj;
  const open = obj.open !== false;
  const status = widget.status;
  const answer = widget.answer;

  const card = document.createElement('div');
  card.className = 'cm-ask' + (status === 'error' ? ' cm-ask-error' : '');

  const head = document.createElement('div');
  head.className = 'cm-ask-head';

  const chev = document.createElement('span');
  chev.className = 'cm-ask-chev' + (open ? ' cm-open' : '');
  chev.textContent = '▶';
  head.appendChild(chev);

  const q = document.createElement('div');
  q.className = 'cm-ask-q';
  q.textContent = obj.q || '';
  head.appendChild(q);

  if (status === 'streaming') {
    const badge = document.createElement('span');
    badge.className = 'cm-ask-badge';
    badge.textContent = '···';
    head.appendChild(badge);
  }

  // Copy (the answer) lives in the header; long-pressing the card turns it into
  // a Delete button. The action button owns its own taps.
  head.appendChild(
    makeCardActionButton({
      copyValue: answer,
      onDelete: () => deleteCardLine(view, card),
      holdTarget: card,
      inline: true,
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
    body.className = 'cm-ask-body';

    if (status === 'error') {
      // Render whatever streamed before the failure as markdown, then the error.
      if (answer) card._mdView = mountAnswerView(body, answer);
      const err = document.createElement('div');
      err.className = 'cm-ask-answer cm-ask-answer-err';
      err.textContent = obj.msg || 'Something went wrong.';
      body.appendChild(err);
    } else if (!answer && status === 'streaming') {
      body.appendChild(thinkingDots({ label: 'Thinking…' }));
    } else if (status === 'streaming') {
      // Live-render the streaming answer as markdown (same as the finished note),
      // so links/lists/code parse as they arrive. To avoid remounting an editor
      // per token, updateAskStream appends new tokens into this view in place; the
      // header "···" badge signals it's still streaming.
      card._mdView = mountAnswerView(body, answer, { trim: false });
    } else {
      // Final answer: read-only markdown via a nested CodeMirror view.
      card._mdView = mountAnswerView(body, answer);
    }
    card.appendChild(body);
  }
  // Snapshot the render shape so updateAskStream can tell an in-place token append
  // (fast path) from a structural change (full rebuild).
  card._askSig = { id: obj.id, open, status };
  return card;
}

// Fast-path the hot case shared by /ask and /chat — the same open card streaming
// more tokens — by appending the delta to the mounted answer view. Everything
// else (thinking→first token, streaming→done, open toggle, error) returns false
// so CM rebuilds via toDOM.
export function updateAskStream(dom, view, widget) {
  const obj = widget.obj;
  const prev = dom._askSig;
  const md = dom._mdView;
  const turnCount = obj.turns ? obj.turns.length : undefined;
  if (
    md &&
    prev &&
    prev.id === obj.id &&
    prev.turns === turnCount &&
    prev.open &&
    obj.open !== false &&
    prev.status === 'streaming' &&
    widget.status === 'streaming'
  ) {
    // Was the reader pinned to the bottom BEFORE this chunk grew the card? Measure
    // first: once we append, scrollHeight jumps and the check is meaningless. If
    // they'd scrolled up to re-read, leave them be. Then re-pin so the newest
    // tokens stay visible and the answer visibly streams down.
    const scroller = view.scrollDOM;
    const stick = nearBottom(scroller);
    if (growMdView(md, widget.answer) && stick) scrollBottomSoon(scroller);
    dom._askSig = { id: obj.id, open: true, status: 'streaming', turns: prev.turns };
    return true;
  }
  return false;
}

export const styles = {
  '.cm-ask-answer': {
    color: c.subtext0,
    fontSize: '14px',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    paddingTop: '10px',
  },
  '.cm-ask-answer-err': { color: c.red },

  // The composer chrome shared by every card footer (chat follow-up, run stdin,
  // code prompt): a one-line input plus trailing button(s), separated from the
  // body by a hairline rule. /run and /code layer their own overrides on top.
  '.cm-ask-foot': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '12px',
    paddingTop: '12px',
    borderTop: `1px solid ${c.surface0}`,
  },
  '.cm-ask-followup': {
    flex: '1',
    minWidth: '0',
    backgroundColor: c.base,
    border: `1px solid ${c.surface1}`,
    borderRadius: '9px',
    color: c.text,
    fontFamily: '-apple-system, Roboto, sans-serif',
    fontSize: '14px',
    lineHeight: '1.4',
    padding: '8px 12px',
    outline: 'none',
  },
  '.cm-ask-followup::placeholder': { color: c.overlay1 },
  '.cm-ask-followup:focus': { borderColor: c.mauve },
  '.cm-ask-send': {
    flexShrink: '0',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '34px',
    height: '34px',
    color: c.base,
    backgroundColor: c.mauve,
    borderRadius: '9px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-ask-send svg': { display: 'block', width: '17px', height: '17px' },
};
