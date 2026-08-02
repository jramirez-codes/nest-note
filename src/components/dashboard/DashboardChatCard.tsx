import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { X } from 'lucide-react-native';
import { useTheme } from '../../theme/colors';
import { useDashboardChat } from '../../hooks/useDashboardChat';
import { registerDictationSink } from '../notepage/activeEditor';
import ChatMarkdown from '../notepage/ChatMarkdown';
import * as dashboardChat from '../../server/dashboardChat';

interface DashboardChatCardProps {
  /** The bubble footer's measured width, so the card lines up with the strip it
   *  floats above. 0 until the footer has laid out. */
  width: number;
  /** Whether the footer's speech-to-text session is live (owned by the screen). */
  dictating: boolean;
  /** Ask the screen to stop that session — used when this card goes away with the
   *  mic still hot, so the transcript can't start landing in a note instead. */
  onDictate: (on: boolean) => void;
}

/** How much of the screen the conversation may take before it scrolls inside the
 *  card. The card floats over the dashboard, so it has to leave the cards it's
 *  about visible — a couple of turns' worth, and the rest scrolls. */
const MAX_THREAD_HEIGHT = 240;
/** Growth cap for the message box, matching CardComposer's: past this it scrolls
 *  internally instead of pushing the card up the screen. */
const MAX_DRAFT_HEIGHT = 120;

// Append a chunk of speech to what's already in the box, with the one space the
// recognizer doesn't give us. Nothing is added at the start, or after whitespace
// the user already typed. (Same rule as CardComposer's joinSpeech.)
function joinSpeech(base: string, chunk: string): string {
  if (!base) return chunk;
  if (!chunk) return base;
  return /\s$/.test(base) ? base + chunk : base + ' ' + chunk;
}

/**
 * The dashboard's voice chat, as a card floating above the bubble footer.
 *
 * The footer mic used to be dead on the dashboard: there was no note to dictate
 * into. Here it has something better to write to — the cards themselves. This
 * component is what makes that true, in two halves:
 *
 *  - **The dictation target.** For as long as it's mounted (which is exactly as
 *    long as the dashboard is the page on screen and no idea page is open over
 *    it) it registers a DictationSink, so the footer's recognizer streams into
 *    this conversation instead of into the pad. That's also what makes the mic
 *    *enabled* there at all — `hasActiveEditor()` is what the mic gates on.
 *  - **The conversation.** Everything said and everything Claude replied, over
 *    the dashboard it's about. Replies are Markdown, drawn with the same widgets
 *    the editor uses (ChatMarkdown), so a list or a bit of `inline code` reads
 *    here as it does in a card.
 *
 * It shows nothing until there is something to show. Speaking fills the message
 * box, but that box waits for the mic to stop: a live session is the user talking,
 * not reading, and a box growing word by word over the very cards they're
 * describing is in the way. Stop, and it's there with what you said, ready to send
 * — the footer's mic slot becomes the send button (see PageIndicator). Replies
 * already on screen do stay through a session, since a follow-up is usually asked
 * at the last answer.
 *
 * The message is editable before it goes: speech recognition mishears, and fixing
 * one word by hand beats saying the whole thing again.
 *
 * The ✕ throws the conversation away — that's how the space over the dashboard is
 * reclaimed, and how the next question starts Claude fresh rather than threaded
 * through everything already said. Cards Claude has already created or changed are
 * on the dashboard and stay there; the dashboard's own controls take those back.
 */
export default function DashboardChatCard({
  width,
  dictating,
  onDictate,
}: DashboardChatCardProps) {
  const colors = useTheme();
  const { draft, turns, running } = useDashboardChat();
  const scroll = useRef<ScrollView>(null);
  const [focused, setFocused] = useState(false);

  // The committed text and the utterance in progress, kept apart exactly as the
  // editor keeps its dictation span: each partial result REPLACES the utterance,
  // so only `base` may be appended to.
  const baseRef = useRef(draft);
  const spanRef = useRef('');
  // The last value this card put into the store, so a draft it didn't write (the
  // send that emptied the box) can be told apart from an echo of one it did.
  const emitted = useRef(draft);

  const emit = useCallback((text: string) => {
    emitted.current = text;
    dashboardChat.setDraft(text);
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

  // The store changed the draft out from under us — sending, or the ✕ clearing
  // it. Re-baseline, or the next thing dictated would be appended to text that is
  // no longer in the box.
  useEffect(() => {
    if (draft === emitted.current) return;
    emitted.current = draft;
    baseRef.current = draft;
    spanRef.current = '';
  }, [draft]);

  // Take the transcript for as long as the dashboard is on screen. This is the
  // whole reason the footer mic works here, so it is registered unconditionally —
  // not only while the card has something to draw.
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
        // The footer's recording-mode New line button. It breaks the line rather
        // than submitting (as a card composer's does): sending is the footer's
        // send button, and a message dictated in two sentences shouldn't post
        // itself halfway through.
        newline: () => {
          const next = joinSpeech(baseRef.current, spanRef.current) + '\n';
          baseRef.current = next;
          spanRef.current = '';
          emit(next);
        },
      }),
    [emit],
  );

  // Don't leave the mic hot when the dashboard goes away (the user swiped onto a
  // note mid-sentence): with this sink gone the transcript would start landing in
  // whatever page is now in front of them.
  const latestDictate = useRef(onDictate);
  latestDictate.current = onDictate;
  const wasDictating = useRef(false);
  useEffect(() => {
    wasDictating.current = dictating;
  }, [dictating]);
  useEffect(
    () => () => {
      if (wasDictating.current) latestDictate.current(false);
    },
    [],
  );

  // The message box waits for the mic to stop: a live session is the user
  // talking, not reading, and a box growing word by word over the cards they're
  // describing is in the way. Replies already on screen stay put through it
  // though — a follow-up is usually asked *at* the last answer, so taking it away
  // the moment they start speaking would be worse than the box appearing late.
  const showDraft = !!draft && !dictating;
  // With neither, there's no card at all and the footer keeps the strip to itself.
  if (turns.length === 0 && !showDraft) return null;

  return (
    <View
      // Matched to the bubble footer below it, and raised over the dashboard:
      // Android draws by elevation, so the card needs one to sit above the page
      // it floats on rather than behind it.
      style={[styles.card, width ? { width } : undefined]}
      className="mb-2 self-center rounded-2xl border border-surface1 bg-surface px-3 py-2.5">
      <View className="mb-1.5 flex-row items-center justify-between">
        <Text style={styles.eyebrow} className="text-[10px] font-bold uppercase text-faint">
          {dictating
            ? 'Listening…'
            : running
              ? 'Working…'
              : showDraft
                ? 'Ready to send'
                : 'Dashboard chat'}
        </Text>
        <Pressable
          onPress={() => dashboardChat.clear()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss this conversation"
          className="h-[22px] w-[22px] items-center justify-center rounded-lg border border-surface1 bg-background active:opacity-70">
          <X size={13} color={colors.faint} strokeWidth={2.5} />
        </Pressable>
      </View>

      {turns.length > 0 && (
        <ScrollView
          ref={scroll}
          style={styles.thread}
          // Keep the newest text in view as it streams in.
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
          showsVerticalScrollIndicator={false}>
          {turns.map((t, i) => (
            <View key={i} className={i > 0 ? 'mt-2.5' : undefined}>
              {/* What was said, kept small — the reply is the point. */}
              <Text className="text-[12px] italic text-faint">{t.q}</Text>
              {t.a ? (
                <View className="mt-1">
                  <ChatMarkdown text={t.a.trim()} />
                </View>
              ) : t.status === 'streaming' ? (
                <Text className="mt-1 text-[14px] text-muted">Thinking…</Text>
              ) : null}
              {t.status === 'error' && (
                <Text className="mt-1 text-[12px] text-red">
                  {t.msg || 'Something went wrong.'}
                </Text>
              )}
            </View>
          ))}
        </ScrollView>
      )}

      {/* The message waiting to go, as the mic heard it — editable, because a
          misheard word is quicker to fix than to say again. The send button is
          the footer's mic slot, not a button in here: this card floats above it. */}
      {showDraft && (
        <View
          className={
            'rounded-[9px] border bg-background px-2.5 py-1.5 ' +
            (focused ? 'border-accent' : 'border-surface1') +
            (turns.length > 0 ? ' mt-2.5' : '')
          }>
          <TextInput
            value={draft}
            onChangeText={handleChangeText}
            multiline
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            accessibilityLabel="Message to send to the dashboard"
            style={styles.input}
            textAlignVertical="top"
            className="w-full p-0 text-text"
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { zIndex: 10, elevation: 6 },
  thread: { maxHeight: MAX_THREAD_HEIGHT },
  // Tailwind's tracking-wider is too tight for 10px caps; the same letter spacing
  // the idea page's eyebrow uses.
  eyebrow: { letterSpacing: 1.1 },
  // As CardComposer's box: an explicit leading with no Android font padding under
  // it, and no height of its own, so the box grows with the text it holds.
  input: {
    fontSize: 14,
    lineHeight: 20,
    includeFontPadding: false,
    minHeight: 20,
    maxHeight: MAX_DRAFT_HEIGHT,
  },
});
