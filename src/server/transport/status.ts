/**
 * A tiny observable for the companion server's live reachability, shared by the
 * whole app (the header status bubble, and anywhere else that cares).
 *
 * It's a module singleton rather than React state because connectivity is a
 * global fact — one phone, one paired laptop — and it's written from both
 * non-React call sites (aiController's ping/pair/run) and read from components.
 * Components subscribe via `useServerStatus` (useSyncExternalStore under the
 * hood), so a write here re-renders every bubble on screen.
 */

export type ServerStatus =
  | 'unknown' // never checked yet this session
  | 'checking' // a health probe is in flight
  | 'connected' // last probe (or run) reached the paired server
  | 'disconnected'; // no server paired, or the last probe/run failed

let status: ServerStatus = 'unknown';
const listeners = new Set<() => void>();

/** The current status. */
export function getServerStatus(): ServerStatus {
  return status;
}

/** Update the status and notify subscribers (no-op if unchanged). */
export function setServerStatus(next: ServerStatus): void {
  if (next === status) return;
  status = next;
  for (const l of listeners) l();
}

/** Subscribe to status changes; returns an unsubscribe fn. */
export function subscribeServerStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
