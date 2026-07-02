import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { GestureResponderEvent } from 'react-native';
import { Keyboard, ScrollView, StyleSheet, View } from 'react-native';
import { MarkdownTextInput } from '@expensify/react-native-live-markdown';
import { useTheme } from '../theme/colors';
import { createMarkdownStyle } from '../theme/markdownStyle';
import { parseMarkdown } from '../theme/markdownParser';

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
 *
 * Editing is gated behind an explicit `editing` mode rather than the native
 * focus-on-touch. While browsing, the input is wrapped in a `pointerEvents:
 * "none"` view: a multiline TextInput's native scroller otherwise swallows the
 * vertical drag before the surrounding ScrollView can (the well-known Android
 * nested-scroll bug — and `editable={false}` doesn't stop it), so making the
 * whole input subtree untouchable lets the drag fall straight through to the
 * ScrollView. It also means the OS can't focus the field on a tap, so the
 * keyboard never flickers up-then-down. A deliberate long-press — detected on
 * the ScrollView, which now receives every touch — flips the wrapper back to
 * `pointerEvents: "auto"`, makes the field editable, and focuses it.
 */
function NoteEditor({ initialContent, isActive, onChangeContent }: NoteEditorProps) {
  const colors = useTheme();
  const [text, setText] = useState(initialContent);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  // Edit mode: the input is only `editable` (and thus focusable/scroll-eating)
  // while this is true. Entered by a long-press, left when the keyboard goes.
  const [editing, setEditing] = useState(false);
  const markdownStyle = createMarkdownStyle(colors);
  const inputRef = useRef<React.ComponentRef<typeof MarkdownTextInput>>(null);

  // Tracks the current touch: where it began, whether it drifted into a
  // scroll/swipe, and whether the press has crossed the long-press threshold.
  const touchStart = useRef({ x: 0, y: 0 });
  const isScrollGesture = useRef(false);
  const hasSelection = useRef(false);
  const longPressLanded = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest edit-mode flag, readable synchronously inside touch handlers (which
  // fire between renders, before the `editing` state has propagated).
  const editingRef = useRef(false);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Enter edit mode: make the field editable. Actually focusing it (and so
  // raising the keyboard) is deferred to the effect below, because the input
  // has to render as `editable` before a `focus()` will take.
  const beginEditing = useCallback(() => {
    editingRef.current = true;
    setEditing(true);
  }, []);

  // Leave edit mode: drop focus and make the field inert again so the note
  // scrolls freely. Kept as a no-op if a selection is live (see the keyboard
  // listener) so the selection toolbar's brief keyboard hide can't end editing.
  const endEditing = useCallback(() => {
    editingRef.current = false;
    setEditing(false);
    inputRef.current?.blur();
  }, []);

  const handleTouchStart = useCallback(
    (e: GestureResponderEvent) => {
      // Already editing: let the native input own taps (caret, selection) — no
      // gating, no re-focus.
      if (editingRef.current) return;
      touchStart.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
      isScrollGesture.current = false;
      longPressLanded.current = false;
      clearLongPressTimer();
      // A press-and-hold doesn't raise the keyboard on its own (the field is
      // inert until we say so), so once the finger has rested long enough to be
      // a long-press, flip into edit mode and focus.
      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = null;
        if (isScrollGesture.current) return;
        longPressLanded.current = true;
        beginEditing();
      }, LONG_PRESS_MS);
    },
    [beginEditing, clearLongPressTimer],
  );

  // A drift before the long-press lands means the touch is a scroll (or page
  // swipe), not a press to edit: flag it and cancel the pending long-press so
  // edit mode is never entered mid-scroll. There's no focus to drop — the field
  // is still inert — so the ScrollView just keeps the drag and its fling.
  const handleTouchMove = useCallback((e: GestureResponderEvent) => {
    if (editingRef.current) return;
    if (isScrollGesture.current || longPressLanded.current) return;
    const dx = Math.abs(e.nativeEvent.pageX - touchStart.current.x);
    const dy = Math.abs(e.nativeEvent.pageY - touchStart.current.y);
    if (dx > SCROLL_SLOP || dy > SCROLL_SLOP) {
      isScrollGesture.current = true;
      clearLongPressTimer();
    }
  }, [clearLongPressTimer]);

  // On lift/cancel just retire the pending long-press. A quick tap or a scroll
  // never made the field editable, so there's no stray focus (or keyboard) to
  // undo — the flicker the old code fought is gone by construction.
  const settleTouch = useCallback(() => {
    if (editingRef.current) return;
    clearLongPressTimer();
  }, [clearLongPressTimer]);

  // The ScrollView taking over the gesture is the authoritative "this is a
  // scroll" signal: cancel any pending long-press so a flick just glides the
  // page (webpage-style) without ever entering edit mode.
  const handleScrollBeginDrag = useCallback(() => {
    if (editingRef.current) return;
    isScrollGesture.current = true;
    clearLongPressTimer();
  }, [clearLongPressTimer]);

  // Track whether a range is selected so the keyboard listener below doesn't
  // tear down edit mode while the selection toolbar has momentarily hidden the
  // keyboard.
  const handleSelectionChange = useCallback(
    (e: { nativeEvent: { selection: { start: number; end: number } } }) => {
      const { start, end } = e.nativeEvent.selection;
      hasSelection.current = start !== end;
    },
    [],
  );

  // Once the field is editable, focus it to raise the keyboard. Running this in
  // an effect (rather than inline in beginEditing) guarantees the input has
  // already re-rendered as `editable`, so the focus actually takes.
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // When this page is no longer the one on top, leave edit mode so the caret and
  // keyboard don't stay tied to a note the user has swiped past.
  useEffect(() => {
    if (!isActive) {
      clearLongPressTimer();
      endEditing();
    }
  }, [isActive, clearLongPressTimer, endEditing]);

  // Never leave a pending long-press timer dangling if the editor unmounts.
  useEffect(() => clearLongPressTimer, [clearLongPressTimer]);

  // Keep edit mode tied to the keyboard. When the keyboard is dismissed by any
  // means (Android back button, a page swipe, the "done" key) leave edit mode so
  // the field goes inert and the note is scrollable again — but not while a
  // selection is live, since some platforms briefly hide the keyboard to show
  // the selection toolbar and tearing down here would drop the selection.
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => {
      setKeyboardVisible(true);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false);
      if (!hasSelection.current) endEditing();
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [endEditing]);

  const handleChangeText = useCallback(
    (value: string) => {
      setText(value);
      onChangeContent(value);
    },
    [onChangeContent],
  );

  return (
    // The note scrolls inside a ScrollView (not the TextInput's own scroller) so
    // a flick glides with native, webpage-style momentum. The input is inert
    // until a long-press (see above), so it never steals this scroll gesture.
    // keyboardShouldPersistTaps keeps a tap from being eaten just to dismiss the
    // keyboard while editing.
    <ScrollView
      style={styles.fill}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="always"
      keyboardDismissMode="none"
      showsVerticalScrollIndicator={false}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={settleTouch}
      onTouchCancel={settleTouch}
      onScrollBeginDrag={handleScrollBeginDrag}>
      {/* While browsing, this wrapper is untouchable so the drag passes through
          to the ScrollView instead of being eaten by the TextInput's native
          scroller. It flips interactive only once we're editing. */}
      <View
        pointerEvents={editing ? 'auto' : 'none'}
        style={styles.inputWrap}>
        <MarkdownTextInput
          ref={inputRef}
          value={text}
          onChangeText={handleChangeText}
          onSelectionChange={handleSelectionChange}
          parser={parseMarkdown}
          markdownStyle={markdownStyle}
          multiline
          // Only editable in edit mode: keeps the OS from focusing on a plain
          // tap (which would flash the keyboard) and from accepting stray input.
          editable={editing}
          // The ScrollView owns scrolling; the input just grows to fit its text.
          scrollEnabled={false}
          // Only show the caret when this page is on top and the keyboard is up.
          caretHidden={!(isActive && keyboardVisible)}
          autoCapitalize="sentences"
          placeholder="Start writing…"
          placeholderTextColor={colors.muted}
          textAlignVertical="top"
          style={[styles.input, { color: colors.text }]}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  // flexGrow so a short note still fills the page (the whole sheet stays
  // scrollable/holdable), while a long note grows past it and scrolls.
  content: {
    flexGrow: 1,
  },
  // Grows with the input so its content height (not the viewport) drives the
  // ScrollView's scrollable range, and fills a short page so the whole sheet
  // stays holdable.
  inputWrap: {
    flexGrow: 1,
  },
  input: {
    // flexGrow (NOT flex:1) so the input's height is its content height, then
    // stretches to fill a short page. flex:1 would collapse the basis to 0 and
    // cap the input at the viewport, leaving a long note with nothing to scroll.
    flexGrow: 1,
    fontSize: 17,
    lineHeight: 26,
    paddingHorizontal: 24,
    paddingTop: 8,
  },
});

export default React.memo(NoteEditor);
