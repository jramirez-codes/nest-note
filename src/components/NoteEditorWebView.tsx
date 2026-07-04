import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Linking, StyleSheet, View } from 'react-native';
import { fetchLinkPreview } from '../utils/linkPreview';
import {
  WebView as RNWebView,
  type WebViewMessageEvent,
  type WebViewProps,
} from 'react-native-webview';
import { EDITOR_HTML } from '../webview/editorHtml';
import { pairFromPayload, runAsk, runClean, type AskHandle } from '../server/aiController';
import {
  ensureRecordingPermissions,
  startRecording,
  stopRecording,
  cancelRecording,
  deleteRecordings,
  exportRecording,
  playRecording,
  pausePlayback,
  stopPlayback,
  onPlaybackEnded,
} from '../server/audioController';
import QrPairModal from './QrPairModal';

// react-native-webview@14's class-component typings resolve to `never` under
// React 19's JSX types (RN 0.86), so re-type it as a normal component. Runtime
// is unaffected — this is purely to restore prop/ref type-checking.
type WebViewInstance = InstanceType<typeof RNWebView>;
const WebView = RNWebView as unknown as React.ForwardRefExoticComponent<
  WebViewProps & React.RefAttributes<WebViewInstance>
>;

interface NoteEditorWebViewProps {
  /** Initial editor content — markdown, same as the rest of the app. */
  initialContent: string;
  /** False once the page is swiped away from, so we drop keyboard focus. */
  isActive: boolean;
  /** Whether the page already has a title; when false, `/clean` generates one. */
  hasTitle: boolean;
  onChangeContent: (content: string) => void;
  /** Store an AI-generated title produced by `/clean` (called at most once). */
  onSetTitle: (title: string) => void;
}

/**
 * Markdown editor backed by CodeMirror 6 running inside a WebView — the path
 * toward Obsidian-style live preview, custom widgets, and toggleable section
 * decorations, all of which are CM6 features with no native-RN equivalent.
 *
 * Content is markdown in and markdown out (CM6 edits the source text), so notes
 * stay in the app's markdown storage format with no data migration.
 */
export default function NoteEditorWebView({
  initialContent,
  isActive,
  hasTitle,
  onChangeContent,
  onSetTitle,
}: NoteEditorWebViewProps) {
  const ref = useRef<WebViewInstance>(null);
  // Live /ask runs keyed by the editor-side card id, so we can cancel them if
  // the note is swiped away / unmounted mid-stream.
  const askHandles = useRef<Record<string, AskHandle>>({});
  // The /record card id whose clip is currently playing (only one at a time), so
  // starting another or a natural end can flip the right card's button back.
  const playingId = useRef<string | null>(null);
  // Set when a bare `/pair` asks to scan a QR; carries the card id to update.
  const [pairScan, setPairScan] = useState<{ id: string } | null>(null);

  const handleMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: {
        type: string;
        text?: string;
        url?: string;
        id?: string;
        question?: string;
        context?: { q?: string; a?: string; turns?: { q?: string; a?: string }[] };
        payload?: string;
        pageText?: string;
        guidance?: string;
        label?: string;
        file?: string;
      };
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      // RN → web bridge helper (the editor exposes window.__ai* globals).
      const inject = (js: string) => ref.current?.injectJavaScript(js + ' true;');
      if (msg.type === 'ready') {
        // Seed the document once the CM6 editor has mounted inside the WebView.
        ref.current?.injectJavaScript(
          `window.__setDoc(${JSON.stringify(initialContent)}); true;`,
        );
      } else if (msg.type === 'change' && typeof msg.text === 'string') {
        onChangeContent(msg.text);
      } else if (msg.type === 'openUrl' && typeof msg.url === 'string') {
        // Open tapped markdown links in the system browser. Restrict schemes so
        // a note can't smuggle in javascript:/file: URLs.
        if (/^(https?|mailto):/i.test(msg.url)) {
          Linking.openURL(msg.url).catch(() => {});
        }
      } else if (msg.type === 'fetchPreview' && typeof msg.url === 'string') {
        // Unfurl a pasted link: fetch its metadata natively (no CORS) and hand
        // the card data back to the WebView to render.
        const url = msg.url;
        if (/^https?:\/\//i.test(url)) {
          fetchLinkPreview(url).then(data => {
            ref.current?.injectJavaScript(
              `window.__setPreview(${JSON.stringify(url)}, ${JSON.stringify(
                data,
              )}); true;`,
            );
          });
        }
      } else if (
        msg.type === 'ask' &&
        typeof msg.id === 'string' &&
        typeof msg.question === 'string'
      ) {
        // Stream the assistant's answer back into the card's live field, then
        // commit the final text (or error) to the document so it persists.
        const id = msg.id;
        askHandles.current[id] = runAsk(msg.question, {
          onDelta: answer =>
            inject(`window.__aiStream(${JSON.stringify(id)}, ${JSON.stringify(answer)});`),
          onDone: answer => {
            delete askHandles.current[id];
            inject(
              `window.__aiDone(${JSON.stringify(id)}, ${JSON.stringify({
                a: answer,
                status: 'done',
              })});`,
            );
          },
          onError: (errMsg, partial) => {
            delete askHandles.current[id];
            inject(
              `window.__aiDone(${JSON.stringify(id)}, ${JSON.stringify({
                a: partial,
                status: 'error',
                msg: errMsg,
              })});`,
            );
          },
        }, msg.context);
      } else if (
        msg.type === 'pair' &&
        typeof msg.id === 'string' &&
        typeof msg.payload === 'string'
      ) {
        const id = msg.id;
        pairFromPayload(msg.payload).then(res => {
          inject(
            `window.__aiDone(${JSON.stringify(id)}, ${JSON.stringify({
              status: res.ok ? 'ok' : 'error',
              msg: res.msg,
            })});`,
          );
        });
      } else if (
        msg.type === 'clean' &&
        typeof msg.id === 'string' &&
        typeof msg.pageText === 'string'
      ) {
        // Rewrite the whole page. On success the editor swaps in the cleaned
        // text behind an Accept/Reject bar; on error the notes are left as-is.
        const id = msg.id;
        askHandles.current[id] = runClean(msg.pageText, msg.guidance ?? '', !hasTitle, {
          onDone: (cleaned, title) => {
            delete askHandles.current[id];
            inject(`window.__cleanApply(${JSON.stringify(id)}, ${JSON.stringify(cleaned)});`);
            // Give the page a name if it had none (independent of Accept/Reject —
            // the title describes the note's topic, which the rewrite preserves).
            if (title) onSetTitle(title);
          },
          onError: errMsg => {
            delete askHandles.current[id];
            inject(
              `window.__aiDone(${JSON.stringify(id)}, ${JSON.stringify({
                status: 'error',
                msg: errMsg,
              })});`,
            );
          },
        });
      } else if (msg.type === 'pairScan' && typeof msg.id === 'string') {
        // Bare `/pair`: open the QR scanner; the scan result feeds pairing.
        setPairScan({ id: msg.id });
      } else if (msg.type === 'recordStart' && typeof msg.id === 'string') {
        // Tap Record: get consent/permissions, then start the background mic
        // capture. On success the card flips to its Stop state with a live timer.
        const id = msg.id;
        const doneRec = (patch: Record<string, unknown>) =>
          inject(`window.__aiDone(${JSON.stringify(id)}, ${JSON.stringify(patch)});`);
        (async () => {
          const denied = await ensureRecordingPermissions();
          if (denied) {
            doneRec({ status: 'error', msg: denied });
            return;
          }
          try {
            const { file, startedAt } = await startRecording(msg.label ?? '');
            doneRec({ status: 'recording', file, startedAt });
          } catch (e) {
            doneRec({ status: 'error', msg: e instanceof Error ? e.message : String(e) });
          }
        })();
      } else if (msg.type === 'recordStop' && typeof msg.id === 'string') {
        // Tap Stop: end capture and commit the clip's duration onto the card.
        const id = msg.id;
        const doneRec = (patch: Record<string, unknown>) =>
          inject(`window.__aiDone(${JSON.stringify(id)}, ${JSON.stringify(patch)});`);
        (async () => {
          try {
            const { file, ms } = await stopRecording();
            doneRec({ status: 'stopped', file, ms });
          } catch (e) {
            doneRec({ status: 'error', msg: e instanceof Error ? e.message : String(e) });
          }
        })();
      } else if (msg.type === 'recordExport' && typeof msg.file === 'string') {
        // Copy the finished clip into the shared Recordings library.
        exportRecording(msg.file).catch(() => {});
      } else if (
        msg.type === 'recordPlay' &&
        typeof msg.id === 'string' &&
        typeof msg.file === 'string'
      ) {
        // Play a finished clip. Only one plays at a time: flip the previously
        // playing card back to Play, then mark this one playing.
        const id = msg.id;
        const setPlay = (cardId: string, playing: boolean) =>
          inject(`window.__recPlay(${JSON.stringify(cardId)}, ${playing});`);
        if (playingId.current && playingId.current !== id) setPlay(playingId.current, false);
        playingId.current = id;
        setPlay(id, true);
        playRecording(msg.file).catch(() => {
          if (playingId.current === id) playingId.current = null;
          setPlay(id, false);
        });
      } else if (msg.type === 'recordPause' && typeof msg.id === 'string') {
        const id = msg.id;
        if (playingId.current === id) playingId.current = null;
        pausePlayback().catch(() => {});
        inject(`window.__recPlay(${JSON.stringify(id)}, false);`);
      } else if (msg.type === 'recordCancel') {
        // × on a card that's actively capturing: stop it and drop its partial file.
        cancelRecording().catch(() => {});
      } else if (msg.type === 'recordDiscard' && typeof msg.file === 'string') {
        // × on a finished card: delete just that clip; never disturbs a recording
        // that may be running on another card.
        deleteRecordings([msg.file]).catch(() => {});
      }
    },
    [initialContent, hasTitle, onChangeContent, onSetTitle],
  );

  // Feed a resolved pairing outcome back into the /pair card, then close scanner.
  const finishPairScan = useCallback(
    (id: string, status: 'ok' | 'error', message: string) => {
      setPairScan(null);
      ref.current?.injectJavaScript(
        `window.__aiDone(${JSON.stringify(id)}, ${JSON.stringify({
          status,
          msg: message,
        })}); true;`,
      );
    },
    [],
  );

  // Cancel any in-flight /ask streams when this editor unmounts.
  useEffect(() => {
    const handles = askHandles.current;
    return () => {
      Object.values(handles).forEach(h => h.cancel());
    };
  }, []);

  // When a clip finishes on its own, flip its card's button back to Play. Also
  // stop playback when the editor goes away, so audio doesn't outlive the view.
  useEffect(() => {
    const sub = onPlaybackEnded(() => {
      const id = playingId.current;
      if (!id) return;
      playingId.current = null;
      ref.current?.injectJavaScript(`window.__recPlay(${JSON.stringify(id)}, false); true;`);
    });
    return () => {
      sub.remove();
      if (playingId.current) playingId.current = null;
      stopPlayback().catch(() => {});
    };
  }, []);

  // Drop focus (and dismiss the keyboard) when swiped away from.
  useEffect(() => {
    if (!isActive) {
      ref.current?.injectJavaScript('document.activeElement?.blur(); true;');
    }
  }, [isActive]);

  // Keep the editor's DOM focus in sync with the keyboard. When the user hides
  // the keyboard (system Back button, swipe-down) without leaving the note, the
  // WebView's contenteditable keeps focus — so on Android a later tap won't
  // re-raise the keyboard (no focus change fires) and typing feels dead. Blur
  // the editor whenever the keyboard hides so the next tap reliably re-focuses
  // the note and brings the keyboard back. CM6 keeps the caret in editor state
  // across blur, so the cursor position is preserved on re-focus.
  useEffect(() => {
    if (!isActive) return;
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      ref.current?.injectJavaScript('document.activeElement?.blur(); true;');
    });
    return () => sub.remove();
  }, [isActive]);

  return (
    <View style={styles.fill}>
      <WebView
        ref={ref}
        source={{ html: EDITOR_HTML }}
        originWhitelist={['*']}
        onMessage={handleMessage}
        // Let a tap raise the keyboard directly, and drop the iOS input bar.
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        // CM6 owns scrolling; the WebView itself shouldn't bounce/scroll.
        scrollEnabled={false}
        automaticallyAdjustContentInsets={false}
        style={styles.fill}
      />
      {pairScan && (
        <QrPairModal
          visible
          onScanned={payload => {
            const id = pairScan.id;
            setPairScan(null);
            pairFromPayload(payload).then(res =>
              finishPairScan(id, res.ok ? 'ok' : 'error', res.msg),
            );
          }}
          onClose={() => finishPairScan(pairScan.id, 'error', 'Pairing cancelled')}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#1e1e2e' },
});
