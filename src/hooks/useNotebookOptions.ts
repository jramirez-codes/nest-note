import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchDashboardState,
  getCachedDashboardState,
  setCachedDashboardState,
  type DashboardState,
} from '../server/controllers/aiController';
import { buildNotebookOptions } from '../components/dashboard/cardModel';
import type { NotebookOption } from '../components/dashboard/NotebookSwitcher';

/**
 * The notebook list for the header's compact switcher badge, kept independent of the
 * dashboard page (which may be unmounted while the user is reading a note). It seeds
 * from the shared dashboard-state cache so the badge paints the last-known notebooks
 * at once, does a silent fetch on mount, and exposes `refresh` for the badge to call
 * as its menu opens — so swapping is always against a current list. A fetch that fails
 * (offline / unpaired) is swallowed, leaving whatever the cache already gave us.
 */
export function useNotebookOptions(): { options: NotebookOption[]; refresh: () => void } {
  const [state, setState] = useState<DashboardState | null>(() => getCachedDashboardState());
  // Bumped on every fetch so a slow response can't clobber a newer one (or fire after unmount).
  const seq = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++seq.current;
    fetchDashboardState()
      .then(data => {
        if (mine !== seq.current) return;
        setState(data);
        setCachedDashboardState(data);
      })
      .catch(() => {
        /* offline / unpaired: keep the cached options */
      });
  }, []);

  useEffect(() => {
    refresh();
    const s = seq;
    return () => {
      s.current++; // invalidate any in-flight fetch on unmount
    };
  }, [refresh]);

  const options = useMemo(
    () => buildNotebookOptions(state?.cards ?? [], state?.servers ?? []),
    [state],
  );

  return { options, refresh };
}
