/**
 * Bridges the editor's inline /record card to a small native recorder module.
 *
 * The heavy lifting is native (Android: MediaRecorder inside a microphone-typed
 * foreground service, so capture survives backgrounding; see
 * android/app/src/main/java/com/ainotepad/recorder). This module is the JS seam:
 * it requests the runtime permissions, starts/stops the one active recording,
 * and exports the finished clip into the device's shared Recordings library
 * (where a Voice Recorder app or file browser can pick it up).
 *
 * IMPORTANT — call audio: Android blocks third-party apps from capturing a phone
 * call's remote party (VOICE_CALL/DOWNLINK need the privileged CAPTURE_AUDIO_OUTPUT
 * permission, granted only to system apps; the accessibility workaround is barred
 * by Play policy). So this records THIS device's microphone only — your own side
 * of a call, plus whatever the mic hears on speakerphone. There is no supported
 * path to both sides from an app like this, regardless of consent.
 */

import {
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
  type EmitterSubscription,
} from 'react-native';

interface RecorderModule {
  /** Begin capturing; resolves with the temp file path and start epoch (ms). */
  start(label: string): Promise<{ file: string; startedAt: number }>;
  /** Stop the active capture; resolves with the file path and its duration (ms). */
  stop(): Promise<{ file: string; ms: number }>;
  /** Stop the active capture and delete its half-written file (× while recording). */
  cancel(): Promise<void>;
  /** Delete these finished cache files (× on a stopped card, or page/notebook
   *  cleanup); never touches an unrelated in-flight recording. */
  deleteFiles(paths: string[]): Promise<void>;
  /** Copy `file` into the shared Recordings/Music library; resolves its name. */
  export(file: string): Promise<{ savedAs: string }>;
  /** Play `file` (or resume it if already paused). */
  play(file: string): Promise<void>;
  /** Pause the current playback in place. */
  pausePlayback(): Promise<void>;
  /** Fully stop and release playback. */
  stopPlayback(): Promise<void>;
}

const Native = NativeModules.AiNotepadRecorder as RecorderModule | undefined;

const NO_MODULE =
  'The audio recorder module isn’t in this build. Rebuild the app (not just a JS ' +
  'reload) to enable recording.';

function requireNative(): RecorderModule {
  if (!Native) throw new Error(NO_MODULE);
  return Native;
}

/**
 * Ask for the permissions a background recording needs: RECORD_AUDIO always, and
 * POST_NOTIFICATIONS (API 33+) so the foreground-service notice can actually show
 * — that persistent notification is both an OS requirement and the visible signal
 * to everyone present that recording is happening. Returns a reason string when
 * denied (surfaced on the card), or null when all clear.
 */
export async function ensureRecordingPermissions(): Promise<string | null> {
  if (Platform.OS !== 'android') {
    // iOS mic consent is handled by the native module's Info.plist prompt.
    return Native ? null : NO_MODULE;
  }
  const mic = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    {
      title: 'Microphone access',
      message:
        'ainotepad needs the microphone to record audio. Everyone being recorded ' +
        'should be aware and consent.',
      buttonPositive: 'Allow',
      buttonNegative: 'Deny',
    },
  );
  if (mic !== PermissionsAndroid.RESULTS.GRANTED) {
    return 'Microphone permission denied.';
  }
  // Best-effort: a denied notification permission doesn't block recording, but
  // the ongoing notice won't be visible, so try for it when the OS gates it.
  if (Number(Platform.Version) >= 33) {
    const notif = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (notif) await PermissionsAndroid.request(notif).catch(() => {});
  }
  return null;
}

/** Start capturing `label`'s audio. Throws if a recording is already running. */
export function startRecording(label: string): Promise<{ file: string; startedAt: number }> {
  return requireNative().start(label);
}

/** Stop the active recording and get its file + duration back. */
export function stopRecording(): Promise<{ file: string; ms: number }> {
  return requireNative().stop();
}

/** Cancel the active recording (× on the card that's currently capturing). */
export function cancelRecording(): Promise<void> {
  return requireNative().cancel();
}

/** Copy a finished recording into the shared Recordings library for export. */
export function exportRecording(file: string): Promise<{ savedAs: string }> {
  return requireNative().export(file);
}

/**
 * Delete a batch of recording cache files — used when the page (or notebook)
 * holding their /record cards is deleted, so the clips don't outlive the note.
 * Best-effort and safe without the native module (a JS-only build has no real
 * recordings to clean up), so it resolves rather than throwing.
 */
export function deleteRecordings(files: string[]): Promise<void> {
  if (!files.length || !Native) return Promise.resolve();
  return Native.deleteFiles(files);
}

/** Play (or resume) a finished recording's file. */
export function playRecording(file: string): Promise<void> {
  return requireNative().play(file);
}

/** Pause the current playback (the same file resumes with playRecording). */
export function pausePlayback(): Promise<void> {
  return requireNative().pausePlayback();
}

/** Stop and release playback entirely (e.g. leaving the editor). */
export function stopPlayback(): Promise<void> {
  if (!Native) return Promise.resolve();
  return Native.stopPlayback();
}

/**
 * Subscribe to "playback finished" (the clip reached its end or errored). The
 * card that was playing flips its button back to Play. Returns an unsubscribe
 * handle; a no-op when the native module is absent.
 */
export function onPlaybackEnded(cb: () => void): { remove: () => void } {
  if (!Native) return { remove: () => {} };
  const emitter = new NativeEventEmitter(NativeModules.AiNotepadRecorder);
  const sub: EmitterSubscription = emitter.addListener(
    'AiNotepadRecorder:playback',
    (e: { type?: string }) => {
      if (e?.type === 'ended') cb();
    },
  );
  return { remove: () => sub.remove() };
}
