import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Mic, MessageSquare, X } from 'lucide-react-native';
import { mocha } from '../../theme/catppuccin';
import { useTheme } from '../../theme/colors';
import { useDashboardChat } from '../../hooks/useDashboardChat';
import { registerDictationSink } from '../notepage/activeEditor';
import ChatMarkdown from '../notepage/ChatMarkdown';
import * as dashboardChat from '../../server/dashboardChat';

interface DashboardChatCardProps {
  /** Whether the footer's speech-to-text session is live (owned by the screen). */
  dictating: boolean;
  /** Ask the screen to stop that session — used when this card goes away with the
   *  mic still hot, so the transcript can't start landing in a note instead. */
  onDictate: (on: boolean) => void;
}

/** The card's height before anyone drags it: enough for a message and a short
 *  reply, with a good part of the dashboard still visible underneath. */
const DEFAULT_CARD_HEIGHT = 280;
/** Floor for a dragged card — the header, the grab strip, and a line under them.
 *  Below this the card stops being readable and starts being a bug. */
const MIN_CARD_HEIGHT = 110;
/** Ceiling, as a fraction of the screen. The card is *over* the dashboard it's
 *  about, so however far the drag goes it has to leave the cards visible. */
const MAX_CARD_FRACTION = 0.6;

/** How much of the card the message may take when there's a conversation above
 *  it, so dragging the card taller gives the room to the replies rather than to
 *  a message that's about to be sent anyway. It scrolls past this — pinned to the
 *  newest words while the mic is live. */
const MAX_MESSAGE_HEIGHT = 110;

/** Everything in the card that isn't the message: the grab strip and the header
 *  bar, plus the message's own padding. Subtracted from the dragged height to
 *  work out how tall the message may be when it's alone in the card. Measuring it
 *  would be exact, but it's a fixed stack of fixed-size chrome, and being a few
 *  pixels out only moves where a scroll starts. */
const CARD_CHROME_HEIGHT = 78;

/** The message's type: the editor's 14px at 1.4 leading, shared by the live
 *  transcript and the editable box so nothing reflows when the mic stops. */
const FONT = 14;
const LINE_HEIGHT = 20;

// Append a chunk of speech to what's already in the box, with the one space the
// recognizer doesn't give us. Nothing is added at the start, or after whitespace
// the user already typed. (Same rule as CardComposer's joinSpeech.)
function joinSpeech(base: string, chunk: string): string {
  if (!base) return chunk;
  if (!chunk) return base;
  return /\s$/.test(base) ? base + chunk : base + ' ' + chunk;
}

/**
 * The dashboard's voice chat, as a card over the bubble footer.
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
 * It's built as a **dashboard section card** — the same width, radius, surface and
 * header bar as Tasks or Archived — because that's what it is: another surface
 * about the same cards, temporarily at the bottom of the same page. Matching the
 * footer's bubbles instead made it a narrow pill that belonged to the chrome
 * rather than to the dashboard, and gave Markdown replies about 250px to wrap in.
 *
 * The card appears the moment the mic goes live and **fills in as you speak**:
 * partial results replace the utterance in progress, finals commit it, and the
 * view is pinned to the newest words. Watching the words land is how you know the
 * recognizer heard you — and it's the only way to catch a mishearing while you're
 * still mid-thought rather than after you've said the whole thing.
 *
 * Stopping the mic turns that transcript into an editable box (same type, same
 * frame, so nothing moves) and hands the footer's mic slot over as the send
 * button. Editing matters for the same reason: fixing one misheard word beats
 * saying the whole message again.
 *
 * **How much of the dashboard it covers is the user's call.** The strip across
 * the card's top edge is a grab handle: drag it up for more of the conversation,
 * down to give the room back to the cards underneath — the same gesture, and the
 * same accent-on-drag grip, the idea page uses to size Claude's replies. It sets
 * a *ceiling*, not a height, so a card with one line in it is still one line tall;
 * the conversation is what grows into the room, and the height survives leaving
 * the dashboard and coming back.
 *
 * The ✕ throws the conversation away — that's how the space over the dashboard is
 * reclaimed, and how the next question starts Claude fresh rather than threaded
 * through everything already said. Cards Claude has already created or changed are
 * on the dashboard and stay there; the dashboard's own controls take those back.
 */
export default function DashboardChatCard({ dictating, onDictate }: DashboardChatCardProps) {
  const colors = useTheme();
  const { draft, turns, running } = useDashboardChat();
  const thread = useRef<ScrollView>(null);
  const live = useRef<ScrollView>(null);
  // Pin a scroller to its last line. Unanimated: this runs while text is
  // arriving, and an animation would be chasing a target that keeps moving.
  const pinThread = useCallback(() => thread.current?.scrollToEnd({ animated: false }), []);
  const pinLive = useCallback(() => live.current?.scrollToEnd({ animated: false }), []);

  // How much of the screen the card may take. Driven on the UI thread so the edge
  // tracks the finger, and written back to the store on release — which is also
  // what survives swiping off the dashboard. Seeded from the store rather than
  // synced to it: this gesture is the only thing that ever writes it.
  const { height: screenH } = useWindowDimensions();
  const maxCardHeight = Math.max(MIN_CARD_HEIGHT, screenH * MAX_CARD_FRACTION);
  const cardHeight = useSharedValue(
    dashboardChat.getState().cardHeight ?? DEFAULT_CARD_HEIGHT,
  );
  const dragStart = useSharedValue(0);
  /** 0 → 1 while the edge is being dragged; the grip takes the accent color so
   *  it's clear the finger has hold of it and not the dashboard behind it. */
  const dragging = useSharedValue(0);

  const commitHeight = useCallback((h: number) => dashboardChat.setCardHeight(h), []);

  // How much room the card is taking, published for the dashboard underneath to
  // pad its scroll by. Held back while the edge is being dragged: the height
  // changes every frame then, and each publish re-renders the page behind the
  // card. The finger lifting flushes whatever the last measurement was.
  const holdHeight = useRef(false);
  const measured = useRef(0);
  const publishHeight = useCallback((h: number) => {
    measured.current = h;
    if (!holdHeight.current) dashboardChat.setOverlayHeight(h);
  }, []);
  const holdWhileDragging = useCallback((held: boolean) => {
    holdHeight.current = held;
    if (!held) dashboardChat.setOverlayHeight(measured.current);
  }, []);

  const resize = useMemo(
    () =>
      Gesture.Pan()
        // A hairline is a small target; take the drag from either side of it.
        .hitSlop({ top: 12, bottom: 12 })
        .onStart(() => {
          dragStart.value = cardHeight.value;
          dragging.value = withTiming(1, { duration: 120 });
          runOnJS(holdWhileDragging)(true);
        })
        .onUpdate(e => {
          // The card is anchored to the footer and grows upward, so dragging the
          // top edge *up* (negative translation) is what makes it taller.
          const next = dragStart.value - e.translationY;
          cardHeight.value = Math.min(maxCardHeight, Math.max(MIN_CARD_HEIGHT, next));
        })
        // Finalize, not end: a drag interrupted partway still leaves the card
        // where the finger left it, so what's on screen is what gets remembered.
        .onFinalize(() => {
          dragging.value = withTiming(0, { duration: 160 });
          runOnJS(commitHeight)(cardHeight.value);
          runOnJS(holdWhileDragging)(false);
        }),
    [cardHeight, dragStart, dragging, maxCardHeight, commitHeight, holdWhileDragging],
  );

  // A ceiling, not a height: the card still sizes to what's in it, and the drag
  // decides how far that's allowed to go (see the thread's `shrink` below).
  const cardStyle = useAnimatedStyle(() => ({ maxHeight: cardHeight.value }));
  // The highlight. The grip goes accent and widens as it's picked up, so the
  // strip reads as a control being held rather than a decoration.
  const gripStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(dragging.value, [0, 1], [mocha.surface1, colors.accent]),
    transform: [{ scaleX: 1 + dragging.value * 0.35 }],
  }));

  // With replies above it the message is held to a few lines, so a taller card
  // gives its room to them. Alone, it IS the card, so it takes whatever the drag
  // allows — otherwise the handle would visibly do nothing until the first reply
  // landed, which reads as a broken control rather than an empty one.
  const hasTurns = turns.length > 0;
  const messageStyle = useAnimatedStyle(() => ({
    maxHeight: hasTurns
      ? MAX_MESSAGE_HEIGHT
      : Math.max(LINE_HEIGHT, cardHeight.value - CARD_CHROME_HEIGHT),
  }));

  // The same resize by keyboard/screen reader, a step at a time.
  const nudgeHeight = useCallback(
    (by: number) => {
      const next = Math.min(maxCardHeight, Math.max(MIN_CARD_HEIGHT, cardHeight.value + by));
      cardHeight.value = next;
      commitHeight(next);
    },
    [cardHeight, maxCardHeight, commitHeight],
  );

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

  // Nothing said and nothing asked: no card, and the footer keeps the strip to
  // itself. The sink above is registered either way — that's what the mic needs
  // to be enabled here in the first place.
  const showMessage = dictating || !!draft;
  const visible = showMessage || hasTurns;

  // With no card there is nothing for the dashboard to scroll clear of, and its
  // padding has to come back down — nothing lays out to say so, so say it here.
  // The unmount case is the same fact: swiping off the dashboard takes the card
  // with it, and the page must not be left padded for a card that's gone.
  useEffect(() => {
    if (!visible) dashboardChat.setOverlayHeight(0);
  }, [visible]);
  useEffect(() => () => dashboardChat.setOverlayHeight(0), []);

  if (!visible) return null;

  return (
    <Animated.View
      // A dashboard section card: same mx-5 inset as the dashboard's own padding,
      // same radius, border and surface. Raised over the page it floats on —
      // Android draws by elevation, so without one it would sit behind it. The
      // animated cap is the dragged height.
      style={[styles.card, cardStyle]}
      onLayout={e => publishHeight(Math.round(e.nativeEvent.layout.height))}
      className="mx-5 mb-2 overflow-hidden rounded-2xl border border-surface1 bg-surface">
      {/* The top edge: a grab strip that sizes the card. It sits above the header
          rather than on it so the ✕ and the drag can't be mistaken for each
          other, and so the handle is the full width of the edge it moves. */}
      <GestureDetector gesture={resize}>
        <View
          accessibilityRole="adjustable"
          accessibilityLabel="Resize the dashboard chat"
          accessibilityActions={ADJUST_ACTIONS}
          onAccessibilityAction={e =>
            nudgeHeight(e.nativeEvent.actionName === 'increment' ? 40 : -40)
          }
          style={styles.edge}>
          <Animated.View style={[styles.grip, gripStyle]} />
        </View>
      </GestureDetector>

      {/* Header bar, as the archive card's search row is the top of that card. */}
      <View className="flex-row items-center gap-2 border-b border-surface1 px-3 pb-2.5">
        {dictating ? (
          <Mic size={14} color={colors.accent} strokeWidth={2.5} />
        ) : (
          <MessageSquare size={14} color={colors.faint} strokeWidth={2.5} />
        )}
        {/* The same 12px bold caps the dashboard's section headers use. */}
        <Text
          className={
            'flex-1 text-xs font-bold uppercase tracking-wider ' +
            (dictating ? 'text-accent' : 'text-faint')
          }>
          {dictating
            ? 'Listening…'
            : running
              ? 'Working…'
              : draft
                ? 'Ready to send'
                : 'Dashboard chat'}
        </Text>
        <Pressable
          onPress={() => dashboardChat.clear()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss this conversation"
          className="active:opacity-70">
          <X size={15} color={colors.faint} strokeWidth={2.5} />
        </Pressable>
      </View>

      {hasTurns && (
        <ScrollView
          ref={thread}
          // No height of its own: it gives way to the card's dragged cap
          // (`shrink`), so a long thread scrolls inside rather than overflowing,
          // and a short one still takes only the room it needs.
          className="shrink"
          // The padding goes on the CONTENT, not on the ScrollView. On the
          // ScrollView it insets the viewport instead of the content, which puts
          // the last line of a reply under the bottom inset with no scroll
          // position that can reach it — the tail of a streamed answer simply
          // could not be read.
          contentContainerStyle={styles.threadContent}
          // Keep the newest text in view as it streams in — on both events. The
          // content growing is the obvious one; the ScrollView's own frame
          // changing is the one that matters here, because it shrinks as the
          // reply grows into the card's cap. onContentSizeChange fires with the
          // frame it had *before* that shrink, so scrolling on it alone lands
          // short by the difference and leaves the last lines below the fold.
          onContentSizeChange={pinThread}
          onLayout={pinThread}
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

      {/* The message. While the mic is live it's a transcript pinned to its own
          last line, so the words are visible as they land and a mishearing is
          caught mid-thought; the moment the mic stops the same text becomes an
          editable box, at the same type and in the same frame, so correcting it
          is just typing and nothing moves under the finger. */}
      {showMessage && (
        <Animated.View
          style={messageStyle}
          className={hasTurns ? 'border-t border-surface1 px-3 py-2.5' : 'px-3 py-2.5'}>
          {dictating ? (
            <ScrollView
              ref={live}
              // Gives way to the cap above rather than overflowing it, so the
              // transcript scrolls inside whatever room the card has.
              className="shrink"
              // Both events, for the same reason the thread above uses both.
              onContentSizeChange={pinLive}
              onLayout={pinLive}
              showsVerticalScrollIndicator={false}>
              <Text
                style={styles.text}
                className={draft ? 'text-text' : 'text-faint'}
                // Read out as it grows, so the transcript is followable without
                // watching the screen.
                accessibilityLiveRegion="polite">
                {draft || 'Listening — say what you want changed…'}
              </Text>
            </ScrollView>
          ) : (
            <TextInput
              value={draft}
              onChangeText={handleChangeText}
              multiline
              accessibilityLabel="Message to send to the dashboard"
              style={[styles.text, styles.input]}
              textAlignVertical="top"
              className="w-full shrink p-0 text-text"
            />
          )}
        </Animated.View>
      )}
    </Animated.View>
  );
}

/** Resize by 40px a step for anyone driving the handle from a screen reader. */
const ADJUST_ACTIONS = [{ name: 'increment' }, { name: 'decrement' }];

const styles = StyleSheet.create({
  card: { zIndex: 10, elevation: 6 },
  // On the content, not on the ScrollView — see the note at the call site.
  threadContent: { paddingHorizontal: 12, paddingVertical: 10 },
  // The grab strip across the card's top edge. Tall enough to be a real target
  // without reading as a band of empty card above the header.
  edge: { alignItems: 'center', paddingTop: 8, paddingBottom: 8 },
  grip: { height: 4, width: 36, borderRadius: 2 },
  // Shared by both halves of the message so the swap at the end of a session is
  // invisible: same size, same leading, and no Android font padding under either.
  text: { fontSize: FONT, lineHeight: LINE_HEIGHT, includeFontPadding: false },
  // The box grows by NOT being given a height — it sizes itself to its own
  // wrapped text, exactly as CardComposer's does. What bounds it here is the
  // animated cap on the wrapper above, which the box shrinks to fit.
  input: { minHeight: LINE_HEIGHT },
});
