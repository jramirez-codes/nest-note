import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet } from 'react-native';
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
  /** False once the page is swiped away from, so we can drop keyboard focus. */
  isActive: boolean;
  onChangeContent: (content: string) => void;
}

/**
 * A full-page markdown text editor for a single note.
 *
 * Holds its own local text state (seeded once from `initialContent`) and
 * reports changes upward for persistence. Because one instance is mounted per
 * note id, local state stays correctly scoped to its page.
 */
function NoteEditor({ initialContent, isActive, onChangeContent }: NoteEditorProps) {
  const colors = useTheme();
  const [text, setText] = useState(initialContent);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const markdownStyle = createMarkdownStyle(colors);
  const inputRef = useRef<React.ComponentRef<typeof MarkdownTextInput>>(null);

  // When this page is no longer the one on top, drop focus so the caret and
  // keyboard don't stay tied to a note the user has swiped past.
  useEffect(() => {
    if (!isActive) {
      inputRef.current?.blur();
    }
  }, [isActive]);

  // Keep the caret bound to the keyboard: it should only blink while the
  // keyboard is up. When the keyboard is dismissed by other means (Android
  // back button, a swipe) the input can stay focused with a lingering caret, so
  // blur it too, leaving the field inert until the user taps back in.
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () =>
      setKeyboardVisible(true),
    );
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false);
      inputRef.current?.blur();
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const handleChangeText = useCallback(
    (value: string) => {
      setText(value);
      onChangeContent(value);
    },
    [onChangeContent],
  );

  return (
    <MarkdownTextInput
      ref={inputRef}
      value={text}
      onChangeText={handleChangeText}
      parser={parseExpensiMark}
      markdownStyle={markdownStyle}
      multiline
      // Only show the caret when this page is on top and the keyboard is up.
      caretHidden={!(isActive && keyboardVisible)}
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
