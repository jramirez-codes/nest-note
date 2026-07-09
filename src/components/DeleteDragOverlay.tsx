/**
 * The visual overlay for the dashboard's drag-to-delete gesture: the red "release
 * to delete" banner that covers the header, and the floating clone of the card
 * under the finger. Both are purely presentational — NotebookScreen owns the
 * shared values and computes the animated styles (they must live where the values
 * are), then hands the finished styles down here so the screen's render stays
 * focused on paging.
 */
import React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';
import { Trash2 } from 'lucide-react-native';
import { mocha } from '../theme/catppuccin';

// Priority → pip color for the floating drag clone (kept tiny to avoid importing
// the dashboard's full palette map).
const PIP_CLASS: Record<string, string> = {
  urgent: 'bg-red',
  high: 'bg-peach',
  normal: 'bg-blue',
  low: 'bg-overlay0',
};

export default function DeleteDragOverlay({
  bannerStyle,
  bannerLabelStyle,
  cloneStyle,
  card,
}: {
  bannerStyle: AnimatedStyle<ViewStyle>;
  bannerLabelStyle: AnimatedStyle<ViewStyle>;
  cloneStyle: AnimatedStyle<ViewStyle>;
  card: { priority: string; title: string } | null;
}) {
  return (
    <>
      {/* The red delete banner. Reaches the screen's top edge (through the
          status-bar / notch area) down to the header bar's bottom, fully covering
          the NoteHeader as the top chrome fades out — so the background→red
          transition is smooth. Touches fall through; the drop is detected by the
          card gesture, not this view. */}
      <Animated.View pointerEvents="none" style={[styles.deleteBanner, bannerStyle]}>
        <Animated.View style={[styles.deleteLabel, bannerLabelStyle]}>
          <Trash2 size={16} color={mocha.crust} strokeWidth={2.5} />
          <Text className="ml-2 text-xs font-bold uppercase tracking-wider text-crust">
            Release to delete
          </Text>
        </Animated.View>
      </Animated.View>

      {/* The floating clone of the card being dragged. Rendered last (top of the
          stack) so it travels over the header and footer; touches fall through. */}
      {card && (
        <Animated.View pointerEvents="none" style={[styles.clone, cloneStyle]}>
          <View className="flex-row items-center gap-2 rounded-2xl border border-surface1 bg-surface px-3 py-2">
            <View className={`h-2 w-2 rounded-full ${PIP_CLASS[card.priority] ?? 'bg-blue'}`} />
            <Text numberOfLines={1} className="max-w-[220px] text-sm font-semibold text-text">
              {card.title}
            </Text>
          </View>
        </Animated.View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // The drag clone floats above everything and is positioned by an animated
  // transform from window coordinates.
  clone: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 50,
    elevation: 8,
  },
  // The red delete banner. `top` and `height` come from the animated style; it
  // reaches the screen's top edge but is bottom-aligned (with padding matching the
  // header's) so the label sits in the header band rather than up in the notch.
  deleteBanner: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: mocha.red,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 12,
    zIndex: 45,
    elevation: 7,
  },
  deleteLabel: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
