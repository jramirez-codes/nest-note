/**
 * Live companion-server reachability for UI. Reads the shared status store and
 * keeps it fresh by probing `/health`: once on mount, on a slow timer, and each
 * time the app returns to the foreground (a laptop that slept or changed IP
 * while we were backgrounded is the common way a connection silently dies).
 *
 * The store is a module singleton, so many mounted bubbles share one poll cadence
 * only if they each poll — to avoid N components hammering the server, the poll
 * lives here but the interval is generous and the probe is cheap and idempotent.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import {
  getServerStatus,
  subscribeServerStatus,
  type ServerStatus,
} from '../server/status';
import { pingServer } from '../server/aiController';
import { fireAndForget } from '../utils/async';

/** How often to re-probe while the app is foregrounded. */
const POLL_MS = 20_000;

export function useServerStatus(): ServerStatus {
  const status = useSyncExternalStore(subscribeServerStatus, getServerStatus);

  useEffect(() => {
    let active = true;
    const probe = () => {
      if (active) fireAndForget(pingServer(), 'server health probe');
    };

    probe(); // reflect reality as soon as the header mounts
    const timer = setInterval(probe, POLL_MS);
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') probe();
    });

    return () => {
      active = false;
      clearInterval(timer);
      sub.remove();
    };
  }, []);

  return status;
}
