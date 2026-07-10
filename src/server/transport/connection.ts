/**
 * The companion server's connection core: the shared pinned transport, the paired-
 * server singleton, pairing, and the reachability probe.
 *
 * These are module-level singletons (not a hook) because "which laptop are we
 * talking to" is a global fact — one phone, one paired laptop. Every sibling
 * controller (assistantRuns, dashboardApi, code/agent/view controllers) imports
 * `getTransport` / `currentServer` from here so they all share one transport
 * instance and one cached server, keeping that fact single-sourced across the app.
 * The heavy lifting (pinned pair exchange, health probe) lives in ./client.
 */

import { pair as pairServer, checkHealth } from './client';
import { createNativeTransport, isNativeTransportAvailable } from './nativeTransport';
import { loadServer, saveServer, parsePairInput, type PairedServer } from './store';
import { setServerStatus } from './status';
import type { Transport } from './transport';

let transport: Transport | null = null;
/** The one native transport instance, shared by every controller. */
export function getTransport(): Transport | null {
  if (!isNativeTransportAvailable()) return null;
  if (!transport) transport = createNativeTransport();
  return transport;
}

// The paired server, cached after the first load so callers needn't hit SQLite
// each time. `loaded` distinguishes "not yet read" from "read, and there is none".
let cachedServer: PairedServer | null = null;
let loaded = false;
/**
 * The paired server (or null if none), cached across the app so every controller
 * agrees on which laptop we're talking to, and a re-pair updates them all.
 */
export async function currentServer(): Promise<PairedServer | null> {
  if (!loaded) {
    cachedServer = await loadServer();
    loaded = true;
  }
  return cachedServer;
}

/** The `https://host:port` origin for a paired server's pinned HTTP endpoints. */
export function serverOrigin(s: PairedServer): string {
  return `https://${s.host}:${s.port}`;
}

/**
 * Probe whether the paired server is reachable right now and publish the result
 * to the shared status store (which the header bubble subscribes to). Returns
 * false — and marks 'disconnected' — when the secure module is missing or no
 * server is paired, so "can't reach it" and "nothing to reach" read the same to
 * the user. Safe to call on a timer.
 */
export async function pingServer(): Promise<boolean> {
  const t = getTransport();
  const server = t ? await currentServer() : null;
  if (!t || !server) {
    setServerStatus('disconnected');
    return false;
  }
  setServerStatus('checking');
  const ok = await checkHealth(t, server);
  setServerStatus(ok ? 'connected' : 'disconnected');
  return ok;
}

export const NO_MODULE =
  'The secure connection module isn’t in this build. Rebuild the app (not just a ' +
  'JS reload) to enable the assistant.';

/** Redeem a pasted pairing payload for a token and remember the server. */
export async function pairFromPayload(text: string): Promise<{ ok: boolean; msg: string }> {
  const t = getTransport();
  if (!t) return { ok: false, msg: NO_MODULE };

  const payload = parsePairInput(text);
  if (!payload) {
    return { ok: false, msg: 'That isn’t a valid pairing payload.' };
  }
  try {
    const address = { host: payload.host, port: payload.port, pin: payload.pin };
    const token = await pairServer(t, address, payload.code);
    cachedServer = { ...address, token };
    loaded = true;
    await saveServer(cachedServer);
    // A successful pair exchange means we just reached the server over the pin.
    setServerStatus('connected');
    return { ok: true, msg: `Connected to ${payload.host}:${payload.port}` };
  } catch (e) {
    return { ok: false, msg: e instanceof Error ? e.message : String(e) };
  }
}
