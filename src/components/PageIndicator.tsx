import React from 'react';
import { Text, View } from 'react-native';

interface PageIndicatorProps {
  currentIndex: number;
  totalPages: number;
}

/** Show dots for a small pad; fall back to "n / total" once it gets long. */
const MAX_DOTS = 8;

/**
 * Bottom-of-screen progress indicator for the pager. Purely presentational.
 */
function PageIndicator({ currentIndex, totalPages }: PageIndicatorProps) {
  if (totalPages > MAX_DOTS) {
    return (
      <View className="items-center py-3">
        <Text className="text-xs font-semibold text-stone-400 dark:text-stone-500">
          {currentIndex + 1} / {totalPages}
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-row items-center justify-center py-3">
      {Array.from({ length: totalPages }).map((_, index) => {
        const isActive = index === currentIndex;
        return (
          <View
            key={index}
            className={
              isActive
                ? 'mx-1 h-2 w-5 rounded-full bg-amber-600 dark:bg-amber-400'
                : 'mx-1 h-2 w-2 rounded-full bg-stone-300 dark:bg-stone-700'
            }
          />
        );
      })}
    </View>
  );
}

export default React.memo(PageIndicator);
