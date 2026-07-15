/**
 * The dashboard's non-content states: the initial spinner, the fatal load error
 * (with a retry), a non-fatal inline error banner (shown above content when an
 * action fails), and the nothing-here-yet empty state. Pure views — the shell
 * decides which to show.
 */
import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Inbox } from 'lucide-react-native';
import type { ThemeColors } from '../../../theme/colors';

// The centered spinner shown on a cold load with nothing on screen yet.
export function LoadingState({ colors }: { colors: ThemeColors }) {
  return (
    <View className="items-center py-10">
      <ActivityIndicator color={colors.muted} />
    </View>
  );
}

// The fatal state: a load failed and there's no cached data to fall back on.
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View className="rounded-2xl border border-surface1 bg-surface p-4">
      <Text className="text-sm text-danger">{message}</Text>
      <Pressable
        onPress={onRetry}
        className="mt-3 self-start rounded-lg bg-background px-4 py-2 active:opacity-70">
        <Text className="text-sm font-semibold text-muted">Retry</Text>
      </Pressable>
    </View>
  );
}

// A non-fatal error banner shown above content once data is on screen (e.g. an
// action failed but the last-known cards are still valid).
export function InlineError({ message }: { message: string }) {
  return (
    <View className="mb-4 rounded-2xl border border-surface1 bg-surface p-3">
      <Text className="text-sm text-danger">{message}</Text>
    </View>
  );
}

// The empty state: connected fine, but nothing has been filed here yet.
export function EmptyState({ colors }: { colors: ThemeColors }) {
  return (
    <View className="items-center rounded-2xl border border-surface1 bg-surface px-6 py-10">
      <Inbox size={32} color={colors.faint} strokeWidth={1.75} />
      <Text className="mt-3 text-center text-sm text-muted">
        Nothing here yet. Write some notes, then run <Text className="text-text">/ingest</Text> to
        file tasks, reminders and subjects here.
      </Text>
    </View>
  );
}
