import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Mic, Square } from 'lucide-react-native';
import { useTheme } from '../../theme/colors';
import { registerDictationSink } from './activeEditor';

interface CardComposerProps {
  /** The text in the box. Owned by the caller so it survives the box unmounting. */
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  /** Send the box's contents. The caller clears `value` if it accepted them. */
  onSubmit: (text: string) => void;
  /** Whether the speech-to-text session is live right now. */
  dictating: boolean;
  /** Ask the screen to start/stop that session (it owns the recognizer). */
  onDictate: (on: boolean) => void;
  /** A reply is streaming: the box takes no new turn until it lands (as the
   *  editor's /chat card, which hides its composer mid-stream), and a Stop
   *  control appears beside the mic. */
  running?: boolean;
  /** Stop that reply. Required in practice whenever `running` can be true. */
  onStop?: () => void;
}

// The box is sized from the text alone: the border and padding live on the frame
// around the input, and the input itself carries none, so the bounds below are
// the text's height and nothing else. (Padding differs between the two platforms
// — Android has font padding of its own — and a one-row box that's out by even a
// few pixels stops framing its buttons.)
/** One row of 14px text at the editor's 1.4 leading. */
const LINE_HEIGHT = 20;
/** The frame's own height: 8px padding and a 1px border, top and bottom. Added to
 *  the text height, a one-row box comes to 38px — the 30px corner buttons plus
 *  their 4px inset, exactly as `.cm-ask-followup`'s min-height does in the editor. */
const FRAME = 18;
/** Growth cap — past this the box scrolls internally instead of eating the page.
 *  160px total, matching `.cm-ask-followup`'s max-height. */
const MAX_TEXT_HEIGHT = 160 - FRAME;

// Append a chunk of speech to what's already in the box, with the one space the
// recognizer doesn't give us. Nothing is added at the start, or after whitespace
// the user already typed.
function joinSpeech(base: string, chunk: string): string {
  if (!base) return chunk;
  if (!chunk) return base;
  return /\s$/.test(base) ? base + chunk : base + ' ' + chunk;
}

/**
 * The React Native twin of the editor's card composer (webview-editor's
 * `shared/composer.js` + `ui/mic.js`): one growing text box with its buttons
 * floating over the bottom-right corner, the mic in the corner itself.
 *
 * It is deliberately the same widget to look at and to use — the box spans the
 * full width and text wraps under the opaque buttons rather than around them,
 * Enter submits instead of inserting a newline, and the mic ends a session by
 * sending what was dictated. The difference is underneath: there's no WebView
 * here, so instead of the editor's `window.__dictate*` hooks it registers a
 * DictationSink (see activeEditor) for as long as it's mounted, and the same
 * footer recognizer streams into this box.
 */
export default function CardComposer({
  value,
  onChangeText,
  placeholder,
  onSubmit,
  dictating,
  onDictate,
  running,
  onStop,
}: CardComposerProps) {
  const colors = useTheme();
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);

  // Latest props, read by the dictation sink and the mic-off submit — both fire
  // from outside React's render cycle and must not pin a stale closure.
  const latest = useRef({ value, onChangeText, onSubmit, onDictate });
  latest.current = { value, onChangeText, onSubmit, onDictate };

  const submit = useCallback(() => {
    const text = latest.current.value.trim();
    if (!text) return;
    latest.current.onSubmit(text);
  }, []);

  // The committed text and the utterance in progress, kept apart exactly as the
  // editor keeps its dictation span: each partial result REPLACES the utterance,
  // so only `base` may be appended to.
  const baseRef = useRef(value);
  const spanRef = useRef('');
  // The last value this box put out, so an incoming `value` it didn't write can
  // be told apart from an echo of one it did.
  const emitted = useRef(value);

  const emit = useCallback((text: string) => {
    emitted.current = text;
    latest.current.onChangeText(text);
  }, []);

  const handleChangeText = useCallback(
    (text: string) => {
      // Typing redefines what speech appends to.
      baseRef.current = text;
      spanRef.current = '';
      emit(text);
    },
    [emit],
  );

  // The caller changed the text out from under us — a send clearing the box is
  // the case that matters. Re-baseline, or the next thing dictated would be
  // appended to text that is no longer in the box.
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    baseRef.current = value;
    spanRef.current = '';
  }, [value]);

  // Take the transcript for as long as this box is on screen: it sits in a Modal
  // over the whole pad, so the note underneath must not receive the words.
  useEffect(
    () =>
      registerDictationSink({
        text: (chunk, isFinal) => {
          const next = joinSpeech(baseRef.current, chunk);
          if (isFinal) {
            baseRef.current = next;
            spanRef.current = '';
          } else {
            spanRef.current = chunk;
          }
          emit(next);
        },
        endUtterance: () => {
          if (!spanRef.current) return;
          baseRef.current = joinSpeech(baseRef.current, spanRef.current);
          spanRef.current = '';
          emit(baseRef.current);
        },
        backspace: () => {
          const next = joinSpeech(baseRef.current, spanRef.current).slice(0, -1);
          baseRef.current = next;
          spanRef.current = '';
          emit(next);
        },
        newline: () => submit(),
      }),
    [submit, emit],
  );

  // Ending a session submits what was dictated — the same handoff the editor's
  // composer mic makes (its Enter-on-mic-off), and the reason neither needs a
  // Send button. Only the falling edge counts, so starting the mic sends nothing.
  const wasDictating = useRef(false);
  useEffect(() => {
    if (wasDictating.current && !dictating) submit();
    wasDictating.current = dictating;
  }, [dictating, submit]);

  // Don't leave the mic hot when the box goes away (the page was closed
  // mid-sentence): its transcript would otherwise start landing in the pad.
  useEffect(
    () => () => {
      if (wasDictating.current) latest.current.onDictate(false);
    },
    [],
  );

  const tapMic = useCallback(() => {
    if (dictating) {
      onDictate(false);
      return;
    }
    // Focus first: the box keeps the caret (and its text) while the recognizer
    // runs with the soft keyboard suppressed, so a session that's stopped mid-
    // thought leaves the user typing where they left off.
    inputRef.current?.focus();
    onDictate(true);
  }, [dictating, onDictate]);

  return (
    <View className="relative pt-3">
      {/* The visible box. It owns the border and the padding and takes its height
          from the text inside, so an empty composer is exactly one row tall. */}
      <Pressable
        onPress={() => inputRef.current?.focus()}
        accessible={false}
        className={
          'w-full rounded-[9px] border bg-background px-3 py-2 ' +
          (focused ? 'border-accent' : 'border-surface1')
        }>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={handleChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          multiline
          // Enter sends the box instead of inserting a newline (long text still
          // wraps), matching the editor composer's guarded Enter.
          submitBehavior="submit"
          onSubmitEditing={submit}
          // While the mic is live the box holds the caret without the keyboard over
          // the page — the editor's composer gets the same treatment.
          showSoftInputOnFocus={!dictating}
          editable={!running}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={styles.input}
          textAlignVertical="top"
          className="w-full p-0 text-text"
        />
      </Pressable>
      {/* Parked over the box's bottom-right corner so the buttons ride its last
          line as it grows. Opaque: text that wraps this far runs under them. */}
      <View className="absolute bottom-1 right-1 flex-row gap-1.5">
        {running && onStop && (
          <Pressable
            onPress={onStop}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Stop the reply"
            className="h-[30px] w-[30px] items-center justify-center rounded-lg border border-surface1 bg-surface active:opacity-70">
            <Square size={13} color={colors.faint} fill={colors.faint} strokeWidth={2} />
          </Pressable>
        )}
        <Pressable
          onPress={running ? undefined : tapMic}
          disabled={running}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={dictating ? 'Stop dictation' : 'Dictate'}
          accessibilityState={{ disabled: !!running, selected: dictating }}
          className={
            'h-[30px] w-[30px] items-center justify-center rounded-lg border ' +
            (dictating ? 'border-accent bg-accent' : 'border-surface1 bg-surface') +
            // Nothing to send into while a reply is still arriving, so the mic
            // greys out exactly as the footer's does with nowhere to write.
            (running ? ' opacity-40' : ' active:opacity-70')
          }>
          <Mic size={17} strokeWidth={2} color={dictating ? colors.background : colors.faint} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // An explicit leading — and no font padding under it on Android — is what makes
  // a row measure the same on both platforms, so the height math above holds.
  //
  // The box grows by NOT being given a height: the input sizes itself to its own
  // wrapped text, exactly as the editor's `.cm-ask-followup` does, with these two
  // bounds standing in for its min-height/max-height. Measuring the text in JS
  // (onContentSizeChange → a height in state) is the obvious alternative and the
  // one to avoid: Android never fires that event for text set from JS, so a box
  // being dictated into stayed one row while the words wrapped out of sight.
  input: {
    fontSize: 14,
    lineHeight: LINE_HEIGHT,
    includeFontPadding: false,
    minHeight: LINE_HEIGHT,
    maxHeight: MAX_TEXT_HEIGHT,
  },
});
