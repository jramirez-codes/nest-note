import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';
import type { PanResponderGestureState } from 'react-native';

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
  renderPage: (index: number) => React.ReactNode;
  onIndexChange?: (index: number) => void;
}

/** Fraction of the page a swipe must cross (or velocity must exceed) to turn. */
const TURN_THRESHOLD = 0.28;
const FLING_VELOCITY = 0.3;
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
 * Built on the RN built-in PanResponder + Animated (native-driven translateX)
 * so it needs no extra native dependencies.
 */
function PaperPager(
  { count, width, keyForIndex, renderPage, onIndexChange }: PaperPagerProps,
  ref: React.Ref<PaperPagerHandle>,
) {
  const [currentIndex, setCurrentIndex] = useState(0);
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
          useNativeDriver: true,
        }).start(() => {
          if (nextIndex !== null) {
            dragX.setValue(0);
            goToIndex(nextIndex);
          }
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
          useNativeDriver: true,
          bounciness: 0,
          speed: 14,
        }).start();
      }
    },
    [dragX, goToIndex],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
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
        onPanResponderTerminationRequest: () => false,
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
  const layers: Array<{
    index: number;
    zIndex: number;
    translateX: Animated.Value | Animated.AnimatedInterpolation<number>;
    moving: boolean;
  }> = [];
  if (currentIndex + 1 < count) {
    layers.push({ index: currentIndex + 1, zIndex: 0, translateX: staticZero, moving: false });
  }
  layers.push({ index: currentIndex, zIndex: 1, translateX: currentTranslate, moving: true });
  if (currentIndex - 1 >= 0) {
    layers.push({ index: currentIndex - 1, zIndex: 2, translateX: prevTranslate, moving: true });
  }

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      {layers.map(layer => (
        <Animated.View
          key={keyForIndex(layer.index)}
          style={[
            styles.sheet,
            { zIndex: layer.zIndex, transform: [{ translateX: layer.translateX }] },
            layer.moving && styles.movingSheet,
          ]}>
          {renderPage(layer.index)}
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
});

export default forwardRef(PaperPager);
