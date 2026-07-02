import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { GestureResponderEvent } from 'react-native';
import { Keyboard, StyleSheet, View } from 'react-native';
import {
  MarkdownTextInput,
  parseExpensiMark,
} from '@expensify/react-native-live-markdown';
import { useTheme } from '../theme/colors';
import { createMarkdownStyle } from '../theme/markdownStyle';

/** How long a finger must rest on the editor before the press "counts" as
 *  intent to edit and brings up the keyboard. Matched to the OS long-press
 *  timeout (~500ms on both iOS and Android) — the same hold that starts a text
 *  selection — so focusing and selecting feel like one continuous gesture. */
const LONG_PRESS_MS = 500;
/** How far the finger may drift before the gesture is read as a scroll/swipe
 *  rather than a press to edit. Past this — but only before the long-press has
 *  landed — the touch is scrolling the note (or turning the page), so we keep
 *  the keyboard down and never take focus. */
const SCROLL_SLOP = 8;

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

  // Tracks the current touch: where it began, whether it drifted into a
  // scroll/swipe, and whether the press has crossed the long-press threshold.
  const touchStart = useRef({ x: 0, y: 0 });
  const isScrollGesture = useRef(false);
  const hasSelection = useRef(false);
  const longPressLanded = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest keyboard visibility, readable synchronously inside touch handlers.
  const keyboardUp = useRef(false);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Drop focus unless the user is mid-selection — selecting text must keep the
  // keyboard up (that's the whole point of selecting).
  const blurUnlessSelecting = useCallback(() => {
    if (!hasSelection.current) inputRef.current?.blur();
  }, []);

  const handleTouchStart = useCallback(
    (e: GestureResponderEvent) => {
      // Once the keyboard is up the user is editing; let the native input handle
      // taps (moving the caret, selecting) untouched — no gating, no blur.
      if (keyboardUp.current) return;
      touchStart.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
      isScrollGesture.current = false;
      longPressLanded.current = false;
      clearLongPressTimer();
      // The keyboard does NOT come up on its own for a press-and-hold, so once
      // the finger has rested long enough to be a long-press (the same instant a
      // text selection begins), actively raise it by focusing the field.
      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = null;
        if (isScrollGesture.current) return;
        longPressLanded.current = true;
        inputRef.current?.focus();
      }, LONG_PRESS_MS);
    },
    [clearLongPressTimer],
  );

  // A drift *before* the long-press lands is a scroll (or page swipe): flag it,
  // cancel the pending long-press, and drop focus so the keyboard never pops up
  // mid-scroll — the note's native scroller keeps the drag and its fling
  // momentum. A drift *after* the long-press lands (or once a selection exists)
  // is the user dragging out a selection, so leave focus alone.
  const handleTouchMove = useCallback(
    (e: GestureResponderEvent) => {
      if (keyboardUp.current) return;
      if (
        isScrollGesture.current ||
        hasSelection.current ||
        longPressLanded.current
      ) {
        return;
      }
      const dx = Math.abs(e.nativeEvent.pageX - touchStart.current.x);
      const dy = Math.abs(e.nativeEvent.pageY - touchStart.current.y);
      if (dx > SCROLL_SLOP || dy > SCROLL_SLOP) {
        isScrollGesture.current = true;
        clearLongPressTimer();
        blurUnlessSelecting();
      }
    },
    [blurUnlessSelecting, clearLongPressTimer],
  );

  const settleTouch = useCallback(() => {
    if (keyboardUp.current) return;
    clearLongPressTimer();
    if (longPressLanded.current || hasSelection.current) {
      // A real long-press or selection: make sure the keyboard is up even if the
      // OS resigned focus when the finger lifted.
      inputRef.current?.focus();
      return;
    }
    // A quick tap or a scroll: reject any focus the native input grabbed so
    // neither pops the keyboard. Re-check next frame in case native commits the
    // focus a frame late.
    blurUnlessSelecting();
    requestAnimationFrame(blurUnlessSelecting);
  }, [blurUnlessSelecting, clearLongPressTimer]);

  // Selecting text (long-press, double-tap, drag over a range) is a deliberate
  // edit action, so surface the keyboard for it even if the raw press timing
  // would otherwise have been rejected.
  const handleSelectionChange = useCallback(
    (e: { nativeEvent: { selection: { start: number; end: number } } }) => {
      const { start, end } = e.nativeEvent.selection;
      hasSelection.current = start !== end;
      if (hasSelection.current) {
        inputRef.current?.focus();
      }
    },
    [],
  );

  // When this page is no longer the one on top, drop focus so the caret and
  // keyboard don't stay tied to a note the user has swiped past.
  useEffect(() => {
    if (!isActive) {
      clearLongPressTimer();
      inputRef.current?.blur();
    }
  }, [isActive, clearLongPressTimer]);

  // Never leave a pending long-press timer dangling if the editor unmounts.
  useEffect(() => clearLongPressTimer, [clearLongPressTimer]);

  // Keep the caret bound to the keyboard: it should only blink while the
  // keyboard is up. When the keyboard is dismissed by other means (Android
  // back button, a swipe) the input can stay focused with a lingering caret, so
  // blur it too, leaving the field inert until the user taps back in.
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => {
      keyboardUp.current = true;
      setKeyboardVisible(true);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      keyboardUp.current = false;
      setKeyboardVisible(false);
      // Don't blur while a selection is live: some platforms briefly hide the
      // keyboard to show the selection toolbar, and blurring here would drop the
      // selection and stop the keyboard from coming back.
      blurUnlessSelecting();
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [blurUnlessSelecting]);

  const handleChangeText = useCallback(
    (value: string) => {
      setText(value);
      onChangeContent(value);
    },
    [onChangeContent],
  );

  return (
    <View
      style={styles.fill}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={settleTouch}
      onTouchCancel={settleTouch}>
      <MarkdownTextInput
        ref={inputRef}
        value={text}
        onChangeText={handleChangeText}
        onSelectionChange={handleSelectionChange}
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
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  input: {
    flex: 1,
    fontSize: 17,
    lineHeight: 26,
    paddingHorizontal: 24,
    paddingTop: 8,
  },
});

export default React.memo(NoteEditor);
