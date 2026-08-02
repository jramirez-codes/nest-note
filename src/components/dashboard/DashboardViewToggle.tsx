/**
 * The dashboard's view toggle: a two-bubble segmented control that picks which
 * half of the dashboard is on screen. It lives in the pad header (where the
 * greeting used to be) rather than on the page itself, so it stays put while the
 * dashboard scrolls beneath it — and so the page's own content starts at the top.
 *
 * The two halves are deliberately about different jobs: Organize is the inbox you
 * work through (tasks, the archive, and the merge/reorg decisions), Ideas is the
 * material you read and grow (idea cards and the build steps they spawn).
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Lightbulb, ListChecks, type LucideIcon } from 'lucide-react-native';
import type { ThemeColors } from '../../theme/colors';

/** Which half of the dashboard is showing. 'organize' is the default. */
export type DashboardView = 'organize' | 'ideas';

const VIEWS: { key: DashboardView; label: string; icon: LucideIcon }[] = [
  { key: 'organize', label: 'Organize', icon: ListChecks },
  { key: 'ideas', label: 'Ideas', icon: Lightbulb },
];

function DashboardViewToggle({
  view,
  onChange,
  colors,
}: {
  view: DashboardView;
  onChange: (view: DashboardView) => void;
  colors: ThemeColors;
}) {
  return (
    <View
      accessibilityRole="tablist"
      className="flex-row items-center rounded-full border border-surface1 bg-surface p-0.5">
      {VIEWS.map(v => {
        const active = v.key === view;
        const Icon = v.icon;
        return (
          <Pressable
            key={v.key}
            onPress={() => onChange(v.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${v.label} view`}
            className={`flex-row items-center gap-1.5 rounded-full px-3 py-1 active:opacity-80 ${
              active ? 'bg-accent/20' : ''
            }`}>
            <Icon
              size={12}
              color={active ? colors.accent : colors.faint}
              strokeWidth={2.25}
            />
            <Text
              className={`text-xs font-semibold ${active ? 'text-accent' : 'text-muted'}`}>
              {v.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default React.memo(DashboardViewToggle);
