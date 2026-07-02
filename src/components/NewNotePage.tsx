import React from 'react';
import { Pressable, Text, View } from 'react-native';

interface NewNotePageProps {
  width: number;
  onCreate: () => void;
}

/**
 * The trailing page of the pad. Tapping it appends a fresh note and flips to
 * it, so there is always one "blank sheet" waiting at the end.
 */
function NewNotePage({ width, onCreate }: NewNotePageProps) {
  return (
    <View style={{ width }} className="flex-1 bg-amber-50 dark:bg-stone-950">
      <Pressable
        onPress={onCreate}
        accessibilityRole="button"
        accessibilityLabel="Add a new note"
        className="flex-1 items-center justify-center active:opacity-60">
        <View className="h-20 w-20 items-center justify-center rounded-full border-2 border-dashed border-amber-500 dark:border-amber-400">
          <Text className="text-4xl leading-none text-amber-600 dark:text-amber-400">
            +
          </Text>
        </View>
        <Text className="mt-5 text-base font-medium text-stone-500 dark:text-stone-400">
          Tap to add a note
        </Text>
      </Pressable>
    </View>
  );
}

export default React.memo(NewNotePage);
