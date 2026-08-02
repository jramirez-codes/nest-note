/**
 * App-level store for the dashboard's voice chat — the one conversation the
 * footer mic drives while the dashboard is the page on screen.
 *
 * Same reasoning as ./ideaChat and ./runRegistry: the run must outlive the view
 * that started it. The card this chat is shown in floats over the dashboard, and
 * the dashboard is a page in a pager that unmounts as soon as the user swipes
 * off it — so a turn Claude is streaming would die with it, and the transcript
 * every later turn is threaded with would go too. Both live here instead, in a
 * module singleton the card subscribes to while it's mounted.
 *
 * One thread, not one per notebook: the conversation is with the dashboard, and
 * the notebook it's filtered to is only where a card gets filed (see `scope` on
 * {@link send}). Switching notebooks mid-conversation is a change of subject, not
 * a change of chat.
 *
 * Unlike an idea chat there is no undo here. Those turns rewrite one known card,
 * which the page can snapshot and put back; these turns create, edit and remove
 * cards across the dashboard, and the dashboard's own controls (complete,
 * dismiss, drag-to-delete) are what take those back.
 */

import { runDashboardChat, type AskHandle } from './controllers/aiController';

/** One exchange: what the user said, and the reply as it stands. */
export interface DashboardChatTurn {
  q: string;
  /** The answer so far — grows while `status` is 'streaming'. */
  a: string;
  status: 'streaming' | 'done' | 'error';
  /** Failure message, when `status` is 'error'. */
  msg?: string;
}

export interface DashboardChatState {
  /** What the mic has dictated but not yet sent — the message the footer's send
   *  button posts, and what the card puts in its editable box. */
  draft: string;
  turns: DashboardChatTurn[];
  /** Whether a turn is streaming right now. Part of the snapshot (rather than a
   *  separate getter, as ideaChat has) because the footer button reads it to
   *  decide whether its slot sends the next message or stops this one. */
  running: boolean;
}

const EMPTY: DashboardChatState = { draft: '', turns: [], running: false };

// An immutable snapshot: every mutation replaces the object, so
// useSyncExternalStore subscribers re-render exactly when something changed.
let state: DashboardChatState = EMPTY;
let handle: AskHandle | null = null;
const listeners = new Set<() => void>();

function update(next: Partial<DashboardChatState>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

// Replace the last turn (the one a live run is streaming into). A no-op if the
// thread was cleared out from under the run, so a late callback can't resurrect it.
function patchLast(patch: Partial<DashboardChatTurn>): void {
  if (state.turns.length === 0) return;
  const turns = state.turns.slice();
  turns[turns.length - 1] = { ...turns[turns.length - 1], ...patch };
  update({ turns });
}

/** The current conversation. Stable between changes, so it's safe as a snapshot. */
export function getState(): DashboardChatState {
  return state;
}

/** Subscribe to the conversation; returns the unsubscribe. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Set the message waiting to be sent. Called as speech arrives (the card's
 * dictation sink appends to it) and as the user edits it by hand, so a
 * mistranscription can be fixed before it goes anywhere.
 */
export function setDraft(draft: string): void {
  if (state.draft === draft) return;
  update({ draft });
}

/**
 * Send the pending message as the next turn, threaded with the whole transcript
 * so the reply continues the conversation. `scope` is the notebook the dashboard
 * is filtered to (a subject slug, or null on the Sandbox's aggregate view).
 *
 * A no-op with an empty draft or while a turn is already streaming: two
 * concurrent runs would be two agents writing to the same set of cards.
 */
export function send(scope: string | null): void {
  const text = state.draft.trim();
  if (!text || handle) return;

  const context = { turns: state.turns.map(t => ({ q: t.q, a: t.a })) };
  update({
    // The message has left the box — it's the turn's now.
    draft: '',
    turns: [...state.turns, { q: text, a: '', status: 'streaming' }],
    running: true,
  });

  handle = runDashboardChat(
    text,
    scope,
    {
      onDelta: answer => patchLast({ a: answer }),
      onDone: answer => {
        handle = null;
        patchLast({ a: answer, status: 'done' });
        update({ running: false });
      },
      onError: (msg, partial) => {
        handle = null;
        patchLast({ a: partial, status: 'error', msg });
        update({ running: false });
      },
    },
    // A fixed durable-session id: there is only ever one dashboard turn in
    // flight, and naming it means a dropped socket resumes that same run rather
    // than starting a second one over the same cards.
    { id: 'dashboard-chat' },
    context,
  );
}

/** Cancel the streaming turn, keeping what arrived so far. */
export function stop(): void {
  if (!handle) return;
  handle.cancel();
  handle = null;
  patchLast({ status: 'done' });
  update({ running: false });
}

/**
 * Throw the whole conversation away — what the card's ✕ does. A turn still
 * streaming is cancelled first, since its callbacks would otherwise write into
 * the thread the user just cleared.
 *
 * The draft goes with it: the card is one surface, and dismissing it to reclaim
 * the space over the dashboard means dismissing the message sitting in it too.
 * Nothing Claude already wrote to a card is affected — that's on the dashboard.
 */
export function clear(): void {
  handle?.cancel();
  handle = null;
  update(EMPTY);
}
