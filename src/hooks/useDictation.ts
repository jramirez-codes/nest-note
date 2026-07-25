/**
 * Owns the footer mic's speech-to-text session.
 *
 * Tapping the mic starts continuous dictation: the platform recognizer's
 * transcript is streamed straight into whichever note is on screen — partial
 * results update in place, final results commit — via the active editor's
 * window.__dictate (see activeEditor + the editor bundle). Tapping it again
 * stops.
 *
 * Android's SpeechRecognizer ends a session on each natural pause, so to feel
 * continuous we restart it while the user still wants to dictate and only truly
 * stop on their tap (or a hard error). The result lands wherever the caret is at
 * that moment, so swiping to a different note mid-session redirects the text.
 *
 * Callback ordering matters here. Android fires, per utterance:
 *   onPartialResults*  →  onEndOfSpeech (→ onSpeechEnd)  →  onResults (final)
 * so the *end* event arrives BEFORE the final transcript. We therefore must NOT
 * close the in-progress span on end — the final result still needs to replace
 * that span in place (closing it early makes the final re-insert as a fresh span,
 * i.e. a duplicate). Instead we defer the restart briefly: by the time it runs the
 * final has committed (or, on a no-match session where no final ever comes, we
 * freeze whatever partial text landed) and the old recognizer has been destroyed
 * (avoiding ERROR_RECOGNIZER_BUSY on the immediate re-listen).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Keyboard } from 'react-native';
import {
  start,
  stop as stopRecognizer,
  requestPermissions,
  isAvailable,
  addSpeechResultListener,
  addSpeechErrorListener,
  addSpeechEndListener,
  SpeechErrorCode,
  type SpeechResult,
  type SpeechError,
} from '@dbkable/react-native-speech-to-text';
import {
  backspaceActiveEditor,
  injectIntoActiveEditor,
  hasActiveEditor,
  newlineActiveEditor,
  setDictationLive,
} from '../components/notepage/activeEditor';
import { acquireWakeLock, releaseWakeLock, setScreenAwake } from '../native/wakeLock';

/** Locale handed to the recognizer. */
const LANGUAGE = 'en-US';

/** Gap before re-listening after a session ends. Long enough for the final
 *  result to land and the old recognizer to be destroyed, short enough to feel
 *  continuous. */
const RESTART_DELAY_MS = 350;

/** Backstop for a session that goes silent with no callback at all. The restart
 *  loop is driven by the recognizer's end/result/error events; if a session ever
 *  ends without emitting any of them (a swallowed timeout on an old build, or the
 *  platform recognizer simply hanging), nothing re-listens and the mic goes stale.
 *  If this long since the last sign of life while we still want the mic on, force a
 *  re-listen. Comfortably longer than a normal silence-gap-plus-restart so it never
 *  fires mid-session — partial results keep poking it while the user is speaking. */
const WATCHDOG_MS = 8000;

/** Ceiling on the error backoff. After an error we wait before re-listening, and
 *  that wait grows with each consecutive error (RESTART_DELAY_MS × 2ⁿ) so we stop
 *  hammering a recognizer that keeps failing — a burst of ERROR_RECOGNIZER_BUSY /
 *  ERROR_CLIENT (the audio device not yet released after a rapid restart) or a
 *  flaky network recognizer settles instead of tripping an instant give-up. */
const MAX_BACKOFF_MS = 4000;

/** Give up (and tell the user) only if errors keep coming for this long with no
 *  successful result in between — a genuinely broken session, not a transient blip.
 *  Time-based, not a raw count, so backed-off retries get a fair chance to recover. */
const ERROR_GIVEUP_MS = 20000;

/** Errors that mean this device/session can never dictate — stop and tell the
 *  user, rather than restarting into the same failure forever. */
const FATAL_ERRORS = new Set<string>([
  SpeechErrorCode.PERMISSION_DENIED,
  SpeechErrorCode.NOT_AVAILABLE,
]);

export interface Dictation {
  /** True while the mic is live (kept on across the recognizer's own restarts). */
  dictating: boolean;
  /** Toggle the mic on (permissions + start) or off. */
  toggle: () => void;
  /** Force the mic off — used when navigating somewhere it can't dictate. */
  stop: () => void;
  /** Emulate one Backspace press in the note being dictated into (footer Delete). */
  backspace: () => void;
  /** Emulate one Enter press in the note being dictated into (footer New line). */
  newline: () => void;
}

export function useDictation(): Dictation {
  const [dictating, setDictating] = useState(false);
  // The user's latest intent, read by the async end/error handlers (which can
  // fire a tick after a toggle). The recognizer restarts only while this is true.
  const wantOnRef = useRef(false);
  // Pending debounced restart, so an end-then-final pair coalesces into one.
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Watchdog that force-restarts a session which stalled without any callback.
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Consecutive recognizer errors since the last result — drives the restart
  // backoff and (with errorSinceRef) the give-up window.
  const errorCountRef = useRef(0);
  // When the current run of consecutive errors began (ms epoch), or 0 if the last
  // event was a success. Used to give up only after errors persist for a while.
  const errorSinceRef = useRef(0);
  // Whether we currently hold a CPU wake-lock share. One share per dictation
  // session (not per recognizer restart), released once however the session ends —
  // this ref keeps take/drop balanced no matter which stop path fires.
  const holdingWakeLockRef = useRef(false);

  // Keep the device awake for the whole session: the CPU wake lock so the recognizer
  // isn't starved by a screen timeout or Doze, and the display held on so the note
  // the user is dictating into doesn't dim out from under them. Idempotent: only the
  // 0 -> 1 / 1 -> 0 edges hit native.
  const takeWakeLock = useCallback(() => {
    if (holdingWakeLockRef.current) return;
    holdingWakeLockRef.current = true;
    acquireWakeLock();
    setScreenAwake(true);
  }, []);

  const dropWakeLock = useCallback(() => {
    if (!holdingWakeLockRef.current) return;
    holdingWakeLockRef.current = false;
    releaseWakeLock();
    setScreenAwake(false);
  }, []);

  const clearRestart = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  }, []);

  const hardStop = useCallback(
    (reason?: string) => {
      wantOnRef.current = false;
      clearRestart();
      clearWatchdog();
      dropWakeLock();
      setDictating(false);
      stopRecognizer().catch(() => {});
      // End the session on the editor: restore the soft keyboard, drop focus-mode,
      // and abandon any in-progress span (__dictateActive(false) resets it).
      setDictationLive(false);
      if (reason) Alert.alert('Speech to text', reason);
    },
    [clearRestart, clearWatchdog, dropWakeLock],
  );

  // Latest scheduleRestart, so the watchdog can re-listen without a useCallback
  // cycle (scheduleRestart arms the watchdog; the watchdog restarts).
  const scheduleRestartRef = useRef<() => void>(() => {});

  // (Re)start the stall watchdog. Armed on every sign of life from the recognizer
  // (any result/end/error) and whenever a session is (re)started, so it counts down
  // only during dead air. If it ever elapses while we still want the mic on, the
  // session stalled without signalling an end — force a re-listen so the mic can't
  // stay silently stuck. A no-op once the user has toggled off.
  const armWatchdog = useCallback(() => {
    clearWatchdog();
    if (!wantOnRef.current) return;
    watchdogTimerRef.current = setTimeout(() => {
      watchdogTimerRef.current = null;
      if (!wantOnRef.current) return;
      scheduleRestartRef.current();
    }, WATCHDOG_MS);
  }, [clearWatchdog]);

  // Re-listen for the next phrase, debounced. Both the end event (which precedes
  // the final result) and the final result itself schedule this; coalescing means
  // one restart per utterance, run *after* the final has committed. Freezing any
  // still-open span here (not on end) covers the no-match case, where a session
  // leaves partial text with no final to replace it — a no-op once a final reset it.
  const scheduleRestart = useCallback(() => {
    if (!wantOnRef.current) return;
    clearRestart();
    // Back off while errors are piling up so we don't hammer a busy/failing
    // recognizer; snap back to the short gap as soon as a result clears the count.
    const delay =
      errorCountRef.current > 0
        ? Math.min(RESTART_DELAY_MS * 2 ** errorCountRef.current, MAX_BACKOFF_MS)
        : RESTART_DELAY_MS;
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      if (!wantOnRef.current) return;
      injectIntoActiveEditor('window.__dictateEnd();');
      start({ language: LANGUAGE }).catch(() => hardStop('Dictation stopped unexpectedly.'));
      // Guard the freshly-started session too, so a restart that hears only
      // silence (no callback) re-listens rather than going stale.
      armWatchdog();
    }, delay);
  }, [clearRestart, hardStop, armWatchdog]);
  scheduleRestartRef.current = scheduleRestart;

  // Wire the recognizer's streams once. The listeners read wantOnRef so they see
  // the current intent even after re-renders, so this never needs to re-subscribe.
  useEffect(() => {
    const onResult = addSpeechResultListener((r: SpeechResult) => {
      if (!wantOnRef.current) return;
      errorCountRef.current = 0;
      errorSinceRef.current = 0; // a result clears the error run
      armWatchdog(); // a live session — reset the stall timer
      const text = r.transcript ?? '';
      // A blank partial early in a phrase carries no text — skip it so we don't
      // open an empty utterance span.
      if (!text.trim() && !r.isFinal) return;
      injectIntoActiveEditor(
        `window.__dictate(${JSON.stringify(text)}, ${r.isFinal ? 'true' : 'false'});`,
      );
      // The final result closes the utterance (the editor resets its span on
      // isFinal); the recognizer is now idle, so line up the next session.
      if (r.isFinal) scheduleRestart();
    });

    // Fires on onEndOfSpeech — BEFORE the final result. Do NOT touch the span
    // here (the final still needs to replace it); just line up the restart, which
    // the pending final will re-coalesce so it runs after the text commits.
    const onEnd = addSpeechEndListener(() => {
      if (!wantOnRef.current) return;
      armWatchdog();
      scheduleRestart();
    });

    const onError = addSpeechErrorListener((e: SpeechError) => {
      if (!wantOnRef.current) return;
      if (__DEV__) console.warn(`[NestNote] dictation recognizer error: ${e.code}`, e.message);
      if (FATAL_ERRORS.has(String(e.code))) {
        hardStop(
          e.code === SpeechErrorCode.PERMISSION_DENIED
            ? 'Microphone permission is needed to dictate.'
            : 'Speech recognition isn’t available on this device.',
        );
        return;
      }
      // Transient (recognizer busy, a network blip). Native swallows no-match /
      // speech-timeout, so anything here is a real hiccup: restart with backoff so
      // we don't hammer it, and give up only if the failures keep coming for a
      // sustained stretch with no successful result between them.
      armWatchdog();
      const now = Date.now();
      if (errorSinceRef.current === 0) errorSinceRef.current = now;
      errorCountRef.current += 1;
      if (now - errorSinceRef.current > ERROR_GIVEUP_MS) {
        hardStop('Dictation keeps failing — stopped.');
        return;
      }
      scheduleRestart();
    });

    return () => {
      onResult.remove();
      onEnd.remove();
      onError.remove();
      clearRestart();
      clearWatchdog();
      // Don't leave the mic hot — or the wake lock held — if the screen unmounts
      // mid-session (this path bypasses hardStop).
      dropWakeLock();
      if (wantOnRef.current) {
        wantOnRef.current = false;
        stopRecognizer().catch(() => {});
      }
    };
  }, [hardStop, scheduleRestart, armWatchdog, clearRestart, clearWatchdog, dropWakeLock]);

  const startDictation = useCallback(async () => {
    if (!hasActiveEditor()) {
      Alert.alert('Speech to text', 'Open a note to dictate into first.');
      return;
    }
    try {
      if (!(await isAvailable())) {
        Alert.alert('Speech to text', 'Speech recognition isn’t available on this device.');
        return;
      }
      if (!(await requestPermissions())) {
        Alert.alert('Speech to text', 'Microphone permission is needed to dictate.');
        return;
      }
      errorCountRef.current = 0;
      errorSinceRef.current = 0;
      wantOnRef.current = true;
      // Hold the CPU awake before the mic goes live; hardStop drops it on any exit.
      takeWakeLock();
      setDictating(true);
      // Put the editor into dictation mode (visible, steerable caret with the soft
      // keyboard suppressed) and dismiss any keyboard that's already up, so it
      // doesn't sit over the note while the user speaks.
      setDictationLive(true);
      Keyboard.dismiss();
      await start({ language: LANGUAGE });
      // Guard the very first session too: if it produces no callback at all, the
      // watchdog re-listens rather than letting the mic sit dead from the start.
      armWatchdog();
    } catch {
      hardStop('Could not start dictation.');
    }
  }, [hardStop, takeWakeLock, armWatchdog]);

  const toggle = useCallback(() => {
    if (wantOnRef.current) {
      hardStop();
    } else {
      startDictation();
    }
  }, [hardStop, startDictation]);

  // hardStop takes an optional reason; expose a no-arg stop so callers (e.g. the
  // screen's auto-stop) don't accidentally pass an event object in as the alert.
  const stop = useCallback(() => hardStop(), [hardStop]);

  // The footer's recording-only Delete / New line buttons. Wrapped (rather than
  // handed out raw) so callers can pass them straight to an onPress without the
  // press event landing in the injector, and so the whole footer-mic surface stays
  // on this one hook. They edit the note without touching the recognizer, so a tap
  // never interrupts the live session.
  const backspace = useCallback(() => backspaceActiveEditor(), []);
  const newline = useCallback(() => newlineActiveEditor(), []);

  return { dictating, toggle, stop, backspace, newline };
}
