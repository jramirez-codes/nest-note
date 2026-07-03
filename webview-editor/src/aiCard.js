import { WidgetType } from '@codemirror/view';
import { makeCardActionButton } from './buttons.js';
import { updateAiMarker, deleteCardLine } from './aiMarker.js';
import { mountAnswerView, unmountAnswerView } from './answerView.js';

/**
 * The /ask card: the question is always visible in the header; tapping it
 * expands/collapses the accordion holding the streamed answer. Also renders the
 * compact /pair connection chip. Question + collapse state persist in the doc;
 * the answer streams from a live field until it's committed on completion.
 */
export class AiCardWidget extends WidgetType {
  constructor(obj, live) {
    super();
    this.obj = obj;
    this.live = live || null;
  }
  get answer() {
    return this.live && this.live.a != null ? this.live.a : this.obj.a || '';
  }
  get status() {
    return this.live ? this.live.status : this.obj.status || 'done';
  }
  get sig() {
    const o = this.obj;
    return [o.kind, o.id, o.q, o.msg, o.open, this.status, this.answer].join('');
  }
  eq(other) {
    return other.sig === this.sig;
  }
  toDOM(view) {
    return this.obj.kind === 'pair' ? this.pairDOM(view) : this.askDOM(view);
  }
  askDOM(view) {
    const open = this.obj.open !== false;
    const status = this.status;
    const answer = this.answer;

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
    q.textContent = this.obj.q || '';
    head.appendChild(q);

    if (status === 'streaming') {
      const badge = document.createElement('span');
      badge.className = 'cm-ask-badge';
      badge.textContent = '···';
      head.appendChild(badge);
    }

    // Copy (the answer) lives in the header now; long-pressing the card turns it
    // into a Delete button. The action button owns its own taps.
    const action = makeCardActionButton({
      copyValue: answer,
      onDelete: () => deleteCardLine(view, card),
      holdTarget: card,
      inline: true,
    });
    head.appendChild(action);

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

      const empty = !answer;
      if (status === 'error') {
        // Render whatever streamed before the failure as markdown, then the error.
        if (answer) card._mdView = mountAnswerView(body, answer);
        const err = document.createElement('div');
        err.className = 'cm-ask-answer cm-ask-answer-err';
        err.textContent = this.obj.msg || 'Something went wrong.';
        body.appendChild(err);
      } else if (empty && status === 'streaming') {
        const think = document.createElement('div');
        think.className = 'cm-ask-thinking';
        for (let i = 0; i < 3; i++) {
          const dot = document.createElement('span');
          dot.className = 'cm-ask-dot';
          think.appendChild(dot);
        }
        const label = document.createElement('span');
        label.textContent = 'Thinking…';
        think.appendChild(label);
        body.appendChild(think);
      } else if (status === 'streaming') {
        // While tokens are still arriving the widget rebuilds every chunk, so
        // keep the answer as cheap plain text (with a blinking caret) rather
        // than remounting a whole editor per token.
        const ans = document.createElement('div');
        ans.className = 'cm-ask-answer';
        ans.textContent = answer;
        const cur = document.createElement('span');
        cur.className = 'cm-ask-cursor';
        ans.appendChild(cur);
        body.appendChild(ans);
      } else {
        // Final answer: read-only markdown via a nested CodeMirror view.
        card._mdView = mountAnswerView(body, answer);
      }
      card.appendChild(body);
    }
    return card;
  }
  pairDOM(view) {
    const status = this.obj.status || 'pending';
    const card = document.createElement('div');
    card.className =
      'cm-ask cm-ask-pair' +
      (status === 'error' ? ' cm-ask-error' : status === 'ok' ? ' cm-ask-pair-ok' : '');

    const icon = document.createElement('span');
    icon.textContent = status === 'ok' ? '🔗' : status === 'error' ? '⚠️' : '⏳';
    card.appendChild(icon);

    const text = document.createElement('span');
    text.textContent =
      this.obj.msg || (status === 'ok' ? 'Connected' : status === 'error' ? 'Pairing failed' : 'Pairing…');
    card.appendChild(text);

    const del = document.createElement('span');
    del.className = 'cm-ask-del';
    del.textContent = '×';
    del.style.marginLeft = 'auto';
    del.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    del.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      deleteCardLine(view, card);
    });
    card.appendChild(del);
    return card;
  }
  // Tear down the nested answer editor when CM discards this card's DOM (answer
  // changed, card collapsed, or line deleted), so we don't leak EditorViews.
  destroy(dom) {
    if (dom && dom._mdView) {
      unmountAnswerView(dom._mdView);
      dom._mdView = null;
    }
  }
  ignoreEvent() {
    return true;
  }
}
