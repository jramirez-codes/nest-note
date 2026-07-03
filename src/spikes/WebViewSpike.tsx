import React, { useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import NoteEditorWebView from '../components/NoteEditorWebView';
import { useTheme } from '../theme/colors';

/**
 * Throwaway harness for the CodeMirror-in-WebView editor. Mounted behind the
 * `SHOW_WEBVIEW_SPIKE` flag in `App.tsx`; not part of the real app.
 *
 * Proves the two things a build can't: the on-device *feel* (typing latency,
 * keyboard, selection, scroll) and the markdown round-trip (edits come back out
 * as markdown, shown live in the footer).
 */
const SAMPLE = [
  '# CodeMirror spike',
  '',
  'Editing **markdown** in a WebView. Syntax marks dim like Obsidian.',
  '',
  '- a bullet',
  '- another',
  '* [ ] a task',
  '* [x] done',
  '',
  '> a blockquote',
  '',
  '`inline code` and a [link](https://example.com)',
].join('\n');

export default function WebViewSpike() {
  const colors = useTheme();
  const [out, setOut] = useState(SAMPLE);

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]}>
      <View style={styles.editor}>
        <NoteEditorWebView
          initialContent={SAMPLE}
          isActive
          onChangeContent={setOut}
        />
      </View>
      <View style={[styles.footer, { borderTopColor: colors.border }]}>
        <Text style={[styles.label, { color: colors.muted }]}>
          MARKDOWN OUT ({out.length} chars)
        </Text>
        <Text style={[styles.raw, { color: colors.text }]} numberOfLines={4}>
          {out}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  editor: { flex: 1 },
  footer: { borderTopWidth: 1, padding: 12, gap: 4 },
  label: { fontSize: 11, fontWeight: '600', letterSpacing: 1 },
  raw: { fontFamily: 'monospace', fontSize: 12 },
});
