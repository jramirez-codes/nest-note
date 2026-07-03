import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Linking, StyleSheet, View } from 'react-native';
import { fetchLinkPreview } from '../utils/linkPreview';
import {
  WebView as RNWebView,
  type WebViewMessageEvent,
  type WebViewProps,
} from 'react-native-webview';
import { EDITOR_HTML } from '../webview/editorHtml';
import { pairFromPayload, runAsk, type AskHandle } from '../server/aiController';
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
  onChangeContent: (content: string) => void;
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
  onChangeContent,
}: NoteEditorWebViewProps) {
  const ref = useRef<WebViewInstance>(null);
  // Live /ask runs keyed by the editor-side card id, so we can cancel them if
  // the note is swiped away / unmounted mid-stream.
  const askHandles = useRef<Record<string, AskHandle>>({});
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
        context?: { q?: string; a?: string };
        payload?: string;
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
      } else if (msg.type === 'pairScan' && typeof msg.id === 'string') {
        // Bare `/pair`: open the QR scanner; the scan result feeds pairing.
        setPairScan({ id: msg.id });
      }
    },
    [initialContent, onChangeContent],
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
