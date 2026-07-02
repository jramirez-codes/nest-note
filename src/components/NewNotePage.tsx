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
    <View
      style={{ width }}
      className="flex-1 items-center justify-center bg-background">
      <Pressable
        onPress={onCreate}
        // The button sits on a sheet that is absolutely positioned and carries
        // an animated translateX transform; on Android that makes the press
        // region RN measures unreliable, so a plain tap can be classed as
        // "moved outside" and cancelled before onPress fires. A generous
        // retention offset keeps the press alive through that mismeasurement
        // without enlarging where a tap may start (that stays the button below).
        pressRetentionOffset={{ top: 2000, bottom: 2000, left: 2000, right: 2000 }}
        hitSlop={16}
        accessibilityRole="button"
        accessibilityLabel="Add a new note"
        className="items-center active:opacity-60">
        <View className="h-20 w-20 items-center justify-center rounded-full border-2 border-dashed border-accent">
          <Text className="text-4xl leading-none text-accent">+</Text>
        </View>
        <Text className="mt-5 text-base font-medium text-muted">
          Tap to add a note
        </Text>
      </Pressable>
    </View>
  );
}

export default React.memo(NewNotePage);
