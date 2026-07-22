/**
 * JS seam for the shared CPU wake lock.
 *
 * Backed by a small native module (Android:
 * android/app/src/main/java/com/NestNote/power) over one reference-counted
 * PARTIAL_WAKE_LOCK: the CPU stays awake while the screen is free to sleep, so a
 * feature that needs to keep working through a screen timeout or Doze — currently
 * speech-to-text dictation — doesn't get starved. The native recorder service
 * shares the same lock for its /record captures.
 *
 * Contract: pair every acquire() with exactly one release(). The manager
 * ref-counts, so overlapping holders (e.g. dictation while a recording runs) all
 * keep the CPU awake and it only sleeps once the last holder releases. Calls are
 * best-effort: they no-op where the module isn't in the build (a JS-only reload,
 * or iOS) and swallow errors, since a wake lock is an optimization that must never
 * take a feature down with it.
 */

import { NativeModules } from 'react-native';

interface WakeLockModule {
  /** Take a share of the shared CPU wake lock. */
  acquire(): Promise<void>;
  /** Give back a share taken by acquire(). */
  release(): Promise<void>;
  /** Hold the display awake (FLAG_KEEP_SCREEN_ON) while true. */
  setKeepScreenOn(enabled: boolean): Promise<void>;
}

const Native = NativeModules.AiNotepadWakeLock as WakeLockModule | undefined;

/** Keep the CPU awake until a matching {@link releaseWakeLock}. Safe to no-op. */
export function acquireWakeLock(): void {
  Native?.acquire().catch(() => {});
}

/** Release a share taken by {@link acquireWakeLock}. Safe to no-op / over-call. */
export function releaseWakeLock(): void {
  Native?.release().catch(() => {});
}

/**
 * Keep the display from timing out (true) or let it sleep again (false). This is
 * separate from the CPU wake lock above: the partial lock keeps the CPU alive but
 * lets the screen sleep, so a feature that wants the screen to stay lit while the
 * user is looking at it — speech-to-text dictation — asks for it here too. Only
 * takes effect while the app is foreground. Safe to no-op.
 */
export function setScreenAwake(enabled: boolean): void {
  Native?.setKeepScreenOn(enabled).catch(() => {});
}
