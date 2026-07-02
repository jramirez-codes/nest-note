import React from 'react';
import { Pressable, Text, View } from 'react-native';

interface PageIndicatorProps {
  /** Zero-based index of the active page, spanning notes then the new-note sheet. */
  currentIndex: number;
  /** How many real notes exist; the new-note sheet sits at index `noteCount`. */
  noteCount: number;
  /** Jump to the trailing "tap to add a note" page. */
  onPressNew: () => void;
}

/**
 * Bottom-of-screen navigation for the pad, rendered as two bubbles:
 *   - left  — a progress bubble showing how far through the pad you are
 *             (a fill bar + "n / total"); active while you're on a note.
 *   - right — the "new note" bubble; active while you're on the trailing sheet.
 *
 * Built for hundreds of pages: the left bubble is a continuous progress bar
 * rather than one-dot-per-page. Purely presentational.
 */
function PageIndicator({
  currentIndex,
  noteCount,
  onPressNew,
}: PageIndicatorProps) {
  const onNewPage = currentIndex >= noteCount;
  // Which note we're on (1-based), clamped so the trailing sheet reads as the
  // last note rather than overrunning the count.
  const notePosition = Math.min(currentIndex + 1, noteCount);
  // Fraction of the pad covered. Guard the empty pad (only the new-note sheet).
  const progress = noteCount > 0 ? notePosition / noteCount : 0;

  return (
    <View className="flex-row items-center justify-center gap-3 py-3">
      {/* Progress bubble — active on a note page. */}
      <View
        className={
          onNewPage
            ? 'h-9 flex-row items-center rounded-full bg-surface px-4 opacity-40'
            : 'h-9 flex-row items-center rounded-full bg-surface px-4'
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

      {/* New-note bubble — jumps to the trailing create page; active there. */}
      <Pressable
        onPress={onPressNew}
        accessibilityRole="button"
        accessibilityLabel="Go to add a new note"
        hitSlop={8}
        className={
          onNewPage
            ? 'h-9 flex-row items-center rounded-full bg-accent px-4 active:opacity-70'
            : 'h-9 flex-row items-center rounded-full bg-surface px-4 active:opacity-70'
        }>
        <Text
          className={
            onNewPage
              ? 'text-base font-bold leading-none text-background'
              : 'text-base font-bold leading-none text-faint'
          }>
          +
        </Text>
        <Text
          className={
            onNewPage
              ? 'ml-1.5 text-xs font-semibold text-background'
              : 'ml-1.5 text-xs font-semibold text-faint'
          }>
          New
        </Text>
      </Pressable>
    </View>
  );
}

export default React.memo(PageIndicator);
