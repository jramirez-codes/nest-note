/**
 * Bridges the editor's `/update-server` command to the paired laptop's self-update
 * endpoint (server/update.go).
 *
 * The laptop pulls the latest code, rebuilds its Go server, and restarts into the
 * new binary. Because the server tears its own connection down to relaunch, this
 * is two phases: `updateServer` triggers the pull/build/restart and returns the
 * build result, then `waitForServerBack` polls the (cheap, authed) liveness probe
 * until the freshly-launched process answers — that's how the card confirms the
 * reconnect.
 *
 * Sibling to ./viewController: it reuses aiController's shared transport and
 * paired-server singletons so "which laptop" stays single-sourced. Never throws —
 * a failure comes back as { error } for the card to show.
 */

import { getTransport, currentServer, NO_MODULE } from './aiController';
import { setServerStatus } from '../transport/status';

export interface UpdateResult {
  /** True once the rebuild succeeded and the restart was kicked off. */
  ok?: boolean;
  /** Which step failed, when ok is false: 'pull' | 'build' | 'swap' | 'locate'. */
  phase?: string;
  /** Tail of the combined git-pull + go-build output, for the card to show. */
  out?: string;
  /** True when the server is going down to relaunch into the new binary. */
  restarting?: boolean;
  /** A human-readable reason the update couldn't be requested at all. */
  error?: string;
}

/**
 * Trigger a self-update on the paired laptop: pull, rebuild, restart. Posts to
 * /update over the pinned tunnel and returns the server's build result. A dropped
 * connection is reported as an error, but note the server may still be mid-restart
 * — the caller should fall back to waitForServerBack to find out.
 */
export async function updateServer(): Promise<UpdateResult> {
  const t = getTransport();
  if (!t) return { error: NO_MODULE };
  const server = await currentServer();
  if (!server) return { error: 'Not connected. Pair first with “/pair <payload>”.' };
  try {
    const res = await t.postPinned(`https://${server.host}:${server.port}/update`, server.pin, {
      headers: { Authorization: `Bearer ${server.token}` },
    });
    if (res.status !== 200) {
      setServerStatus(res.status === 401 ? 'disconnected' : 'connected');
      return { error: `The laptop rejected the update (${res.status}).` };
    }
    setServerStatus('connected');
    return JSON.parse(res.text) as UpdateResult;
  } catch (e) {
    setServerStatus('disconnected');
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Poll the liveness probe until the restarted server answers, or `timeoutMs`
 * elapses. Returns true once it's back. Used after a restarting update to flip the
 * card from "restarting…" to "reconnected".
 */
export async function waitForServerBack(timeoutMs = 45000): Promise<boolean> {
  const t = getTransport();
  if (!t) return false;
  const server = await currentServer();
  if (!server) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await t.postPinned(
        `https://${server.host}:${server.port}/update?probe=1`,
        server.pin,
        { headers: { Authorization: `Bearer ${server.token}` } },
      );
      if (res.status === 200) {
        setServerStatus('connected');
        return true;
      }
    } catch {
      // Still down mid-restart — keep polling.
    }
    await new Promise<void>(resolve => setTimeout(() => resolve(), 1000));
  }
  return false;
}
