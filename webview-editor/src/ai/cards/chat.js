import { c } from '../../theme/palette.js';
import { SEND } from '../../ui/icons.js';
import { makeCardActionButton } from '../../ui/buttons.js';
import { updateAiMarker, deleteCardLine, appendChatTurn } from '../marker.js';
import { mountAnswerView } from '../answerView.js';
import { thinkingDots } from '../shared/thinking.js';
import { makeComposer } from '../shared/composer.js';

/**
 * The /chat card: a threaded conversation in one block. The header shows the
 * opening question and toggles the accordion; the body renders every turn in
 * order (each later turn's question as a small prompt bubble, then its answer)
 * and, whenever the thread is idle, the follow-up composer that continues it.
 * The streaming last turn is appended to in place by updateAskStream (ask.js).
 */
export function renderChat(view, widget) {
  const obj = widget.obj;
  const open = obj.open !== false;
  const status = widget.status;
  const turns = obj.turns || [];

  const card = document.createElement('div');
  card.className = 'cm-ask cm-chat' + (status === 'error' ? ' cm-ask-error' : '');

  const head = document.createElement('div');
  head.className = 'cm-ask-head';

  const chev = document.createElement('span');
  chev.className = 'cm-ask-chev' + (open ? ' cm-open' : '');
  chev.textContent = '▶';
  head.appendChild(chev);

  const q = document.createElement('div');
  q.className = 'cm-ask-q';
  q.textContent = turns.length ? turns[0].q || '' : '';
  head.appendChild(q);

  if (status === 'streaming') {
    const badge = document.createElement('span');
    badge.className = 'cm-ask-badge';
    badge.textContent = '···';
    head.appendChild(badge);
  }

  head.appendChild(
    makeCardActionButton({
      copyValue: widget.answer,
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
    // Chat mounts one nested answer view per turn; track them all so destroy()
    // can tear every one down (not just the last streaming one).
    card._mdViews = [];

    turns.forEach((t, idx) => {
      const isLast = idx === turns.length - 1;
      // The opening question already sits in the header; later turns show theirs
      // inline so the thread reads as a back-and-forth.
      if (idx > 0) {
        const uq = document.createElement('div');
        uq.className = 'cm-chat-q';
        uq.textContent = t.q || '';
        body.appendChild(uq);
      }
      const answer = isLast ? widget.answer : t.a || '';
      const turnBox = document.createElement('div');
      turnBox.className = 'cm-chat-a';
      body.appendChild(turnBox);

      if (isLast && status === 'error') {
        if (answer) card._mdViews.push(mountAnswerView(turnBox, answer));
        const err = document.createElement('div');
        err.className = 'cm-ask-answer cm-ask-answer-err';
        err.textContent = obj.msg || 'Something went wrong.';
        turnBox.appendChild(err);
      } else if (!answer && isLast && status === 'streaming') {
        turnBox.appendChild(thinkingDots({ label: 'Thinking…' }));
      } else {
        const streaming = isLast && status === 'streaming';
        const mv = mountAnswerView(turnBox, answer, { trim: !streaming });
        card._mdViews.push(mv);
        // Only the last, live turn is appended to token-by-token in updateAskStream.
        if (streaming) card._mdView = mv;
      }
    });

    // The follow-up composer threads the whole transcript, so a reply genuinely
    // continues the convo. Shown only when the thread is idle, never mid-stream.
    if (status !== 'streaming') body.appendChild(followupFoot(view, card));
    card.appendChild(body);
  }
  card._askSig = { id: obj.id, open, status, turns: turns.length };
  return card;
}

// Footer input that fires a follow-up question — appends a new turn to this chat
// card and re-streams it (appendChatTurn threads the whole prior transcript as
// context so the server answers in-conversation).
function followupFoot(view, card) {
  return makeComposer({
    footClass: 'cm-ask-foot',
    inputClass: 'cm-ask-followup',
    placeholder: 'Ask a follow-up…',
    onSubmit: input => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      appendChatTurn(view, card, text);
    },
    buttons: [{ tag: 'span', className: 'cm-ask-send', icon: SEND, submit: true }],
  });
}

export const styles = {
  // Each follow-up turn shows its question as a small prompt bubble above the
  // answer, so a multi-turn thread reads as a back-and-forth.
  '.cm-chat-q': {
    margin: '16px 0 8px',
    padding: '7px 11px',
    borderRadius: '9px',
    backgroundColor: c.surface0,
    color: c.subtext0,
    fontSize: '14px',
    lineHeight: '1.4',
    whiteSpace: 'pre-wrap',
  },
};
