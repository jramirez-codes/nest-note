/**
 * The Suggestions section: the yes/no merge prompts `/ingest` raises (merge these
 * subjects into one?). Sandbox-only. Each is a small card with Dismiss / Merge
 * buttons that call back into the dashboard's action layer.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { GitMerge } from 'lucide-react-native';
import type { ThemeColors } from '../../../theme/colors';
import type { DashboardSuggestion } from '../../../server/controllers/aiController';
import { SectionHeader } from '../DashboardCards';

function SuggestionsSection({
  suggestions,
  busy,
  act,
  colors,
}: {
  suggestions: DashboardSuggestion[];
  busy: Record<string, boolean>;
  act: (s: DashboardSuggestion, action: 'merge' | 'dismiss') => void;
  colors: ThemeColors;
}) {
  return (
    <View className="mb-6">
      <SectionHeader icon={GitMerge} title="Suggestions" colors={colors} />
      {suggestions.map(s => (
        <View key={s.into} className="mb-2 rounded-2xl border border-surface1 bg-surface p-3">
          <Text className="text-sm text-text">
            Merge <Text className="font-semibold text-text">{s.from.join(', ')}</Text> into{' '}
            <Text className="font-semibold text-text">{s.into}</Text>?
          </Text>
          {!!s.reason && <Text className="mt-1 text-xs text-muted">{s.reason}</Text>}
          <View className="mt-3 flex-row justify-end gap-2">
            <Pressable
              disabled={busy[s.into]}
              onPress={() => act(s, 'dismiss')}
              className="rounded-lg bg-background px-4 py-2 active:opacity-70">
              <Text className="text-sm font-semibold text-muted">Dismiss</Text>
            </Pressable>
            <Pressable
              disabled={busy[s.into]}
              onPress={() => act(s, 'merge')}
              className="rounded-lg bg-accent px-4 py-2 active:opacity-70">
              <Text className="text-sm font-semibold text-background">Merge</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}

export default React.memo(SuggestionsSection);
