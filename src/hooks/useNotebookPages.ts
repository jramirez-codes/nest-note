import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchNotebookIndex, fetchPage, type NotePage } from '../server/controllers/aiController';

export interface UseNotebookPagesResult {
  /** Ordered page stubs (Appendix first); empty until the index loads. */
  stubs: NotePage[];
  /** Page bodies fetched so far, keyed by page number. Missing == not yet pulled. */
  bodies: Record<number, string>;
  /** True while the page index itself loads (the first fetch after a swap). */
  loading: boolean;
  /** Set if the index or a page fetch failed. */
  error: string | null;
  /** Ensure the given page numbers are fetched — missing ones are pulled, dupes skipped. */
  ensure: (nums: number[]) => void;
}

const EMPTY_STUBS: NotePage[] = [];

/**
 * Loads a subject notebook's pages lazily for the virtualized reader. Swapping to a
 * notebook (`slug`) pulls its cheap index (page stubs, no bodies) and warms the first and
 * last page; `ensure` then pulls a page and its neighbours on demand as the reader swipes,
 * so a page is almost always already in hand by the time it's shown. Passing `null` (the
 * Sandbox / local pad) clears everything.
 */
export function useNotebookPages(slug: string | null): UseNotebookPagesResult {
  const [stubs, setStubs] = useState<NotePage[]>(EMPTY_STUBS);
  const [bodies, setBodies] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // seq guards against a slower, superseded swap clobbering a newer one. haveRef mirrors
  // the fetched page nums synchronously (state is async), inFlight de-dupes concurrent
  // pulls, and validNums restricts fetches to pages the index actually lists.
  const seq = useRef(0);
  const haveRef = useRef<Set<number>>(new Set());
  const inFlight = useRef<Set<number>>(new Set());
  const validNums = useRef<Set<number>>(new Set());

  const ensure = useCallback(
    (nums: number[]) => {
      if (!slug) return;
      const mySeq = seq.current;
      for (const num of nums) {
        if (!validNums.current.has(num)) continue;
        if (haveRef.current.has(num) || inFlight.current.has(num)) continue;
        inFlight.current.add(num);
        fetchPage(slug, num)
          .then(page => {
            if (seq.current !== mySeq) return; // a newer swap superseded this one
            haveRef.current.add(num);
            setBodies(prev => ({ ...prev, [num]: page.body }));
          })
          .catch(e => {
            if (seq.current !== mySeq) return;
            setError(e instanceof Error ? e.message : String(e));
          })
          .finally(() => {
            inFlight.current.delete(num);
          });
      }
    },
    [slug],
  );

  // Keep the latest `ensure` reachable from the load effect without widening its deps
  // (which would re-run the whole index fetch on every render).
  const ensureRef = useRef(ensure);
  ensureRef.current = ensure;

  useEffect(() => {
    const mySeq = ++seq.current;
    haveRef.current = new Set();
    inFlight.current = new Set();
    validNums.current = new Set();
    setBodies({});
    setError(null);

    if (!slug) {
      setStubs(EMPTY_STUBS);
      setLoading(false);
      return;
    }

    setStubs(EMPTY_STUBS);
    setLoading(true);
    fetchNotebookIndex(slug)
      .then(detail => {
        if (seq.current !== mySeq) return;
        const pages = detail.pages ?? [];
        validNums.current = new Set(pages.map(p => p.num));
        setStubs(pages);
        setLoading(false);
        // Warm the ends up front, as the spec asks: pull the first and last page bodies.
        if (pages.length > 0) {
          ensureRef.current([pages[0].num, pages[pages.length - 1].num]);
        }
      })
      .catch(e => {
        if (seq.current !== mySeq) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [slug]);

  return { stubs, bodies, loading, error, ensure };
}
