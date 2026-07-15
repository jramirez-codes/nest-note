/**
 * The Reorganize section: the confirm prompts `/talk` raises when it wants to
 * restructure a notebook's pages (combine/split/delete/reorder pages, and drop items
 * the Task Log shows are already done). Shown in the Sandbox aggregate and inside the
 * affected notebook's own view. Each is a card with a page-count preview, a reassurance
 * that the Task Log is left untouched, and split Dismiss / Apply actions.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { ArrowRight, FileStack, ShieldCheck } from 'lucide-react-native';
import type { ThemeColors } from '../../../theme/colors';
import type { DashboardReorg } from '../../../server/controllers/aiController';
import { SectionHeader } from '../DashboardCards';

const plural = (n: number) => (n === 1 ? 'page' : 'pages');

function ReorgCard({
  reorg: r,
  busy,
  act,
  titleFor,
  colors,
}: {
  reorg: DashboardReorg;
  busy: boolean;
  act: (r: DashboardReorg, action: 'reorg' | 'reorg-dismiss') => void;
  titleFor: (subject: string) => string;
  colors: ThemeColors;
}) {
  return (
    <View className="mb-2 overflow-hidden rounded-2xl border border-surface1 bg-surface p-4">
      {/* Header: a tinted glyph avatar, the notebook name, and the one-line summary. */}
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-surface1">
          <FileStack size={18} color={colors.accent} strokeWidth={2} />
        </View>
        <View className="flex-1">
          <Text numberOfLines={1} className="text-[15px] font-semibold text-text">
            Reorganize {titleFor(r.subject)}
          </Text>
          <Text numberOfLines={2} className="text-xs leading-4 text-muted">
            {r.summary || 'Restructure this notebook’s pages'}
          </Text>
        </View>
      </View>

      {/* A page-count preview (now → after) with the Task-Log guarantee alongside. */}
      <View className="mt-3 flex-row items-center justify-between">
        <View className="flex-row items-center gap-2 rounded-xl bg-base px-3 py-2">
          <Text className="text-sm font-semibold text-muted">
            {r.from_pages} {plural(r.from_pages)}
          </Text>
          <ArrowRight size={14} color={colors.faint} strokeWidth={2.5} />
          <Text className="text-sm font-bold text-accent">
            {r.to_pages} {plural(r.to_pages)}
          </Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          <ShieldCheck size={13} color={colors.muted} strokeWidth={2.5} />
          <Text className="text-xs text-muted">Task Log kept</Text>
        </View>
      </View>

      {/* Split actions: a quiet Dismiss and a filled Apply. */}
      <View className={`mt-4 flex-row gap-2 ${busy ? 'opacity-50' : ''}`}>
        <Pressable
          disabled={busy}
          onPress={() => act(r, 'reorg-dismiss')}
          className="flex-1 items-center rounded-xl bg-surface1 py-2.5 active:opacity-70">
          <Text className="text-sm font-semibold text-muted">Dismiss</Text>
        </Pressable>
        <Pressable
          disabled={busy}
          onPress={() => act(r, 'reorg')}
          className="flex-1 items-center rounded-xl bg-accent py-2.5 active:opacity-70">
          <Text className="text-sm font-semibold text-background">Apply</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ReorgSection({
  reorgs,
  busy,
  act,
  titleFor,
  colors,
}: {
  reorgs: DashboardReorg[];
  busy: Record<string, boolean>;
  act: (r: DashboardReorg, action: 'reorg' | 'reorg-dismiss') => void;
  /** Maps a subject slug to its display title (falls back to the slug). */
  titleFor: (subject: string) => string;
  colors: ThemeColors;
}) {
  return (
    <View className="mb-6">
      <SectionHeader icon={FileStack} title="Reorganize" count={reorgs.length} colors={colors} />
      {reorgs.map(r => (
        <ReorgCard
          key={r.subject}
          reorg={r}
          // Namespaced to match useDashboardData's reorgKey so the subject slug can't
          // collide with a card id / merge suggestion in the shared busy map.
          busy={!!busy[`reorg:${r.subject}`]}
          act={act}
          titleFor={titleFor}
          colors={colors}
        />
      ))}
    </View>
  );
}

export default React.memo(ReorgSection);
