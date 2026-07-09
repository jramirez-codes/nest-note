import { useCallback, useMemo, useState } from 'react';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import type { DashboardCard } from '../server/aiController';

/**
 * The UI-thread values that drive the drag-to-delete interaction, written by the
 * card gesture (in the dashboard) and read by the header (which becomes the delete
 * target) and the floating clone. Kept in one place because the gesture, the drop
 * target, and the clone all live in different components across the pager.
 *
 * All coordinates are in window space so the gesture's absolute touch position and
 * the header's measured bounds can be compared directly.
 */
export interface CardDragShared {
  /** Current finger position (window coords). */
  dragX: SharedValue<number>;
  dragY: SharedValue<number>;
  /** 1 while a card is lifted, 0 otherwise. */
  active: SharedValue<number>;
  /** 1 while the finger is over the header/delete target. */
  overDelete: SharedValue<number>;
  /** The header's bottom edge (window Y); the finger is "over" at or above it. */
  headerBottomY: SharedValue<number>;
  /** The header bar's own height, so the delete banner can match it. */
  headerHeight: SharedValue<number>;
  /** Window origin of the screen root, to place the clone in local coords. */
  rootX: SharedValue<number>;
  rootY: SharedValue<number>;
}

export interface CardDrag {
  shared: CardDragShared;
  /** The lifted card (for the floating clone's content), or null when idle. */
  card: DashboardCard | null;
  /** Scheduled from the gesture when a drag begins. */
  lift: (card: DashboardCard) => void;
  /** Scheduled from the gesture when a drag ends (dropped or cancelled). */
  release: () => void;
}

/** Owns the drag-to-delete shared values and the lifted-card state. */
export function useCardDrag(): CardDrag {
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const active = useSharedValue(0);
  const overDelete = useSharedValue(0);
  const headerBottomY = useSharedValue(0);
  const headerHeight = useSharedValue(0);
  const rootX = useSharedValue(0);
  const rootY = useSharedValue(0);
  const [card, setCard] = useState<DashboardCard | null>(null);

  const lift = useCallback((c: DashboardCard) => setCard(c), []);
  const release = useCallback(() => setCard(null), []);

  // Memoized so its identity is stable across renders (the shared values it holds
  // already are), keeping the pager's renderPage stable when `card` changes.
  const shared = useMemo<CardDragShared>(
    () => ({ dragX, dragY, active, overDelete, headerBottomY, headerHeight, rootX, rootY }),
    [dragX, dragY, active, overDelete, headerBottomY, headerHeight, rootX, rootY],
  );

  return { shared, card, lift, release };
}
