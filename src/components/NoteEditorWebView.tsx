import React, { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  WebView as RNWebView,
  type WebViewMessageEvent,
  type WebViewProps,
} from 'react-native-webview';
import { EDITOR_HTML } from '../webview/editorHtml';

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

  const handleMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: { type: string; text?: string };
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        // Seed the document once the CM6 editor has mounted inside the WebView.
        ref.current?.injectJavaScript(
          `window.__setDoc(${JSON.stringify(initialContent)}); true;`,
        );
      } else if (msg.type === 'change' && typeof msg.text === 'string') {
        onChangeContent(msg.text);
      }
    },
    [initialContent, onChangeContent],
  );

  // Drop focus (and dismiss the keyboard) when swiped away from.
  useEffect(() => {
    if (!isActive) {
      ref.current?.injectJavaScript('document.activeElement?.blur(); true;');
    }
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
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#1e1e2e' },
});
