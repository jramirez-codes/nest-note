/**
 * Persistence for the paired companion server. After pairing we hold three
 * long-lived facts — where the server is, the SPKI pin that makes its
 * self-signed cert safe, and the bearer token — so the app reconnects silently
 * on later launches without re-scanning the QR.
 *
 * Stored in the app's key_value table (see storage/kv.ts). The token is a
 * shell-equivalent secret; it never leaves the device except inside the pinned
 * tunnel it authenticates.
 */

import { getValue, setValue, deleteValue } from '../storage/kv';
import type { ServerAddress } from './client';
import { isPairPayload, type PairPayload } from './protocol';

const KEY = 'companion_server';

/** A fully paired server: how to reach it, how to trust it, how to auth. */
export interface PairedServer extends ServerAddress {
  token: string;
}

/** Load the paired server, or null if the user has never paired. */
export async function loadServer(): Promise<PairedServer | null> {
  const raw = await getValue(KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as PairedServer;
    if (s && s.host && s.port && s.pin && s.token) return s;
  } catch {
    // corrupt entry — treat as unpaired
  }
  return null;
}

/** Persist a freshly paired server, replacing any previous pairing. */
export async function saveServer(s: PairedServer): Promise<void> {
  await setValue(KEY, JSON.stringify(s));
}

/** Forget the paired server (e.g. the user unpairs, or the token is revoked). */
export async function clearServer(): Promise<void> {
  await deleteValue(KEY);
}

/**
 * Parse the pairing payload the server prints (as QR, or pasted as JSON) into a
 * validated PairPayload. Returns null if it isn't a recognizable payload, so the
 * pairing screen can show "that isn't a valid pairing code" rather than throwing.
 */
export function parsePairInput(text: string): PairPayload | null {
  try {
    const obj = JSON.parse(text.trim());
    return isPairPayload(obj) ? obj : null;
  } catch {
    return null;
  }
}
