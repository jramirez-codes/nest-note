import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { ArrowUp, Eraser, Mic, MessageSquare, X } from 'lucide-react-native';
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
  /** The notebook the dashboard is filtered to (a subject slug, or null on the
   *  Sandbox's aggregate view) — where a card the turn creates gets filed. Needed
   *  here because stopping the mic sends the message from this card. */
  scope: string | null;
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

/** One word of the message: what it says, where it sits in the draft, and whether
 *  a line break stands in front of it. */
interface Word {
  text: string;
  /** Index the word starts at in the draft — its identity for a rub, and its key. */
  start: number;
  end: number;
  breaks: boolean;
}

/**
 * Split the message into the words the eraser can be dragged over.
 *
 * The indices are the point: a rub cuts the words back out of the original
 * string rather than re-joining the survivors, so whatever the user (or the
 * footer's New line button) put between two words is still there afterwards.
 */
function toWords(text: string): Word[] {
  const out: Word[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let prevEnd = 0;
  while ((m = re.exec(text)) !== null) {
    out.push({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
      breaks: text.slice(prevEnd, m.index).includes('\n'),
    });
    prevEnd = m.index + m[0].length;
  }
  return out;
}

/**
 * Cut the rubbed-out words from the message, and tidy the gaps they leave —
 * spaces that now sit next to each other collapse to one, and the ends are
 * trimmed. Without it, rubbing a word out of the middle of a sentence leaves a
 * visible hole in the box and sends Claude a prompt with a double space in it.
 */
function rubOut(text: string, words: Word[], rubbed: ReadonlySet<number>): string {
  let out = '';
  let cursor = 0;
  for (const w of words) {
    if (!rubbed.has(w.start)) continue;
    out += text.slice(cursor, w.start);
    cursor = w.end;
  }
  out += text.slice(cursor);
  return out
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

/** The "nothing is rubbed out" set. A stable identity, so resetting to it when
 *  it's already the state doesn't re-render. */
const NO_WORDS: ReadonlySet<number> = new Set<number>();

/** A measured rectangle in window coordinates — where a word, or the frame it's
 *  drawn in, sits on the screen the finger is being dragged across. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function within(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
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
 * **Stopping the mic sends what was said.** Talking is the whole interaction, so
 * the tap that ends the sentence is the tap that posts it — a second tap on a
 * second control to confirm a message the user has just watched land, word by
 * word, is a step that only ever costs a tap. Getting it wrong is what the
 * **eraser** in the bottom corner is for, and it corrects at both the sizes a
 * misspoken instruction goes wrong at: **tap** it and the whole message goes, to
 * be said again from the top; **drag** it across the transcript and it rubs out
 * only the words it's pulled over, so one misheard phrase in the middle of a good
 * sentence doesn't cost the sentence. (A single misheard character is smaller
 * still — that's the footer's Delete button.)
 *
 * The one case where the message doesn't go is a reply still streaming — two
 * concurrent turns would be two agents writing to the same cards. It stays in an
 * editable box then (same type, same frame, so nothing moves), and the footer's
 * mic slot becomes the send button for it once the reply lands.
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
 *
 * That corner is a **send** button while the mic is live, though. Stopping to send
 * is fine for one instruction, but a run of them shouldn't cost a recogniser
 * teardown and restart between each — so mid-session the header posts what's been
 * said and leaves the mic listening for the next one.
 */
export default function DashboardChatCard({
  dictating,
  onDictate,
  scope,
}: DashboardChatCardProps) {
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
  // Set when the message is edited (cleared, or rubbed) with an utterance still
  // open, to throw the rest of that utterance away. Without it, taking words out
  // mid-sentence undoes itself: a partial result carries the whole utterance so
  // far, so the very next one puts back what was just taken.
  const dropUtterance = useRef(false);

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

  // Put a different message in the box — the whole of it, as the eraser's two
  // gestures both do (cleared, or with the rubbed-out words cut from it).
  //
  // The sentence in progress goes with it. Partial results carry the whole
  // utterance so far, so anything rubbed out of one would be written straight back
  // by its next partial; abandoning it is the only honest outcome, and it's the
  // same rule for both gestures — what you take out stays out, and you carry on
  // from a clean sentence.
  const replaceMessage = useCallback(
    (next: string) => {
      if (spanRef.current) dropUtterance.current = true;
      baseRef.current = next;
      spanRef.current = '';
      emit(next);
    },
    [emit],
  );

  // Start the message over. Speech appends to what's already there, so an
  // instruction that came out wrong can only be fixed by saying it again from the
  // top — this is what makes that possible without stopping the mic, which would
  // send the bad one. The conversation above is untouched: it's this prompt being
  // restarted, not the chat being dismissed (that's the ✕).
  const clearPrompt = useCallback(() => replaceMessage(''), [replaceMessage]);

  // Post what's been said so far and keep the mic running, so a second
  // instruction can be started straight after the first without the recogniser
  // being torn down and re-started between them. The draft emptying is what
  // re-baselines the dictation (see the effect below) — including abandoning the
  // sentence in progress, since a partial would otherwise write the message that
  // just went straight back into the empty box.
  const sendNow = useCallback(() => dashboardChat.send(scope), [scope]);
  // Nothing said yet, or a turn already streaming — `send` would no-op, so the
  // control says so rather than looking broken.
  const canSend = !!draft.trim() && !running;

  // The message as words, for the eraser to be dragged over. Mirrored into refs
  // alongside the draft they were cut from, so the gesture's callbacks commit
  // against the same string the indices below were taken from.
  const words = useMemo(() => toWords(draft), [draft]);
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Words the eraser has been dragged across during this rub. They're struck
  // through where they stand rather than removed on contact: taking them out
  // under the finger would reflow the line mid-rub, so what the eraser covered
  // next would be decided by the erasing itself. The release is what cuts them.
  // The ref leads and the state follows, rather than the ref mirroring the state
  // at render: the finger can lift in the same JS tick as the last word is marked,
  // and a ref written on the next render would still be a word behind by the time
  // the release reads it — the last thing rubbed out would come back.
  const [rubbed, setRubbed] = useState<ReadonlySet<number>>(NO_WORDS);
  const rubbedRef = useRef(rubbed);
  const applyRubbed = useCallback((next: ReadonlySet<number>) => {
    rubbedRef.current = next;
    setRubbed(next);
  }, []);

  // Where each word is on screen, in window coordinates, and whether a rub is
  // running. The finger's position arrives from the gesture in that same space,
  // so the hit test never has to unpick the nesting between the card and the
  // words (card → message → scroller) or the scroll offset inside it.
  const wordNodes = useRef(new Map<number, React.ComponentRef<typeof Text>>());
  const wordRects = useRef(new Map<number, Rect>());
  const rubActive = useRef(false);
  // The message's visible frame, measured with the words. A long transcript
  // scrolls inside it, and a word scrolled out of sight still has a position —
  // one that lands behind the header or the thread above. Without this the eraser
  // could be dragged up there and take words the user can't see.
  const messageBox = useRef<View>(null);
  const boxRect = useRef<Rect | null>(null);

  const measureWords = useCallback(() => {
    wordRects.current.clear();
    boxRect.current = null;
    messageBox.current?.measureInWindow((x, y, w, h) => {
      boxRect.current = { x, y, w, h };
    });
    for (const [key, node] of wordNodes.current) {
      node.measureInWindow((x, y, w, h) => wordRects.current.set(key, { x, y, w, h }));
    }
  }, []);

  // Mark whatever is under the eraser. Point-in-word rather than a radius around
  // it: a word is a good 20px tall and the lines are stacked, so a disc wide
  // enough to feel generous would take the line above as well.
  const rubAt = useCallback(
    (x: number, y: number) => {
      const box = boxRect.current;
      if (!box || !within(box, x, y)) return;
      const hits: number[] = [];
      for (const [key, r] of wordRects.current) {
        if (within(r, x, y)) hits.push(key);
      }
      if (hits.length === 0) return;
      const prev = rubbedRef.current;
      if (hits.every(k => prev.has(k))) return; // still over what it just took
      const next = new Set(prev);
      for (const k of hits) next.add(k);
      applyRubbed(next);
    },
    [applyRubbed],
  );

  const startRub = useCallback(() => {
    rubActive.current = true;
  }, []);

  // The finger lifting is what cuts the struck-through words out. A drag that
  // reached no word at all (or a tap, which finalizes without ever activating)
  // leaves the message alone — clearing it wholesale is the tap's job, and doing
  // it here would turn a rub that missed into a wiped box.
  const commitRub = useCallback(() => {
    rubActive.current = false;
    const marks = rubbedRef.current;
    if (marks.size === 0) return;
    applyRubbed(NO_WORDS);
    replaceMessage(rubOut(draftRef.current, wordsRef.current, marks));
  }, [applyRubbed, replaceMessage]);

  // The eraser's own travel while it's being dragged, and how far it's picked up.
  const rubX = useSharedValue(0);
  const rubY = useSharedValue(0);
  const lifted = useSharedValue(0);

  const rub = useMemo(
    () =>
      Gesture.Pan()
        // Only where there are laid-out words to rub. With the mic stopped the
        // message is a TextInput — there the box is edited by typing in it, and
        // the eraser stays the plain clear-it-all button.
        .enabled(dictating)
        // Far enough that a tap meant for "clear the lot" can't become a rub on a
        // wobble; close enough that a deliberate drag is picked up at once.
        .minDistance(8)
        // On touch-down rather than activation, so the rects are in hand by the
        // time the finger has travelled that 8px and could be over a word.
        .onBegin(() => runOnJS(measureWords)())
        .onStart(() => {
          lifted.value = withTiming(1, { duration: 120 });
          runOnJS(startRub)();
        })
        .onUpdate(e => {
          rubX.value = e.translationX;
          rubY.value = e.translationY;
          runOnJS(rubAt)(e.absoluteX, e.absoluteY);
        })
        // Finalize, not end: a rub the system interrupts still commits what the
        // user watched it take, rather than silently putting the words back.
        .onFinalize(() => {
          rubX.value = withTiming(0, { duration: 180 });
          rubY.value = withTiming(0, { duration: 180 });
          lifted.value = withTiming(0, { duration: 180 });
          runOnJS(commitRub)();
        }),
    [dictating, measureWords, rubAt, startRub, commitRub, rubX, rubY, lifted],
  );

  // The eraser follows the finger and swells a little as it's picked up, so it
  // reads as an object being dragged over the words rather than a button that
  // came loose. It springs back to its corner on release.
  const rubStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: rubX.value },
      { translateY: rubY.value },
      { scale: 1 + lifted.value * 0.15 },
    ],
  }));

  // Speech landing mid-rub moves the words out from under the rects measured at
  // touch-down. Re-measure on the container's own relayout (once, not once per
  // word) so what the eraser takes stays what it's actually over.
  const onWordsLayout = useCallback(() => {
    if (rubActive.current) measureWords();
  }, [measureWords]);

  // The store changed the draft out from under us — sending, or the ✕ clearing
  // it. Re-baseline, or the next thing dictated would be appended to text that is
  // no longer in the box.
  useEffect(() => {
    if (draft === emitted.current) return;
    // Emptied from outside with an utterance still open — the ✕ pressed
    // mid-sentence. The rest of that utterance has to go too, or its next partial
    // refills the box that was just emptied (see dropUtterance).
    if (!draft && spanRef.current) dropUtterance.current = true;
    emitted.current = draft;
    baseRef.current = draft;
    spanRef.current = '';
    // Marks index into the message that just went (the mic stopping sent it, say,
    // mid-rub). Against the new one they'd point at whatever words now happen to
    // sit at those offsets. NO_WORDS is a stable identity, so this is free when
    // nothing was marked.
    applyRubbed(NO_WORDS);
  }, [draft, applyRubbed]);

  // Take the transcript for as long as the dashboard is on screen. This is the
  // whole reason the footer mic works here, so it is registered unconditionally —
  // not only while the card has something to draw.
  useEffect(
    () =>
      registerDictationSink({
        text: (chunk, isFinal) => {
          // Cleared mid-sentence: swallow the rest of that utterance rather than
          // let its cumulative partials refill the box. The final closes it, and
          // whatever is said next starts a new one that lands normally.
          if (dropUtterance.current) {
            if (isFinal) dropUtterance.current = false;
            return;
          }
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
          // The dropped utterance ended without a final (a no-match) — it's over
          // either way, so stop swallowing and take the next one.
          if (dropUtterance.current) {
            dropUtterance.current = false;
            return;
          }
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
        // than submitting (as a card composer's does): stopping the mic is what
        // sends here, and a message dictated in two sentences shouldn't post
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
  // Read at the moment the mic stops rather than closed over, so a notebook
  // swapped mid-sentence files the turn's cards under the one now on screen.
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const wasDictating = useRef(false);

  // The mic going off is the send. `send` reads the draft from the store itself,
  // and no-ops on an empty one (nothing was said) or while a turn is still
  // streaming — that message stays in the box for the footer's send button, since
  // a second turn would be a second agent writing to the same cards.
  useEffect(() => {
    if (wasDictating.current && !dictating) {
      // A swallowed utterance dies with the session that was speaking it — the
      // recognizer stops without a final, and left set this would eat the opening
      // words of the next session instead.
      dropUtterance.current = false;
      dashboardChat.send(latestScope.current);
    }
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
        {/* While the mic is live this corner sends instead of dismissing. Mid-
            session the message is the thing being worked on, and posting it
            without stopping to tap the footer — then tapping again to start
            talking — is what keeps a run of instructions one continuous session.
            Throwing the conversation away isn't something you reach for
            mid-sentence anyway, and the ✕ is back the moment the mic stops.

            A bare icon at the same size either way: a filled chip would read as
            more of a button, but it would also make the header taller when the
            mic goes on, and nothing in this card is allowed to move under the
            finger. Accent is what "live" already means here (the mic, the
            Listening… label), so the arrow wears it too. */}
        {dictating ? (
          <Pressable
            onPress={sendNow}
            disabled={!canSend}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Send what's been said so far"
            accessibilityState={{ disabled: !canSend }}
            className={canSend ? 'active:opacity-70' : 'opacity-40'}>
            <ArrowUp size={16} color={colors.accent} strokeWidth={2.5} />
          </Pressable>
        ) : (
          <Pressable
            onPress={() => dashboardChat.clear()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Dismiss this conversation"
            className="active:opacity-70">
            <X size={15} color={colors.faint} strokeWidth={2.5} />
          </Pressable>
        )}
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
          ref={messageBox}
          style={messageStyle}
          // The right gutter is the lane the clear button is pinned in (below).
          // Reserved whether or not the button is currently in it, so the text
          // doesn't reflow around a control appearing on the first word spoken.
          className={
            hasTurns ? 'border-t border-surface1 py-2.5 pl-3 pr-11' : 'py-2.5 pl-3 pr-11'
          }>
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
              {draft ? (
                // A word per Text, wrapped as a row, rather than one Text with the
                // whole message in it: each word has to be measurable on its own
                // for the eraser to know what it's over. The type and leading are
                // the message's, and the gap is a space's width, so it reads as the
                // sentence it is. Announced as one string — the words are an
                // implementation detail, not thirty things to swipe through.
                <View
                  style={styles.words}
                  onLayout={onWordsLayout}
                  accessible
                  accessibilityLiveRegion="polite"
                  accessibilityLabel={draft}>
                  {words.map(w => {
                    const gone = rubbed.has(w.start);
                    return (
                      <React.Fragment key={w.start}>
                        {/* A full-width nothing, to break the row where the user's
                            own line break was. */}
                        {w.breaks && <View style={styles.wordBreak} />}
                        <Text
                          ref={node => {
                            if (node) wordNodes.current.set(w.start, node);
                            else wordNodes.current.delete(w.start);
                          }}
                          style={[styles.text, gone && styles.rubbedWord]}
                          className={gone ? 'text-faint' : 'text-text'}>
                          {w.text}
                        </Text>
                      </React.Fragment>
                    );
                  })}
                </View>
              ) : (
                <Text style={styles.text} className="text-faint" accessibilityLiveRegion="polite">
                  Listening — say what you want changed…
                </Text>
              )}
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

      {/* The eraser. Pinned to the card's bottom-right rather than sat in the
          header: it belongs to the message, so it sits at the message, in the
          corner nearest the thumb that's about to use it. Absolute on the card —
          not inside the scrollers — so it holds that corner however tall the card
          is dragged and however far the conversation is scrolled.

          It's also the far corner from the ✕, which is worth the distance: one
          restarts a sentence, the other bins the whole conversation, and a
          mis-tap between them isn't recoverable. Only shown once there's a
          message to work on.

          Tap it and the whole message goes. Drag it and it's an eraser in the
          literal sense — the words it's pulled across strike through as it passes
          and are cut out when it's let go, so a misheard phrase in the middle of a
          good sentence costs a swipe rather than the whole prompt. The Pressable
          inside the detector keeps the tap a real button press (a screen reader
          activates it the ordinary way); the pan claims the touch off it as soon
          as the finger travels, so a rub never also fires the tap. */}
      {!!draft && (
        <GestureDetector gesture={rub}>
          <Animated.View style={[styles.clear, rubStyle]}>
            <Pressable
              onPress={clearPrompt}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Clear this message and start again"
              accessibilityHint={
                dictating ? 'Or drag across words to rub out just those' : undefined
              }
              className="h-7 w-7 items-center justify-center rounded-full border border-surface1 bg-background active:opacity-70">
              <Eraser size={14} color={colors.faint} strokeWidth={2.5} />
            </Pressable>
          </Animated.View>
        </GestureDetector>
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
  // Held in the card's bottom-right corner, over the message rather than in it.
  // Last child, so it draws above the text on both platforms; the message's right
  // padding is what keeps the words out from under it.
  clear: { position: 'absolute', right: 8, bottom: 8 },
  // The message, laid out a word at a time. The column gap stands in for the
  // space between words at this size; rows stack on the shared line height, so
  // the block measures the same as the single Text it replaced.
  words: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 4 },
  wordBreak: { width: '100%', height: 0 },
  // Struck through while the eraser is over it: still readable, so it's clear
  // what's about to go, but plainly on its way out.
  rubbedWord: { textDecorationLine: 'line-through' },
});
