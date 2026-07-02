import React, { useCallback, useState } from 'react';
import { StyleSheet } from 'react-native';
import {
  MarkdownTextInput,
  parseExpensiMark,
} from '@expensify/react-native-live-markdown';
import { useTheme } from '../theme/colors';
import { createMarkdownStyle } from '../theme/markdownStyle';

interface NoteEditorProps {
  /** Content used to seed the editor. Not fed back on every keystroke, so the
   *  caret never jumps while typing. */
  initialContent: string;
  onChangeContent: (content: string) => void;
}

/**
 * A full-page markdown text editor for a single note.
 *
 * Holds its own local text state (seeded once from `initialContent`) and
 * reports changes upward for persistence. Because one instance is mounted per
 * note id, local state stays correctly scoped to its page.
 */
function NoteEditor({ initialContent, onChangeContent }: NoteEditorProps) {
  const colors = useTheme();
  const [text, setText] = useState(initialContent);
  const markdownStyle = createMarkdownStyle(colors);

  const handleChangeText = useCallback(
    (value: string) => {
      setText(value);
      onChangeContent(value);
    },
    [onChangeContent],
  );

  return (
    <MarkdownTextInput
      value={text}
      onChangeText={handleChangeText}
      parser={parseExpensiMark}
      markdownStyle={markdownStyle}
      multiline
      autoCapitalize="sentences"
      placeholder="Start writing…"
      placeholderTextColor={colors.muted}
      textAlignVertical="top"
      style={[styles.input, { color: colors.text }]}
    />
  );
}

const styles = StyleSheet.create({
  input: {
    flex: 1,
    fontSize: 17,
    lineHeight: 26,
    paddingHorizontal: 24,
    paddingTop: 8,
  },
});

export default React.memo(NoteEditor);
