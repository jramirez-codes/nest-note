/**
 * Bridges the editor's inline `/view PORT` command to the paired laptop's page-
 * preview proxy (server/view.go).
 *
 * For each previewed port the laptop spins up a dedicated plaintext LAN reverse-
 * proxy that mirrors that localhost dev server 1:1, so the phone's WebView can
 * embed it in an <iframe> and the page's own assets/XHR resolve. This module posts
 * to the (pinned, authenticated) /viewstart to start/reuse that proxy and learn
 * which LAN port it landed on, then builds the plaintext iframe URL. The proxy
 * itself is unauthenticated (a cross-site iframe can't carry a token/cookie), so
 * nothing secret ends up in the URL (see server/view.go).
 *
 * Sibling to ./codeController: it reuses aiController's shared transport and
 * paired-server singletons so "which laptop" stays single-sourced. Never throws —
 * a failure comes back as { error } for the card to show.
 */

import { getTransport, currentServer, NO_MODULE } from './aiController';
import { setServerStatus } from '../transport/status';

export interface ViewResult {
  /** The plaintext iframe URL, present on success. */
  url?: string;
  /** A human-readable reason the preview couldn't be built, present on failure. */
  error?: string;
}

/**
 * Resolve the iframe URL for `port` (a dev server on the paired laptop's
 * localhost). Posts to /viewstart over the pinned tunnel, which starts/reuses a
 * dedicated plaintext proxy for that port and replies with the LAN port it's on;
 * then builds the URL the WebView can load.
 */
export async function fetchViewUrl(port: number): Promise<ViewResult> {
  const t = getTransport();
  if (!t) return { error: NO_MODULE };
  const server = await currentServer();
  if (!server) return { error: 'Not connected. Pair first with “/pair <payload>”.' };
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { error: `“${port}” isn't a valid port.` };
  }
  try {
    const res = await t.postPinned(
      `https://${server.host}:${server.port}/viewstart?port=${port}`,
      server.pin,
      { headers: { Authorization: `Bearer ${server.token}` } },
    );
    if (res.status !== 200) {
      setServerStatus(res.status === 401 ? 'disconnected' : 'connected');
      return { error: `The laptop rejected the request (${res.status}).` };
    }
    setServerStatus('connected');
    const info = JSON.parse(res.text) as { enabled?: boolean; port?: number };
    if (!info.enabled || !info.port) {
      return {
        error: 'Page preview is off on the laptop. Restart its server with -allow-view.',
      };
    }
    // Dedicated per-port proxy, so the iframe origin maps 1:1 to the dev server —
    // no token in the URL, no path prefix. Plaintext HTTP over the LAN.
    return { url: `http://${server.host}:${info.port}/` };
  } catch (e) {
    setServerStatus('disconnected');
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
