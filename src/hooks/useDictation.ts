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
import { Alert } from 'react-native';
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
import { injectIntoActiveEditor, hasActiveEditor } from '../components/notepage/activeEditor';

/** Locale handed to the recognizer. */
const LANGUAGE = 'en-US';

/** Gap before re-listening after a session ends. Long enough for the final
 *  result to land and the old recognizer to be destroyed, short enough to feel
 *  continuous. */
const RESTART_DELAY_MS = 350;

/** After this many recognizer errors with no result in between, give up instead
 *  of restarting into the same failure forever (e.g. a persistent busy/server). */
const MAX_CONSECUTIVE_ERRORS = 4;

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
}

export function useDictation(): Dictation {
  const [dictating, setDictating] = useState(false);
  // The user's latest intent, read by the async end/error handlers (which can
  // fire a tick after a toggle). The recognizer restarts only while this is true.
  const wantOnRef = useRef(false);
  // Pending debounced restart, so an end-then-final pair coalesces into one.
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Consecutive recognizer errors since the last result — a runaway-loop backstop.
  const errorCountRef = useRef(0);

  const clearRestart = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const hardStop = useCallback(
    (reason?: string) => {
      wantOnRef.current = false;
      clearRestart();
      setDictating(false);
      stopRecognizer().catch(() => {});
      injectIntoActiveEditor('window.__dictateEnd();');
      if (reason) Alert.alert('Speech to text', reason);
    },
    [clearRestart],
  );

  // Re-listen for the next phrase, debounced. Both the end event (which precedes
  // the final result) and the final result itself schedule this; coalescing means
  // one restart per utterance, run *after* the final has committed. Freezing any
  // still-open span here (not on end) covers the no-match case, where a session
  // leaves partial text with no final to replace it — a no-op once a final reset it.
  const scheduleRestart = useCallback(() => {
    if (!wantOnRef.current) return;
    clearRestart();
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      if (!wantOnRef.current) return;
      injectIntoActiveEditor('window.__dictateEnd();');
      start({ language: LANGUAGE }).catch(() => hardStop('Dictation stopped unexpectedly.'));
    }, RESTART_DELAY_MS);
  }, [clearRestart, hardStop]);

  // Wire the recognizer's streams once. The listeners read wantOnRef so they see
  // the current intent even after re-renders, so this never needs to re-subscribe.
  useEffect(() => {
    const onResult = addSpeechResultListener((r: SpeechResult) => {
      if (!wantOnRef.current) return;
      errorCountRef.current = 0;
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
      if (wantOnRef.current) scheduleRestart();
    });

    const onError = addSpeechErrorListener((e: SpeechError) => {
      if (!wantOnRef.current) return;
      if (FATAL_ERRORS.has(String(e.code))) {
        hardStop(
          e.code === SpeechErrorCode.PERMISSION_DENIED
            ? 'Microphone permission is needed to dictate.'
            : 'Speech recognition isn’t available on this device.',
        );
        return;
      }
      // Transient (recognizer busy, a network blip). Native swallows no-match /
      // speech-timeout, so anything here is a real hiccup: restart, but bail if
      // they pile up with no successful result between them.
      errorCountRef.current += 1;
      if (errorCountRef.current > MAX_CONSECUTIVE_ERRORS) {
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
      // Don't leave the mic hot if the screen unmounts mid-session.
      if (wantOnRef.current) {
        wantOnRef.current = false;
        stopRecognizer().catch(() => {});
      }
    };
  }, [hardStop, scheduleRestart, clearRestart]);

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
      wantOnRef.current = true;
      setDictating(true);
      await start({ language: LANGUAGE });
    } catch {
      hardStop('Could not start dictation.');
    }
  }, [hardStop]);

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

  return { dictating, toggle, stop };
}
