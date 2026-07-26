import { c } from '../../theme/palette.js';
import { SEND, EXPAND, CHAT } from '../../ui/icons.js';
import { makeCopyButton, makeCornerButton } from '../../ui/buttons.js';
import { updateAiMarker, deleteCardLine, appendChatTurn } from '../marker.js';
import { openCardOverlay } from '../overlay.js';
import { mountAnswerView } from '../answerView.js';
import { thinkingDots } from '../shared/thinking.js';
import { makeComposer } from '../shared/composer.js';
import { scrollBottomSoon } from '../shared/streamLog.js';

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

  // /talk cards (kind:'notes-chat') pin to one subject notebook — badge it like
  // the /code card badges its project, so both "persistent, named context" cards
  // read the same way.
  if (obj.kind === 'notes-chat') {
    const subj = document.createElement('span');
    subj.className = 'cm-chat-subject';
    subj.innerHTML = CHAT;
    const label = document.createElement('span');
    label.textContent = obj.subject || '';
    subj.appendChild(label);
    subj.title = 'Subject: ' + (obj.subject || '');
    head.appendChild(subj);
  }

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

  // Copy is always just Copy now — Delete lives on the corner control below.
  head.appendChild(makeCopyButton(widget.answer, { inline: true }));

  // Corner control: Expand by default (tap → full-page thread); a long-press
  // anywhere on the card morphs it into Delete for 3s, same gesture as /code
  // and /run — not tied to the accordion's open/closed state.
  const corner = makeCornerButton({
    icon: EXPAND,
    label: 'Expand',
    holdTarget: card,
    onActivate: () => openCardOverlay(view, obj),
    onDelete: () => deleteCardLine(view, card),
  });
  corner.classList.add('cm-chat-expand');
  head.appendChild(corner);

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

    // The transcript scrolls inside a capped box (same max height as the /run
    // log), so a long thread doesn't push the card taller than the screen. The
    // follow-up composer sits OUTSIDE it, staying pinned below while the turns
    // scroll — exactly like the /run stdin footer under its log.
    const log = document.createElement('div');
    log.className = 'cm-chat-log';
    card._chatScroll = log;

    turns.forEach((t, idx) => {
      const isLast = idx === turns.length - 1;
      // The opening question already sits in the header; later turns show theirs
      // inline so the thread reads as a back-and-forth.
      if (idx > 0) {
        const uq = document.createElement('div');
        uq.className = 'cm-chat-q';
        uq.textContent = t.q || '';
        log.appendChild(uq);
      }
      const answer = isLast ? widget.answer : t.a || '';
      const turnBox = document.createElement('div');
      turnBox.className = 'cm-chat-a';
      log.appendChild(turnBox);

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

    body.appendChild(log);
    scrollBottomSoon(log); // open pinned to the newest turn

    // The follow-up composer threads the whole transcript, so a reply genuinely
    // continues the convo. Shown only when the thread is idle, never mid-stream.
    if (status !== 'streaming') body.appendChild(followupFoot(view, card, obj.id));
    card.appendChild(body);
  }
  card._askSig = { id: obj.id, open, status, turns: turns.length };
  return card;
}

// Footer input that fires a follow-up question — appends a new turn to this chat
// card and re-streams it (appendChatTurn threads the whole prior transcript as
// context so the server answers in-conversation).
function followupFoot(view, card, id) {
  return makeComposer({
    footClass: 'cm-ask-foot',
    inputClass: 'cm-ask-followup',
    placeholder: 'Ask a follow-up…',
    draftKey: id,
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
  // The Expand/Delete control sits inline in the flex header (centered, not
  // pinned to the top like its /run + /code corner-button cousins).
  '.cm-chat-expand': { alignSelf: 'center' },
  // The /talk subject pill — mirrors /code's `.cm-code-proj` project chip, with a
  // chat-bubble icon in place of the "✦" star.
  '.cm-chat-subject': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: '0',
    maxWidth: '40%',
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
  },
  '.cm-chat-subject span': { overflow: 'hidden', textOverflow: 'ellipsis' },
  '.cm-chat-subject svg': { display: 'block', width: '13px', height: '13px', flexShrink: '0' },
  // The inline transcript scroller: capped at the same height as the /run log so a
  // long thread scrolls in place instead of stretching the card past the screen.
  // The overlay's own `.cm-ov .cm-chat-log` rule lifts this cap for the full page.
  '.cm-chat-log': {
    maxHeight: '340px',
    overflow: 'auto',
    paddingBottom: '20px',
    WebkitOverflowScrolling: 'touch',
  },
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
