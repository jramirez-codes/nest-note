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
  // Direction of the in-progress drag: -1 flipping forward, +1 flipping back, 0
  // at rest. Only consulted when the pad has exactly two pages (both directions
  // wrap to the same neighbour) to decide which role that single sheet plays. It
  // re-renders only when the sign flips, not every frame.
  const [dragSign, setDragSign] = useState(0);
  const dragSignRef = useRef(0);
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

      if (total > 1 && commit && forward) {
        // Peel the current sheet fully off to the left, then advance — wrapping
        // from the last page round to the first.
        finish(-w, (index + 1) % total);
      } else if (total > 1 && commit && !forward) {
        // Slide the neighbouring sheet fully into place, then step back —
        // wrapping from the first page round to the last.
        finish(w, (index - 1 + total) % total);
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
          // With a single page there is nowhere to turn, so let the child keep
          // the touch (e.g. taps on the empty pad's "add a note" button). Real
          // taps never travel ACTIVATE_DISTANCE horizontally, so they are not
          // captured here even though both ends now wrap around.
          return stateRef.current.count > 1;
        },
        onPanResponderGrant: (_, g) => {
          // Hide the keyboard as soon as a page turn starts, rather than waiting
          // for the turn to commit (when the outgoing page blurs). Otherwise the
          // keyboard hovers over the whole swipe animation when flipping between
          // pages that have content and a focused editor.
          Keyboard.dismiss();
          const sign = g.dx < 0 ? -1 : g.dx > 0 ? 1 : 0;
          dragSignRef.current = sign;
          setDragSign(sign);
          setDragging(true);
        },
        onPanResponderMove: (_, g) => {
          const { width: w } = stateRef.current;
          // Track direction so the two-page case can pick the neighbour's role;
          // only re-render when the sign actually flips.
          const sign = g.dx < 0 ? -1 : g.dx > 0 ? 1 : 0;
          if (sign !== dragSignRef.current) {
            dragSignRef.current = sign;
            setDragSign(sign);
          }
          // Every page now has a neighbour on both sides (the ends wrap), so
          // there is no overscroll to rubber-band against.
          dragX.setValue(clamp(g.dx, -w, w));
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
  if (dragging && count > 1) {
    // Neighbours wrap: the page after the last is the first, and before the
    // first is the last, so a swipe at either end turns instead of overscrolls.
    const nextIndex = (currentIndex + 1) % count; // revealed when peeling left
    const prevIndex = (currentIndex - 1 + count) % count; // slides in from left
    if (nextIndex === prevIndex) {
      // Exactly two pages: the same sheet is both the next and the previous
      // page. Mount it once and choose its role from the drag direction, so the
      // one instance (and its editor) is reused if the drag reverses rather than
      // colliding on a duplicate React key. At rest it takes the under role,
      // where it is hidden beneath the current sheet anyway.
      const asPrev = dragSign > 0;
      layers.push({
        index: nextIndex,
        zIndex: asPrev ? 2 : 0,
        translateX: asPrev ? prevTranslate : staticZero,
        moving: asPrev,
      });
    } else {
      layers.push({ index: nextIndex, zIndex: 0, translateX: staticZero, moving: false });
      layers.push({ index: prevIndex, zIndex: 2, translateX: prevTranslate, moving: true });
    }
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
            // Mark the moving sheet's right edge so the sheet boundary is
            // visible as it slides. This is the current page's right edge when
            // it peels left to the next page, and the incoming previous page's
            // right edge as it slides in from the left when flipping back. The
            // static sheet underneath (moving=false) never gets the edge, and an
            // off-screen previous sheet keeps its border off-screen at -width.
            layer.moving && styles.draggingEdge,
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
