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

import {
  cardContent,
  restoreCard,
  runIdeaChat,
  type AskHandle,
  type CardContent,
  type DashboardCard,
  type IdeaRef,
} from './controllers/aiController';

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
  /** The card as it read before each turn that went on to change it, oldest
   *  first — one entry per edit Claude has made to this idea in this session,
   *  and what {@link undoLast} puts back. Empty until Claude actually rewrites
   *  something, which is exactly when the page offers an undo. */
  undo: CardContent[];
  /** The card as it read when the running turn was sent, held until that turn's
   *  result is seen by {@link recordCard}: it becomes an undo entry if the turn
   *  changed the card, and is dropped if it didn't (most turns are questions and
   *  answers that leave the idea alone — those must not offer an undo). */
  pending?: CardContent;
}

const EMPTY: IdeaChatThread = { turns: [], draft: '', undo: [] };

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
 * conversation is on the card, and stays there — so the undo history stays too:
 * those edits are still there to be reverted.
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
    ...prev,
    draft: '',
    turns: [...prev.turns, { q: text, a: '', status: 'streaming' }],
    // How the idea reads going into this turn, so whatever Claude writes to the
    // card can be undone. An earlier pending snapshot survives: it predates this
    // turn too, and a turn whose result was never seen (the page was closed)
    // would otherwise lose its undo.
    pending: prev.pending ?? cardContent(idea),
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

function sameContent(a: CardContent, b: CardContent): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.priority === b.priority &&
    a.tags.length === b.tags.length &&
    a.tags.every((t, i) => t === b.tags[i])
  );
}

/**
 * Take the card as the server now has it — the page re-reads it whenever a turn
 * lands — and settle the snapshot taken when that turn was sent: kept as an undo
 * entry if Claude changed the idea, dropped if the turn only talked about it.
 *
 * Idempotent, which matters because the page also re-reads on open: with no
 * pending snapshot there's nothing to settle and this is a no-op. A read taken
 * while a turn is still streaming is ignored for the same reason — the edit that
 * turn is about to make hasn't landed yet, and settling on it would leave that
 * edit with no way back.
 */
export function recordCard(card: DashboardCard): void {
  const id = card.id;
  const t = getThread(id);
  if (!t.pending || handles.has(id)) return;
  const now = cardContent(card);
  const undo = sameContent(t.pending, now) ? t.undo : [...t.undo, t.pending];
  update(id, { ...t, undo, pending: undefined });
}

/** Whether Claude has edited this idea (so the page can offer to undo it). */
export function canUndo(id: string): boolean {
  return getThread(id).undo.length > 0;
}

/**
 * Revert the most recent edit Claude made to this idea, writing the snapshot from
 * before it back over the card. Steps back one edit at a time, so undoing twice
 * walks back two of Claude's rewrites.
 *
 * The entry is only dropped once the server has taken the write, so a failed undo
 * (server unreachable) can be retried rather than being silently spent; the caller
 * sees the failure as a rejected promise and re-reads the card either way.
 */
export async function undoLast(card: DashboardCard): Promise<void> {
  const id = card.id;
  const t = getThread(id);
  const snapshot = t.undo[t.undo.length - 1];
  if (!snapshot) return;
  await restoreCard(id, snapshot, card.source);
  const after = getThread(id);
  update(id, { ...after, undo: after.undo.filter(s => s !== snapshot) });
}

/** Cancel the streaming turn (the user hit Stop), keeping what arrived so far. */
export function stop(id: string): void {
  const handle = handles.get(id);
  if (!handle) return;
  handles.delete(id);
  handle.cancel();
  patchLast(id, { status: 'done' });
}
