import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  type GestureResponderEvent,
  Keyboard,
  PanResponder,
  type PanResponderGestureState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

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
 */
function PageIndicator({
  currentIndex,
  prevIndex,
  noteCount,
  onPressDashboard,
  onPressProgress,
  scrubWidth,
  onScrub,
}: PageIndicatorProps) {
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

  // Shuttle state. The gesture only sets a paging *rate*; a requestAnimationFrame
  // loop integrates that rate over time and steps the page index, so parking a
  // finger at the edge keeps paging without any further movement.
  const rateRef = useRef(0); // pages per second, sign = direction
  const accRef = useRef(0); // fractional pages accumulated since the last step
  const scrubIndexRef = useRef(0); // integer note index currently shown
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);

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

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => scrubState.current.noteCount > 0,
        onMoveShouldSetPanResponder: () => scrubState.current.noteCount > 0,
        onPanResponderGrant: () => {
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
        },
        onPanResponderMove: (_, g) => {
          // No scrubbing on the dashboard — the bubble is just a button there.
          if (scrubState.current.onDashboard) return;
          // Drag only steers the shuttle: displacement from the press point sets
          // how fast and which way pages advance. The ticker does the stepping,
          // so holding at the left/right of the screen keeps paging.
          rateRef.current = pagesPerSecond(g.dx, scrubState.current.scrubWidth);
          panX.setValue(clamp(g.dx, -FOLLOW_LIMIT, FOLLOW_LIMIT));
        },
        // Both the normal lift-of-finger (Release) and a forced hand-off
        // (Terminate) end the gesture. A quick tap on Android frequently comes
        // through as Terminate, not Release, so we treat both the same.
        onPanResponderRelease: endGesture,
        onPanResponderTerminate: endGesture,
        onPanResponderTerminationRequest: () => false,
      }),
    // endGesture is a hoisted declaration delegating to a ref, and onScrub is
    // reached through tickRef (reassigned each render), so neither belongs here;
    // lift/panX are the only reactive values closed over.
    [lift, panX],
  );

  // Stop paging and drop the bubble back to its origin. Held in a ref so the
  // memoised responder can call it without re-creating on every render.
  const settleBackRef = useRef(() => {});
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
  // onPressProgress, letting `endGesture` stay stable for the memoised responder.
  const endGestureRef = useRef((_g: PanResponderGestureState) => {});
  endGestureRef.current = (g: PanResponderGestureState) => {
    if (scrubState.current.onDashboard) {
      setPressed(false);
      const isPress =
        Math.abs(g.dx) < SCRUB_DEAD_ZONE && Math.abs(g.dy) < SCRUB_DEAD_ZONE;
      if (isPress) onPressProgress();
      return;
    }
    settleBack();
  };
  function endGesture(_e: GestureResponderEvent, g: PanResponderGestureState) {
    endGestureRef.current(g);
  }

  const translateY = lift.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -LIFT_DISTANCE],
  });
  const scale = lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });

  return (
    <View className="flex-row items-center justify-center gap-3 py-3">
      {/* Progress bubble — active on a note page, and a page scrubber when held.
          The Animated wrapper carries the pop-up transform + gesture; the inner
          View keeps the bubble's visual styling. */}
      <Animated.View
        {...panResponder.panHandlers}
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

      {/* Dashboard bubble — jumps to the trailing dashboard page; active there.
          The 2×2 grid glyph is drawn from four small squares (no icon dep). */}
      <Pressable
        onPress={onPressDashboard}
        accessibilityRole="button"
        accessibilityLabel="Open dashboard"
        hitSlop={8}
        className={
          onDashboard
            ? 'h-9 flex-row items-center rounded-full bg-accent px-4 active:opacity-70'
            : 'h-9 flex-row items-center rounded-full bg-surface px-4 active:opacity-70'
        }>
        <View className="h-4 w-4 flex-row flex-wrap" style={{ gap: 2 }}>
          {[0, 1, 2, 3].map(i => (
            <View
              key={i}
              className={onDashboard ? 'bg-background' : 'bg-faint'}
              style={{ width: 6, height: 6, borderRadius: 1.5 }}
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
});

export default React.memo(PageIndicator);
