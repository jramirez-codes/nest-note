import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { CornerDownLeft, Delete, Mic } from 'lucide-react-native';
import { useTheme } from '../../theme/colors';

interface PageIndicatorProps {
  /** Zero-based index of the active page, spanning notes then the new-note sheet. */
  currentIndex: number;
  /** The page we'd return to on a tap — previewed by the bar while on the dashboard. */
  prevIndex: number;
  /** How many real notes exist; the dashboard sits at index `noteCount`. */
  noteCount: number;
  /** Jump to the trailing dashboard page. */
  onPressDashboard: () => void;
  /** Tap (not scrub) the progress bubble — jump back to the previous page. */
  onPressProgress: () => void;
  /** Screen width, used to scale how far a scrub drag travels per page. */
  scrubWidth: number;
  /** Jump to a note page while the user scrubs the progress bubble. */
  onScrub: (index: number) => void;
  /** Whether the speech-to-text mic is currently live. */
  dictating: boolean;
  /** Disable the mic (e.g. on the dashboard or a read-only subject page, where
   *  there's no editable note to dictate into). */
  dictationDisabled: boolean;
  /** Toggle the speech-to-text mic on/off. */
  onToggleDictation: () => void;
  /** Recording-mode Delete — one Backspace press in the note being dictated into. */
  onBackspace: () => void;
  /** Recording-mode New line — one Enter press in the note being dictated into. */
  onNewline: () => void;
}

/** Displacement (px) from the press point before paging starts — a dead zone so
 * a still finger, or a tiny wobble, holds the current page. */
const SCRUB_DEAD_ZONE = 14;
/** Top paging speed, reached once the finger is dragged a full ramp away. */
const MAX_PAGES_PER_SEC = 14;
/** How far the bubble follows the finger horizontally, for a tactile nudge. */
const FOLLOW_LIMIT = 28;
/** How high the bubble pops up while held. */
const LIFT_DISTANCE = 46;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Bring `index` into [0, total) with wraparound (handles negatives). */
function wrapIndex(index: number, total: number) {
  return ((index % total) + total) % total;
}

/**
 * Pages-per-second to advance for a given finger displacement from the press
 * point. This is a jog/shuttle dial: near the press point it's zero (hold to
 * stay put); the further toward either edge, the faster it pages, in that
 * direction. Squared ramp gives fine control near the middle and full speed at
 * the edges — so parking a finger on the left or right of the screen keeps
 * paging until released.
 */
function pagesPerSecond(dx: number, scrubWidth: number) {
  const ramp = Math.max(1, scrubWidth * 0.4);
  const mag = Math.max(0, Math.abs(dx) - SCRUB_DEAD_ZONE);
  const t = Math.min(1, mag / ramp);
  return Math.sign(dx) * MAX_PAGES_PER_SEC * t * t;
}

/**
 * Bottom-of-screen navigation for the pad, rendered as two bubbles:
 *   - left  — a progress bubble showing how far through the pad you are
 *             (a fill bar + "n / total"); active while you're on a note. Tap it
 *             to jump back to the previous page (e.g. from the dashboard back to
 *             the note you left). Press and hold it to lift it up, then slide
 *             left/right to scrub through the pages; releasing drops it back to
 *             its origin.
 *   - right — the "new note" bubble; active while you're on the trailing sheet.
 *
 * Built for hundreds of pages: the left bubble is a continuous progress bar
 * rather than one-dot-per-page.
 *
 * While dictation is live those two navigation bubbles are swapped for a Delete
 * and a New line button — editing controls are what's wanted mid-utterance, and
 * paging away would only redirect the transcript. The mic itself stays put (it's
 * how the user stops), so it keeps its slot in both modes.
 */
function PageIndicator({
  currentIndex,
  prevIndex,
  noteCount,
  onPressDashboard,
  onPressProgress,
  scrubWidth,
  onScrub,
  dictating,
  dictationDisabled,
  onToggleDictation,
  onBackspace,
  onNewline,
}: PageIndicatorProps) {
  const colors = useTheme();
  const onDashboard = currentIndex >= noteCount;
  // On a note the bar tracks the current page; on the dashboard it previews the
  // page a tap would return to, so the bubble shows where you're headed.
  const targetIndex = onDashboard ? prevIndex : currentIndex;
  // Which note we're on (1-based), clamped so the trailing sheet reads as the
  // last note rather than overrunning the count.
  const notePosition = Math.min(Math.max(targetIndex, 0) + 1, noteCount);
  // Fraction of the pad covered. Guard the empty pad (only the new-note sheet).
  const progress = noteCount > 0 ? notePosition / noteCount : 0;

  // 0 at rest, 1 while lifted/held. Drives translateY + scale on the native
  // thread so the pop-up stays smooth even while pages swap underneath.
  const lift = useRef(new Animated.Value(0)).current;
  // Horizontal follow so the bubble trails the finger a touch as you scrub.
  const panX = useRef(new Animated.Value(0)).current;
  const [scrubbing, setScrubbing] = useState(false);
  // True while the dashboard "back" button is held, for a quick press highlight
  // (the scrub lift doesn't run on the dashboard, so this is its only feedback).
  const [pressed, setPressed] = useState(false);

  // Measured widths of the two navigation bubbles, so the recording-mode buttons
  // that stand in for them can be *exactly* as wide — Delete takes the scrub
  // bubble's width, New line the Dashboard bubble's. Both widths are content-
  // derived (the scrub pill's grows with the digits in "n / total", and either can
  // shift with the device font scale), so they're measured rather than hardcoded.
  // Captured while the bubbles are mounted, which is every render that isn't
  // recording — dictation always starts from a tap on the mic, so a width is in
  // hand well before the swap needs it.
  const [navWidths, setNavWidths] = useState<{ gesture: number; dashboard: number }>({
    gesture: 0,
    dashboard: 0,
  });
  // onLayout re-fires on every layout pass; only a real change is worth a render
  // (and the equality check keeps the measure → setState → re-measure path from
  // looping). Rounded because sub-pixel layout jitter isn't a width change.
  const measureNav = useCallback((key: 'gesture' | 'dashboard', w: number) => {
    const next = Math.round(w);
    setNavWidths(prev => (prev[key] === next ? prev : { ...prev, [key]: next }));
  }, []);

  // Shuttle state. The gesture only sets a paging *rate*; a requestAnimationFrame
  // loop integrates that rate over time and steps the page index, so parking a
  // finger at the edge keeps paging without any further movement.
  const rateRef = useRef(0); // pages per second, sign = direction
  const accRef = useRef(0); // fractional pages accumulated since the last step
  const scrubIndexRef = useRef(0); // integer note index currently shown
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);
  // Whether the shuttle already stepped a page during the current gesture. A
  // quick drag-and-release integrates to less than one page, so the shuttle
  // alone moves nothing; on release we turn such a swipe into a single page step
  // (see endGestureRef) — but only when the shuttle didn't already page.
  const steppedRef = useRef(false);

  // Latest values for the pan handlers, which close over a stable responder.
  // `onDashboard` flips the bubble's whole mode: a note page enables scrubbing
  // (and tapping does nothing); the dashboard disables scrubbing and the bubble
  // is a plain "press to go back to the previous page" button.
  const scrubState = useRef({ currentIndex, noteCount, scrubWidth, onDashboard });
  scrubState.current = { currentIndex, noteCount, scrubWidth, onDashboard };

  // The tick body, reassigned each render so it always sees the latest onScrub.
  const tickRef = useRef(() => {});
  tickRef.current = () => {
    const now = Date.now();
    // Cap dt so a dropped frame (or backgrounding) can't jump many pages at once.
    const dt = Math.min(0.05, (now - lastTsRef.current) / 1000);
    lastTsRef.current = now;
    const total = scrubState.current.noteCount;
    if (total > 1 && rateRef.current !== 0) {
      accRef.current += rateRef.current * dt;
      if (Math.abs(accRef.current) >= 1) {
        const step = Math.trunc(accRef.current);
        accRef.current -= step;
        const idx = wrapIndex(scrubIndexRef.current + step, total);
        if (idx !== scrubIndexRef.current) {
          scrubIndexRef.current = idx;
          steppedRef.current = true;
          onScrub(idx);
        }
      }
    }
    rafRef.current = requestAnimationFrame(() => tickRef.current());
  };

  const stopTicker = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    rateRef.current = 0;
  };

  // Stop the loop if we unmount mid-scrub.
  useEffect(() => stopTicker, []);

  // Gesture-callback bodies are held in refs and reassigned each render (below)
  // so they always see the latest onScrub/onPressProgress while the gesture
  // itself stays memoised. The ref *objects* must exist before the gesture is
  // built: react-native-gesture-handler snapshots the identifiers a callback
  // closes over when the Gesture is constructed, so a ref declared after the
  // useMemo would be captured as undefined (and blow up inside onFinalize).
  const settleBackRef = useRef(() => {});
  const endGestureRef = useRef((_dx: number, _dy: number) => {});

  // The bubble sits over the note pager, whose active page is a full-screen
  // WebView (the CM6 editor). On Android react-native-webview disrupts the
  // legacy JS responder system, so a PanResponder here stops receiving move
  // events over a note — the scrub silently dies. react-native-gesture-handler
  // uses native gesture recognizers that coordinate correctly over the WebView
  // (the same reason the dashboard's card drag uses it), so the scrub works on
  // every page. runOnJS(true) keeps the callbacks on the JS thread so they can
  // drive the RN Animated values, the rAF ticker, and setState directly.
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .maxPointers(1)
        .onBegin(() => {
          if (scrubState.current.noteCount <= 0) return;
          // On the dashboard the bubble is a plain "back" button — no scrub, so
          // skip the lift + shuttle entirely and let the release do the routing.
          if (scrubState.current.onDashboard) {
            setPressed(true);
            return;
          }
          const { currentIndex: idx, noteCount: total } = scrubState.current;
          scrubIndexRef.current = clamp(idx, 0, Math.max(0, total - 1));
          accRef.current = 0;
          rateRef.current = 0;
          steppedRef.current = false;
          lastTsRef.current = Date.now();
          // Scrubbing pages under an open keyboard looks jittery; tuck it away.
          Keyboard.dismiss();
          setScrubbing(true);
          Animated.spring(lift, {
            toValue: 1,
            useNativeDriver: true,
            speed: 20,
            bounciness: 8,
          }).start();
          if (rafRef.current === null) {
            rafRef.current = requestAnimationFrame(() => tickRef.current());
          }
        })
        .onUpdate(e => {
          if (scrubState.current.noteCount <= 0) return;
          // No scrubbing on the dashboard — the bubble is just a button there.
          if (scrubState.current.onDashboard) return;
          // Drag only steers the shuttle: displacement from the press point sets
          // how fast and which way pages advance. The ticker does the stepping,
          // so holding at the left/right of the screen keeps paging.
          rateRef.current = pagesPerSecond(e.translationX, scrubState.current.scrubWidth);
          panX.setValue(clamp(e.translationX, -FOLLOW_LIMIT, FOLLOW_LIMIT));
        })
        // onFinalize fires whether or not the pan ever activated (a stationary
        // tap included) and whether it ended cleanly or was cancelled, so it is
        // the single place we settle the bubble and route a dashboard tap.
        .onFinalize(e => {
          if (scrubState.current.noteCount <= 0) return;
          endGestureRef.current(e.translationX, e.translationY);
        }),
    // The handlers reach onScrub/onPressProgress through refs reassigned each
    // render, so only the Animated values closed over here are real deps.
    [lift, panX],
  );

  // Stop paging and drop the bubble back to its origin. Held in a ref so the
  // memoised gesture can call it without re-creating on every render.
  settleBackRef.current = () => {
    stopTicker();
    Animated.spring(lift, {
      toValue: 0,
      useNativeDriver: true,
      speed: 18,
      bounciness: 6,
    }).start(() => setScrubbing(false));
    Animated.spring(panX, {
      toValue: 0,
      useNativeDriver: true,
      speed: 18,
      bounciness: 6,
    }).start();
  };
  function settleBack() {
    settleBackRef.current();
  }

  // End the gesture. On the dashboard the bubble is a back button: a press that
  // didn't drag off the bubble routes to the previous page. On a note it's a
  // scrubber: just drop the bubble home — tapping to route is disabled there.
  // Reassigned each render (via a ref) so it always sees the latest
  // onPressProgress, letting the memoised gesture stay stable across renders.
  endGestureRef.current = (dx: number, dy: number) => {
    if (scrubState.current.onDashboard) {
      setPressed(false);
      const isPress = Math.abs(dx) < SCRUB_DEAD_ZONE && Math.abs(dy) < SCRUB_DEAD_ZONE;
      if (isPress) onPressProgress();
      return;
    }
    // On a note the bubble is a page scrubber. A slow park-and-hold lets the
    // shuttle page (steppedRef set); but a quick drag-and-release integrates to
    // less than one page and would otherwise move nothing. Treat such a decisive
    // horizontal swipe as a single page step in the drag direction (right =
    // forward, matching the shuttle and the fill bar advancing rightward), so
    // flicking the bar always indexes through the pages.
    const total = scrubState.current.noteCount;
    const swiped = Math.abs(dx) > SCRUB_DEAD_ZONE && Math.abs(dx) > Math.abs(dy);
    if (!steppedRef.current && swiped && total > 1) {
      const next = wrapIndex(scrubIndexRef.current + Math.sign(dx), total);
      if (next !== scrubIndexRef.current) {
        scrubIndexRef.current = next;
        onScrub(next);
      }
    }
    settleBack();
  };

  // Recording mode unmounts the scrub bubble below. If a scrub were in flight as
  // the mic went live (e.g. the recognizer hard-stops the session from an error
  // mid-drag), its rAF shuttle would keep paging with no bubble left to release it
  // — so settle the gesture as the swap happens.
  useEffect(() => {
    if (dictating) settleBackRef.current();
  }, [dictating]);

  const translateY = lift.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -LIFT_DISTANCE],
  });
  const scale = lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });

  return (
    <View className="flex-row items-center justify-center gap-3 py-3">
      {dictating ? (
        /* Recording mode: the scrub + dashboard bubbles are replaced by the two
           editing controls, so a character can be dropped or a line broken without
           pausing dictation. Each takes the exact measured width of the bubble it
           stands in for (Delete ← scrub, New line ← Dashboard) on top of the same
           h-9 pill styling, so the strip is pixel-identical either side of the swap
           — nothing shifts as the mic goes on and off. Content is centered because
           these widths come from the other bubbles rather than from this content.
           Width falls back to intrinsic until the first measurement lands. */
        <>
          <Pressable
            onPress={onBackspace}
            accessibilityRole="button"
            accessibilityLabel="Delete previous character"
            hitSlop={8}
            style={navWidths.gesture ? { width: navWidths.gesture } : undefined}
            className="h-9 flex-row items-center justify-center rounded-full bg-surface px-4 active:opacity-70">
            <Delete size={16} strokeWidth={2.5} color={colors.faint} />
            <Text numberOfLines={1} className="ml-2 shrink text-xs font-semibold text-faint">
              Delete
            </Text>
          </Pressable>

          <Pressable
            onPress={onNewline}
            accessibilityRole="button"
            accessibilityLabel="Insert new line"
            hitSlop={8}
            style={navWidths.dashboard ? { width: navWidths.dashboard } : undefined}
            className="h-9 flex-row items-center justify-center rounded-full bg-surface px-4 active:opacity-70">
            <CornerDownLeft size={16} strokeWidth={2.5} color={colors.faint} />
            <Text numberOfLines={1} className="ml-2 shrink text-xs font-semibold text-faint">
              New line
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          {/* Progress bubble — active on a note page, and a page scrubber when held.
              The Animated wrapper carries the pop-up transform + gesture; the inner
              View keeps the bubble's visual styling. */}
          <GestureDetector gesture={panGesture}>
            <Animated.View
              accessibilityRole="button"
              accessibilityLabel={
                onDashboard
                  ? 'Go to previous page'
                  : 'Hold and slide to scrub through pages'
              }
              style={[
                styles.scrubWrapper,
                scrubbing && styles.scrubWrapperActive,
                { transform: [{ translateX: panX }, { translateY }, { scale }] },
              ]}>
              <View
                onLayout={e => measureNav('gesture', e.nativeEvent.layout.width)}
                className={
                  'h-9 flex-row items-center rounded-full bg-surface px-4' +
                  (onDashboard && pressed ? ' opacity-70' : '')
                }>
                <View className="h-1.5 w-16 overflow-hidden rounded-full bg-background">
                  <View
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${progress * 100}%` }}
                  />
                </View>
                <Text className="ml-3 text-xs font-semibold text-muted">
                  {notePosition} / {noteCount}
                </Text>
              </View>
            </Animated.View>
          </GestureDetector>

          {/* Dashboard bubble — jumps to the trailing dashboard page; active there.
              The 2×2 grid glyph is drawn from four small squares (no icon dep). */}
          <Pressable
            onPress={onPressDashboard}
            onLayout={e => measureNav('dashboard', e.nativeEvent.layout.width)}
            accessibilityRole="button"
            accessibilityLabel="Open dashboard"
            hitSlop={8}
            className={
              onDashboard
                ? 'h-9 flex-row items-center rounded-full bg-accent px-4 active:opacity-70'
                : 'h-9 flex-row items-center rounded-full bg-surface px-4 active:opacity-70'
            }>
            <View className="h-4 w-4 flex-row flex-wrap" style={styles.dashboardGrid}>
              {[0, 1, 2, 3].map(i => (
                <View
                  key={i}
                  className={onDashboard ? 'bg-background' : 'bg-faint'}
                  style={styles.dashboardGridCell}
                />
              ))}
            </View>
            <Text
              className={
                onDashboard
                  ? 'ml-2 text-xs font-semibold text-background'
                  : 'ml-2 text-xs font-semibold text-faint'
              }>
              Dashboard
            </Text>
          </Pressable>
        </>
      )}

      {/* Speech-to-text mic — starts/stops dictation into the active note. Sits
          next to the Dashboard bubble; disabled (dimmed, non-interactive) when
          there's no editable note to dictate into (the dashboard, or a read-only
          subject page). Accent-filled while live so it reads as "recording". */}
      <Pressable
        onPress={dictationDisabled ? undefined : onToggleDictation}
        disabled={dictationDisabled}
        accessibilityRole="button"
        accessibilityLabel={dictating ? 'Stop dictation' : 'Start dictation'}
        accessibilityState={{ disabled: dictationDisabled, selected: dictating }}
        hitSlop={8}
        className={
          'h-9 w-9 items-center justify-center rounded-full ' +
          (dictating ? 'bg-accent' : 'bg-surface') +
          (dictationDisabled ? ' opacity-40' : ' active:opacity-70')
        }>
        <Mic
          size={16}
          strokeWidth={2.5}
          color={dictating ? colors.background : colors.faint}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  scrubWrapper: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
  },
  // Only visible while held: lift the bubble above the strip and cast a shadow
  // so it reads as detached and draggable.
  scrubWrapperActive: {
    zIndex: 10,
    shadowOpacity: 0.22,
    elevation: 8,
  },
  // The dashboard bubble's 2×2 grid glyph, drawn from four small squares.
  dashboardGrid: { gap: 2 },
  dashboardGridCell: { width: 6, height: 6, borderRadius: 1.5 },
});

export default React.memo(PageIndicator);
