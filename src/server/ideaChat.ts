/**
 * App-level store for the idea pages' chats — one thread per idea card.
 *
 * Same reasoning as ./runRegistry: the run must outlive the view that started
 * it. An idea page is a Modal the user can close mid-answer (to check the
 * dashboard, or by reflex on Android's Back), and closing it must not kill the
 * turn Claude is streaming — nor lose the transcript, which is the context every
 * later turn is threaded with. So the thread and its live handle live here, in a
 * module singleton keyed by card id, and the page subscribes to it while mounted.
 *
 * Threads are kept for the session (they're small — a handful of turns of text)
 * so reopening an idea resumes the conversation where it was left, including any
 * text typed into the composer but never sent.
 */

import { runIdeaChat, type AskHandle, type IdeaRef } from './controllers/aiController';

/** One exchange: what the user asked, and the reply as it stands. */
export interface IdeaChatTurn {
  q: string;
  /** The answer so far — grows while `status` is 'streaming'. */
  a: string;
  status: 'streaming' | 'done' | 'error';
  /** Failure message, when `status` is 'error'. */
  msg?: string;
}

/** One idea's conversation, plus the composer text not yet sent. */
export interface IdeaChatThread {
  turns: IdeaChatTurn[];
  draft: string;
  /** How tall the user dragged the reply card in the page header, if they did.
   *  Kept with the thread rather than in the page so a card resized to read a
   *  long answer is still that size when the idea is reopened. */
  cardHeight?: number;
}

const EMPTY: IdeaChatThread = { turns: [], draft: '' };

// Immutable snapshots: every mutation replaces the thread object, so a
// useSyncExternalStore subscriber re-renders exactly when its thread changed and
// never on someone else's.
const threads = new Map<string, IdeaChatThread>();
const handles = new Map<string, AskHandle>();
const listeners = new Map<string, Set<() => void>>();

function emit(id: string): void {
  const set = listeners.get(id);
  if (!set) return;
  for (const fn of set) fn();
}

function update(id: string, next: IdeaChatThread): void {
  threads.set(id, next);
  emit(id);
}

// Replace the last turn (the one a live run is streaming into). A no-op if the
// thread was cleared out from under the run, so a late callback can't resurrect it.
function patchLast(id: string, patch: Partial<IdeaChatTurn>): void {
  const t = threads.get(id);
  if (!t || t.turns.length === 0) return;
  const turns = t.turns.slice();
  turns[turns.length - 1] = { ...turns[turns.length - 1], ...patch };
  update(id, { ...t, turns });
}

/** This idea's thread. Stable between changes, so it's safe as a snapshot. */
export function getThread(id: string): IdeaChatThread {
  return threads.get(id) ?? EMPTY;
}

/** Subscribe to one idea's thread; returns the unsubscribe. */
export function subscribe(id: string, fn: () => void): () => void {
  const set = listeners.get(id) ?? new Set<() => void>();
  listeners.set(id, set);
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(id);
  };
}

/** Whether a turn is streaming right now. */
export function isRunning(id: string): boolean {
  return handles.has(id);
}

/** Remember composer text the user hasn't sent, so closing the page doesn't lose it. */
export function setDraft(id: string, draft: string): void {
  const t = getThread(id);
  if (t.draft === draft) return;
  update(id, { ...t, draft });
}

/** Remember the height the reply card was dragged to. */
export function setCardHeight(id: string, cardHeight: number): void {
  const t = getThread(id);
  if (t.cardHeight === cardHeight) return;
  update(id, { ...t, cardHeight });
}

/**
 * Throw the conversation away (the user deleted the reply card): a turn still
 * streaming is cancelled first, since its callbacks would otherwise write into
 * the thread the user just cleared. The draft and the card's height stay — those
 * are the page's state, not the transcript's.
 *
 * Only the transcript goes. Anything Claude already wrote to the card during the
 * conversation is on the card, and stays there.
 */
export function clear(id: string): void {
  handles.get(id)?.cancel();
  handles.delete(id);
  update(id, { ...getThread(id), turns: [] });
}

/**
 * Ask `question` about `idea`. The whole prior transcript is threaded through so
 * the reply continues the conversation, and the draft is cleared (the question
 * has left the composer). A no-op while a turn is already streaming — the page
 * hides the send path then, and two concurrent runs would write to the same card.
 */
export function send(idea: IdeaRef, question: string): void {
  const id = idea.id;
  const text = question.trim();
  if (!text || handles.has(id)) return;

  const prev = getThread(id);
  const context = { turns: prev.turns.map(t => ({ q: t.q, a: t.a })) };
  update(id, {
    draft: '',
    turns: [...prev.turns, { q: text, a: '', status: 'streaming' }],
  });

  const handle = runIdeaChat(
    idea,
    text,
    {
      onDelta: answer => patchLast(id, { a: answer }),
      onDone: answer => {
        handles.delete(id);
        patchLast(id, { a: answer, status: 'done' });
      },
      onError: (msg, partial) => {
        handles.delete(id);
        patchLast(id, { a: partial, status: 'error', msg });
      },
    },
    // The card id doubles as the durable-session id, exactly as a /chat card's
    // does: one live turn per idea, resumable across a dropped socket.
    { id: `idea-chat:${id}` },
    context,
  );
  handles.set(id, handle);
  emit(id); // isRunning() flipped — repaint the composer's Stop control
}

/** Cancel the streaming turn (the user hit Stop), keeping what arrived so far. */
export function stop(id: string): void {
  const handle = handles.get(id);
  if (!handle) return;
  handles.delete(id);
  handle.cancel();
  patchLast(id, { status: 'done' });
}
