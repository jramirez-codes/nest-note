import { WidgetType } from '@codemirror/view';
import { makeCardActionButton } from './buttons.js';
import {
  updateAiMarker,
  deleteCardLine,
  insertFollowupCard,
  restoreCleanBackup,
} from './aiMarker.js';
import { mountAnswerView, unmountAnswerView, streamAppend } from './answerView.js';

// Paper-plane icon for the follow-up "send" button, drawn with currentColor.
const ICON_SEND =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<line x1="22" y1="2" x2="11" y2="13"/>' +
  '<polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

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
    if (this.obj.kind === 'pair') return this.pairDOM(view);
    if (this.obj.kind === 'clean') return this.cleanDOM(view);
    return this.askDOM(view);
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
        // Live-render the streaming answer as markdown (same as the finished
        // note), so links/lists/code parse as they arrive. To avoid remounting
        // an editor per token, updateDOM() appends new tokens into this view in
        // place; the header "···" badge signals it's still streaming.
        card._mdView = mountAnswerView(body, answer, { trim: false });
      } else {
        // Final answer: read-only markdown via a nested CodeMirror view.
        card._mdView = mountAnswerView(body, answer);
      }
      // Once an answer has landed, offer a one-line follow-up box in the footer.
      // Disabled for now: the follow-up doesn't retain the conversation, so it's
      // not much use yet.
      // if (status === 'done') body.appendChild(this.followupFoot(view, card));
      card.appendChild(body);
    }
    // Snapshot the render shape so updateDOM can tell an in-place token append
    // (fast path) from a structural change (full rebuild).
    card._askSig = { id: this.obj.id, open, status };
    return card;
  }
  // CM calls this when the widget changed (eq false) before falling back to a
  // full toDOM. Fast-path the hot case — the same open card streaming more
  // tokens — by appending the delta to the mounted answer view. Everything else
  // (thinking→first token, streaming→done, open toggle, error, pair) returns
  // false so CM rebuilds via toDOM.
  updateDOM(dom, view) {
    const prev = dom._askSig;
    const md = dom._mdView;
    if (
      this.obj.kind === 'ask' &&
      md &&
      prev &&
      prev.id === this.obj.id &&
      prev.open &&
      this.obj.open !== false &&
      prev.status === 'streaming' &&
      this.status === 'streaming'
    ) {
      const cur = md.state.doc.toString();
      const next = this.answer;
      if (next !== cur) {
        // Was the reader pinned to the bottom BEFORE this chunk grew the card?
        // Measure first: once we append, scrollHeight jumps and the check is
        // meaningless. If they'd scrolled up to re-read, leave them be.
        const scroller = view.scrollDOM;
        const stick =
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
        // Streamed answers are cumulative, so this is normally an end-insert;
        // fall back to a full replace if a chunk ever rewrites earlier text.
        const change = next.startsWith(cur)
          ? { from: cur.length, insert: next.slice(cur.length) }
          : { from: 0, to: md.state.doc.length, insert: next };
        md.dispatch({ changes: change, annotations: streamAppend.of(true) });
        // Re-pin to the bottom after the append reflows, so the newest tokens
        // stay visible and the answer visibly streams down. rAF waits for the
        // grown nested view to lay out; otherwise scrollHeight is still stale.
        if (stick) {
          requestAnimationFrame(() => {
            scroller.scrollTop = scroller.scrollHeight;
          });
        }
      }
      dom._askSig = { id: this.obj.id, open: true, status: 'streaming' };
      return true;
    }
    return false;
  }
  // Footer input that fires a follow-up question. Submitting spawns a fresh /ask
  // card on the line below this one, threading this Q&A through as context so the
  // server answers in-conversation.
  followupFoot(view, card) {
    const foot = document.createElement('div');
    foot.className = 'cm-ask-foot';

    const input = document.createElement('input');
    input.className = 'cm-ask-followup';
    input.type = 'text';
    input.placeholder = 'Ask a follow-up…';

    const send = document.createElement('span');
    send.className = 'cm-ask-send';
    send.innerHTML = ICON_SEND;

    const q = this.obj.q || '';
    const a = this.answer;
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      insertFollowupCard(view, card, text, { q, a });
    };

    // Keep pointer/keys inside the input from reaching CM (which would move the
    // caret or toggle the card); Enter sends, everything else types normally.
    const stop = e => e.stopPropagation();
    input.addEventListener('mousedown', stop);
    input.addEventListener('touchstart', stop, { passive: true });
    input.addEventListener('click', stop);
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    send.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    send.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      submit();
    });

    foot.appendChild(input);
    foot.appendChild(send);
    return foot;
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
  // The /clean bar: a slim status chip while the page is being rewritten, then
  // an Accept / Reject review bar once the cleaned text has replaced the doc.
  // Accept drops this marker (keeping the new text); Reject restores the backup.
  cleanDOM(view) {
    const status = this.obj.status || 'review';
    const card = document.createElement('div');
    card.className =
      'cm-ask cm-clean' +
      (status === 'error'
        ? ' cm-ask-error'
        : status === 'review'
        ? ' cm-clean-review'
        : '');

    const icon = document.createElement('span');
    icon.className = 'cm-clean-icon';
    icon.textContent = status === 'error' ? '⚠️' : '✨';
    card.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'cm-clean-text';
    card.appendChild(text);

    if (status === 'streaming') {
      text.textContent = this.obj.msg || 'Cleaning up your notes…';
      const think = document.createElement('span');
      think.className = 'cm-ask-thinking cm-clean-dots';
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'cm-ask-dot';
        think.appendChild(dot);
      }
      card.appendChild(think);
    } else if (status === 'error') {
      text.textContent = this.obj.msg || 'Cleanup failed.';
      card.appendChild(this.cleanButton('Dismiss', 'cm-clean-reject', () =>
        deleteCardLine(view, card),
      ));
    } else {
      text.textContent = 'Cleaned up — review the changes';
      const actions = document.createElement('span');
      actions.className = 'cm-clean-actions';
      actions.appendChild(
        this.cleanButton('Reject', 'cm-clean-reject', () =>
          restoreCleanBackup(view, card),
        ),
      );
      actions.appendChild(
        this.cleanButton('Accept', 'cm-clean-accept', () => deleteCardLine(view, card)),
      );
      card.appendChild(actions);
    }
    return card;
  }
  // A card button that keeps its taps away from CM (which would move the caret
  // or toggle a card) and runs `onTap` on click.
  cleanButton(label, cls, onTap) {
    const btn = document.createElement('button');
    btn.className = 'cm-clean-btn ' + cls;
    btn.textContent = label;
    btn.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      onTap();
    });
    return btn;
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
