import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyDashboardAction,
  completeCard,
  dismissCard,
  fetchDashboardState,
  getCachedDashboardState,
  setCachedDashboardState,
  type DashboardCard,
  type DashboardState,
  type DashboardSuggestion,
} from '../../server/controllers/aiController';

/**
 * DashboardPage's data layer: fetching/caching the dashboard state and the three
 * mutations (merge/dismiss a suggestion, toggle a task, dismiss a card). Split out
 * of the component so DashboardPage stays a presentational shell over this plus its
 * own UI-only selection state (which notebook/task-sort/expanded-row is active).
 */
export function useDashboardData(isActive: boolean) {
  // Seed from the module cache so a remount (the common case — swiping back to the
  // dashboard, which the pager unmounts at rest) paints the last-known cards at once
  // instead of flashing the spinner. A silent background refresh then reconciles.
  const [state, setState] = useState<DashboardState | null>(() => getCachedDashboardState());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Keys (suggestion 'into' or card id) currently being acted on, to disable their
  // controls while the write is in flight.
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // Guard against setState after unmount / after a newer fetch superseded this one.
  const reqSeq = useRef(0);

  // 'initial' shows the centered loader (only when there's nothing on screen yet),
  // 'refresh' drives the pull-to-refresh control, and 'silent' reconciles in the
  // background with no visible indicator — used for auto-refreshes when cards are
  // already showing, so returning to the dashboard never flashes a spinner.
  const load = useCallback(async (mode: 'initial' | 'refresh' | 'silent') => {
    const seq = ++reqSeq.current;
    if (mode === 'refresh') setRefreshing(true);
    else if (mode === 'initial') setLoading(true);
    try {
      const data = await fetchDashboardState();
      if (seq !== reqSeq.current) return;
      setState(data);
      setError(null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === reqSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Keep the module cache in step with the latest state (fresh fetches and optimistic
  // edits alike), so the next remount seeds from current data rather than a stale snapshot.
  useEffect(() => {
    if (state) setCachedDashboardState(state);
  }, [state]);

  // Fetch on mount and whenever the page is flipped to (so ingesting a page and
  // swiping here shows the freshly filed notes). When cards are already on screen
  // (seeded from cache, or previously loaded) the refresh is silent — no spinner.
  const wasActive = useRef(false);
  useEffect(() => {
    if (isActive && !wasActive.current) load('silent');
    wasActive.current = isActive;
  }, [isActive, load]);
  useEffect(() => {
    // A cold start with no cache shows the loader; a cache hit reconciles silently.
    load(getCachedDashboardState() ? 'silent' : 'initial');
    // Capture the ref object so the cleanup mutates the same counter even if the
    // component's ref were to change; bumping it invalidates any in-flight fetch.
    const seq = reqSeq;
    return () => {
      seq.current++; // invalidate any in-flight fetch on unmount
    };
  }, [load]);

  // Shared shape for onToggle/onDismiss: mark busy, apply an optimistic patch, await
  // the write, and on failure apply the inverse patch and surface the error — always
  // clearing busy. `act` doesn't fit this (it commits only after the write succeeds),
  // so it's written out separately below.
  const withOptimisticUpdate = useCallback(
    async (
      key: string,
      patch: (prev: DashboardState) => DashboardState,
      revert: (prev: DashboardState) => DashboardState,
      request: () => Promise<unknown>,
    ) => {
      setBusy(b => ({ ...b, [key]: true }));
      setState(prev => (prev ? patch(prev) : prev));
      try {
        await request();
      } catch (e) {
        setState(prev => (prev ? revert(prev) : prev));
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(b => ({ ...b, [key]: false }));
      }
    },
    [],
  );

  const act = useCallback(
    async (s: DashboardSuggestion, action: 'merge' | 'dismiss') => {
      setBusy(b => ({ ...b, [s.into]: true }));
      try {
        await applyDashboardAction({ action, into: s.into, from: s.from });
        // Drop the suggestion locally; a merge also changes servers, so refetch.
        setState(prev =>
          prev
            ? { ...prev, suggestions: prev.suggestions.filter(x => x.into !== s.into) }
            : prev,
        );
        if (action === 'merge') load('refresh');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(b => ({ ...b, [s.into]: false }));
      }
    },
    [load],
  );

  // Toggle a task's done state with an optimistic flip, reverted if the write fails.
  const onToggle = useCallback(
    (card: DashboardCard) => {
      const next = !card.done;
      return withOptimisticUpdate(
        card.id,
        prev => ({ ...prev, cards: prev.cards.map(c => (c.id === card.id ? { ...c, done: next } : c)) }),
        prev => ({ ...prev, cards: prev.cards.map(c => (c.id === card.id ? { ...c, done: !next } : c)) }),
        () => completeCard(card.id, next, card.source),
      );
    },
    [withOptimisticUpdate],
  );

  // Dismiss a card, removing it optimistically and restoring it if the write fails.
  const onDismiss = useCallback(
    (card: DashboardCard) =>
      withOptimisticUpdate(
        card.id,
        prev => ({ ...prev, cards: prev.cards.filter(c => c.id !== card.id) }),
        prev => ({ ...prev, cards: [...prev.cards, card] }),
        () => dismissCard(card.id, card.source),
      ),
    [withOptimisticUpdate],
  );

  return { state, error, loading, refreshing, busy, load, act, onToggle, onDismiss };
}
