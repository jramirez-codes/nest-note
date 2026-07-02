import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Animated, Keyboard, PanResponder, StyleSheet, View } from 'react-native';
import type { PanResponderGestureState } from 'react-native';
import { theme } from '../theme/colors';

// A shared frozen "0" translate for the static sheet sitting underneath.
const staticZero = new Animated.Value(0);

export interface PaperPagerHandle {
  /** Jump straight to a page (used after creating a note). */
  flipTo: (index: number) => void;
}

interface PaperPagerProps {
  /** Total number of pages. */
  count: number;
  /** Exact page width so the sheet slides fully off screen. */
  width: number;
  /** Stable key per page index so React reuses instances as pages change role. */
  keyForIndex: (index: number) => string;
  renderPage: (index: number, isActive: boolean) => React.ReactNode;
  onIndexChange?: (index: number) => void;
}

/** Fraction of the page a swipe must cross (or velocity must exceed) to turn. */
const TURN_THRESHOLD = 0.55;
const FLING_VELOCITY = 0.9;
/** Horizontal distance (px) before a drag is treated as a page swipe. */
const ACTIVATE_DISTANCE = 36;
/** How much more horizontal than vertical a drag must be to count as a swipe. */
const HORIZONTAL_BIAS = 2.5;
/** Rubber-banding when swiping past the first / last page. */
const OVERSCROLL_RESIST = 0.28;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * A page pager with a "sheet of paper" feel: pages are stacked rather than laid
 * side by side. The current page rests on top; the next page sits underneath.
 * Swiping left peels the top sheet away to reveal the page beneath it; swiping
 * right slides the previous sheet back in from the left over the current one.
 *
 * Built on the RN built-in PanResponder + Animated (JS-driven translateX, to
 * stay in sync with the `setValue` drag) so it needs no extra native
 * dependencies.
 */
function PaperPager(
  { count, width, keyForIndex, renderPage, onIndexChange }: PaperPagerProps,
  ref: React.Ref<PaperPagerHandle>,
) {
  const [currentIndex, setCurrentIndex] = useState(0);
  // True while a swipe is in progress, so we can show the page's moving edge.
  const [dragging, setDragging] = useState(false);
  const dragX = useRef(new Animated.Value(0)).current;

  // Latest values for the pan handlers, which close over a stable callback.
  const stateRef = useRef({ currentIndex, count, width });
  stateRef.current = { currentIndex, count, width };

  const goToIndex = useCallback(
    (index: number) => {
      setCurrentIndex(index);
      onIndexChange?.(index);
    },
    [onIndexChange],
  );

  useImperativeHandle(
    ref,
    () => ({
      flipTo: (index: number) => {
        dragX.setValue(0);
        goToIndex(clamp(index, 0, Math.max(0, stateRef.current.count - 1)));
      },
    }),
    [dragX, goToIndex],
  );

  // Keep the active page in range if pages were removed beneath us.
  const lastIndex = Math.max(0, count - 1);
  useEffect(() => {
    if (currentIndex > lastIndex) {
      dragX.setValue(0);
      goToIndex(lastIndex);
    }
  }, [currentIndex, lastIndex, dragX, goToIndex]);

  // Recenter dragX once a turn settles. This is deliberately NOT done inside the
  // animation's completion callback: a synchronous setValue(0) there fires
  // before React swaps the index, snapping the still-mounted outgoing sheet back
  // to the origin for a frame (the "content snaps to origin then the next page
  // renders" flicker). By the time `dragging` is false the resting sheet uses a
  // static 0 transform (see the layers below), so nothing is bound to dragX and
  // the reset is invisible.
  useEffect(() => {
    if (!dragging) dragX.setValue(0);
  }, [dragging, dragX]);

  const settle = useCallback(
    (g: PanResponderGestureState) => {
      const { currentIndex: index, count: total, width: w } = stateRef.current;
      const forward = g.dx < 0;
      const passedThreshold = Math.abs(g.dx) > w * TURN_THRESHOLD;
      const flung = Math.abs(g.vx) > FLING_VELOCITY;
      const commit = passedThreshold || flung;

      const finish = (toValue: number, nextIndex: number | null) => {
        Animated.timing(dragX, {
          toValue,
          duration: 220,
          // JS thread to match the `setValue` used while dragging (a native
          // driver would re-read dragX's stale native value and snap first).
          useNativeDriver: false,
        }).start(() => {
          // Promote the revealed neighbour to the current page. Its resting
          // transform is a static 0 (independent of dragX), so this swap is
          // pixel-identical to the final animation frame — no snap. dragX is
          // recentred separately once `dragging` clears, when nothing reads it.
          if (nextIndex !== null) {
            goToIndex(nextIndex);
          }
          setDragging(false);
        });
      };

      if (forward && commit && index < total - 1) {
        // Peel the current sheet fully off to the left, then advance.
        finish(-w, index + 1);
      } else if (!forward && commit && index > 0) {
        // Slide the previous sheet fully into place, then step back.
        finish(w, index - 1);
      } else {
        // Not enough: spring the sheet back to rest.
        Animated.spring(dragX, {
          toValue: 0,
          // Same reason as the commit animation above: stay on the JS thread so
          // the spring-back continues from the dragged position without snapping.
          useNativeDriver: false,
          bounciness: 0,
          speed: 14,
        }).start(() => setDragging(false));
      }
    },
    [dragX, goToIndex],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => {
          const horizontal =
            Math.abs(g.dx) > ACTIVATE_DISTANCE &&
            Math.abs(g.dx) > Math.abs(g.dy) * HORIZONTAL_BIAS;
          if (!horizontal) return false;
          // Don't hijack a gesture at the ends, where there's no page to turn
          // to — otherwise a tap with a little horizontal drift on the last
          // (new-note) page is swallowed as an overscroll swipe and the button
          // beneath us never fires. Let the child keep the touch instead.
          const { currentIndex: index, count: total } = stateRef.current;
          if (g.dx < 0 && index >= total - 1) return false;
          if (g.dx > 0 && index <= 0) return false;
          return true;
        },
        onPanResponderGrant: () => {
          // Hide the keyboard as soon as a page turn starts, rather than waiting
          // for the turn to commit (when the outgoing page blurs). Otherwise the
          // keyboard hovers over the whole swipe animation when flipping between
          // pages that have content and a focused editor.
          Keyboard.dismiss();
          setDragging(true);
        },
        onPanResponderMove: (_, g) => {
          const { currentIndex: index, count: total, width: w } =
            stateRef.current;
          let x = g.dx;
          // Rubber-band at the ends where there is no page to reveal.
          if (x < 0 && index >= total - 1) x *= OVERSCROLL_RESIST;
          if (x > 0 && index <= 0) x *= OVERSCROLL_RESIST;
          dragX.setValue(clamp(x, -w, w));
        },
        onPanResponderRelease: (_, g) => settle(g),
        onPanResponderTerminate: (_, g) => settle(g),
        // Let a child (e.g. a scrolling note) reclaim the touch instead of the
        // pager hard-locking every gesture the moment it starts tracking.
        onPanResponderTerminationRequest: () => true,
      }),
    [dragX, settle],
  );

  // The current sheet only ever slides left (min(0, dragX)); the previous sheet
  // starts off screen left and slides in as dragX goes positive.
  const currentTranslate = dragX.interpolate({
    inputRange: [-width, 0, width],
    outputRange: [-width, 0, 0],
    extrapolate: 'clamp',
  });
  const prevTranslate = dragX.interpolate({
    inputRange: [-width, 0, width],
    outputRange: [-width, -width, 0],
    extrapolate: 'clamp',
  });

  // Three roles relative to the current page. Keyed by content so React keeps
  // each page's instance (and editor state) as it shifts roles across turns.
  //
  // The neighbouring sheets are only mounted while a turn is in progress. At
  // rest the current page fully covers them, so they add nothing visually — but
  // a translated-away sheet still hit-tests in its original full-screen bounds
  // on Android, swallowing taps meant for the page on top (e.g. the "add a
  // note" button). Rendering only the current page at rest keeps taps clean.
  const layers: Array<{
    index: number;
    zIndex: number;
    translateX: Animated.Value | Animated.AnimatedInterpolation<number> | number;
    moving: boolean;
  }> = [];
  if (dragging && currentIndex + 1 < count) {
    layers.push({ index: currentIndex + 1, zIndex: 0, translateX: staticZero, moving: false });
  }
  // At rest the current sheet sits at a plain 0 that does NOT track dragX, so
  // recentring dragX after a turn can't move it. It only follows the drag (via
  // currentTranslate) while a gesture/animation is in flight.
  layers.push({
    index: currentIndex,
    zIndex: 1,
    translateX: dragging ? currentTranslate : 0,
    moving: dragging,
  });
  if (dragging && currentIndex - 1 >= 0) {
    layers.push({ index: currentIndex - 1, zIndex: 2, translateX: prevTranslate, moving: true });
  }

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      {layers.map(layer => (
        <Animated.View
          key={keyForIndex(layer.index)}
          // Only the visible top page is interactive. The underneath sheet and
          // the off-screen previous sheet must not swallow touches: their full
          // layout bounds still hit-test on Android even when translated away,
          // which would otherwise block taps (e.g. the "add a note" button).
          pointerEvents={layer.index === currentIndex ? 'auto' : 'none'}
          style={[
            styles.sheet,
            { zIndex: layer.zIndex, transform: [{ translateX: layer.translateX }] },
            layer.moving && styles.movingSheet,
            // While swiping, mark the current page's right edge so you can see
            // where the sheet boundary is as it peels away.
            dragging && layer.index === currentIndex && styles.draggingEdge,
          ]}>
          {renderPage(layer.index, layer.index === currentIndex)}
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  sheet: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // A soft edge shadow so a sheet reads as lifting off the page beneath it.
  movingSheet: {
    shadowColor: '#000',
    shadowOffset: { width: -3, height: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 6,
  },
  // A line down the right edge of the page while it's being swiped.
  draggingEdge: {
    borderRightWidth: StyleSheet.hairlineWidth * 2,
    borderRightColor: theme.border,
  },
});

export default forwardRef(PaperPager);
