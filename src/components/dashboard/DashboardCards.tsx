/**
 * The presentational pieces of the dashboard: the long-press drag wrapper, the
 * section header, and the card renderers (task row, generic idea card). All are
 * pure views driven by props — the container in ../DashboardPage.tsx owns the
 * state and hands cards down.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  Lightbulb,
  Search,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import type { ThemeColors } from '../../theme/colors';
import type { DashboardCard } from '../../server/controllers/aiController';
import type { CardDragShared } from '../../hooks/useCardDrag';
import { deriveTitle, type Note } from '../../types/note';
import { prio, relDate, type TaskSort } from './cardModel';

// Wraps a card in a long-press pan gesture: hold ~220ms to lift it, drag up onto
// the header (which turns into the delete target, tracked by comparing the finger's
// window-Y to the header's bottom edge), and release there to dismiss. A quick tap
// still reaches the card's own controls.
export function DraggableCard({
  card,
  drag,
  onLift,
  onDrop,
  onRelease,
  children,
}: {
  card: DashboardCard;
  drag: CardDragShared;
  onLift: (c: DashboardCard) => void;
  onDrop: (c: DashboardCard) => void;
  onRelease: () => void;
  children: React.ReactNode;
}) {
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(220)
        .maxPointers(1)
        .onStart(e => {
          drag.active.value = 1;
          drag.overDelete.value = 0;
          drag.dragX.value = e.absoluteX;
          drag.dragY.value = e.absoluteY;
          runOnJS(onLift)(card);
        })
        .onUpdate(e => {
          drag.dragX.value = e.absoluteX;
          drag.dragY.value = e.absoluteY;
          drag.overDelete.value = e.absoluteY <= drag.headerBottomY.value ? 1 : 0;
        })
        .onEnd(() => {
          if (drag.overDelete.value === 1) runOnJS(onDrop)(card);
        })
        .onFinalize(() => {
          drag.active.value = 0;
          drag.overDelete.value = 0;
          runOnJS(onRelease)();
        }),
    [card, drag, onLift, onDrop, onRelease],
  );
  return <GestureDetector gesture={pan}>{children}</GestureDetector>;
}

// A section heading: a small Lucide glyph, an uppercase label, and a count chip —
// the same rhythm across every block of the dashboard.
export function SectionHeader({
  icon: IconCmp,
  title,
  count,
  colors,
}: {
  icon: LucideIcon;
  title: string;
  count?: number;
  colors: ThemeColors;
}) {
  return (
    <View className="mb-2 flex-row items-center gap-2 px-1">
      <IconCmp size={14} color={colors.faint} strokeWidth={2.5} />
      <Text className="text-xs font-bold uppercase tracking-wider text-faint">{title}</Text>
      {typeof count === 'number' && (
        <Text className="text-xs font-bold text-faint">· {count}</Text>
      )}
    </View>
  );
}

// One task row inside the grouped Tasks surface: a checkbox that toggles done, the
// title (struck through when done), a subject badge (themed to the task's priority),
// and a due date (red when overdue). Tapping the title expands it in place — it
// wraps to full text and the due date steps aside — rather than truncating with an
// ellipsis, so the row grows instead of hiding text behind a separate control.
export function TaskRow({
  card,
  colors,
  busy,
  onToggle,
  dimmed,
  subjectTitle,
  expanded,
  onExpandToggle,
}: {
  card: DashboardCard;
  colors: ThemeColors;
  busy: Record<string, boolean>;
  onToggle: (c: DashboardCard) => void;
  dimmed: boolean;
  subjectTitle: string;
  expanded: boolean;
  onExpandToggle: () => void;
}) {
  const due = card.date ? relDate(card.date) : null;
  const overdue = !!due?.overdue && !card.done;
  return (
    // collapsable={false} keeps Android from view-flattening this node away, which
    // the wrapping GestureDetector needs to attach the drag gesture reliably.
    <View
      collapsable={false}
      className={`flex-row px-3 py-3 ${expanded ? 'items-start' : 'items-center'} ${
        dimmed ? 'opacity-30' : ''
      }`}>
      <Pressable
        onPress={() => onToggle(card)}
        disabled={busy[card.id]}
        hitSlop={8}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: !!card.done }}
        accessibilityLabel={card.title}
        className={`h-6 w-6 items-center justify-center rounded-md border ${
          card.done ? 'border-accent bg-accent' : 'border-overlay0'
        }`}>
        {card.done && <Check size={15} color={colors.background} strokeWidth={3} />}
      </Pressable>
      <Pressable
        onPress={onExpandToggle}
        disabled={busy[card.id]}
        accessibilityRole="button"
        accessibilityLabel={`Task: ${card.title}`}
        className={`flex-1 flex-row pl-3 pr-2 ${expanded ? 'items-start' : 'items-center'}`}>
        {!!subjectTitle && (
          <View
            className={`mr-2 max-w-[35%] shrink-0 rounded-full px-2 py-0.5 ${prio(card.priority).chip}`}>
            <Text numberOfLines={1} className={`text-[10px] font-bold ${prio(card.priority).text}`}>
              {subjectTitle}
            </Text>
          </View>
        )}
        <Text
          numberOfLines={expanded ? undefined : 1}
          className={`flex-1 text-sm ${card.done ? 'text-faint line-through' : 'text-text'}`}>
          {card.title}
        </Text>
      </Pressable>
      {due && !card.done && !expanded && (
        <View className="flex-row items-center gap-1">
          <Clock size={12} color={overdue ? colors.danger : colors.muted} strokeWidth={2} />
          <Text className={`text-xs ${overdue ? 'text-danger' : 'text-muted'}`}>{due.label}</Text>
        </View>
      )}
    </View>
  );
}

// The two-way sort toggle above the Tasks list: 'priority' leads with urgency
// (shown as the red→orange→blue→gray legend dots, high to low), 'date' leads with
// the soonest due date. Exactly one is always active — this is a radio, not a filter.
export function TaskSortToggle({
  sort,
  onChange,
  colors,
}: {
  sort: TaskSort;
  onChange: (sort: TaskSort) => void;
  colors: ThemeColors;
}) {
  const priorityActive = sort === 'priority';
  const dateActive = sort === 'date';
  return (
    <View className="flex-row gap-2">
      <Pressable
        onPress={() => onChange('priority')}
        className={`flex-row items-center gap-2 rounded-full border px-3 py-1.5 ${
          priorityActive ? 'border-accent bg-accent' : 'border-surface1 bg-surface'
        }`}>
        <View className="flex-row gap-1">
          {(['urgent', 'high', 'normal', 'low'] as const).map(p => (
            <View key={p} className={`h-1.5 w-1.5 rounded-full ${prio(p).pip}`} />
          ))}
        </View>
        <Text className={`text-xs font-semibold ${priorityActive ? 'text-background' : 'text-muted'}`}>
          Priority
        </Text>
      </Pressable>
      <Pressable
        onPress={() => onChange('date')}
        className={`flex-row items-center gap-1.5 rounded-full border px-3 py-1.5 ${
          dateActive ? 'border-accent bg-accent' : 'border-surface1 bg-surface'
        }`}>
        <Clock size={12} color={dateActive ? colors.background : colors.muted} strokeWidth={2.5} />
        <Text className={`text-xs font-semibold ${dateActive ? 'text-background' : 'text-muted'}`}>
          Due date
        </Text>
      </Pressable>
    </View>
  );
}

// A compact prev/next-with-numbers pager for a paginated card list. Renders nothing
// for a single page so callers can mount it unconditionally — unless `alwaysShow`
// is set, in which case a single page still shows "1" with both arrows disabled.
export function Pager({
  page,
  pageCount,
  onChange,
  colors,
  alwaysShow = false,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  colors: ThemeColors;
  alwaysShow?: boolean;
}) {
  if (pageCount <= 1 && !alwaysShow) return null;
  return (
    <View className="flex-row flex-wrap items-center justify-center gap-1.5 border-t border-surface1 px-3 py-2.5">
      <Pressable
        disabled={page === 0}
        onPress={() => onChange(page - 1)}
        hitSlop={8}
        className={`h-7 w-7 items-center justify-center rounded-full ${
          page === 0 ? 'opacity-30' : 'active:bg-background'
        }`}>
        <ChevronLeft size={16} color={colors.muted} strokeWidth={2.5} />
      </Pressable>
      {Array.from({ length: pageCount }, (_, i) => i).map(i => {
        const active = i === page;
        return (
          <Pressable
            key={i}
            onPress={() => onChange(i)}
            hitSlop={6}
            className={`h-7 min-w-[28px] items-center justify-center rounded-full px-1.5 ${
              active ? 'bg-accent' : 'active:bg-background'
            }`}>
            <Text className={`text-xs font-bold ${active ? 'text-background' : 'text-muted'}`}>
              {i + 1}
            </Text>
          </Pressable>
        );
      })}
      <Pressable
        disabled={page === pageCount - 1}
        onPress={() => onChange(page + 1)}
        hitSlop={8}
        className={`h-7 w-7 items-center justify-center rounded-full ${
          page === pageCount - 1 ? 'opacity-30' : 'active:bg-background'
        }`}>
        <ChevronRight size={16} color={colors.muted} strokeWidth={2.5} />
      </Pressable>
    </View>
  );
}

// A short date for the compact archived rows, e.g. "Jul 1" (drops the year and
// time formatNoteDate carries — the row only needs a light recency cue).
function shortDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

// The Archived section: one cohesive card for the pages lifted off the pad by
// /archive. A search field is the card's HEADER bar (filters by title/body),
// above a hairline; the body is a compact list — each row a dense line (page
// glyph, title, short date, chevron) separated by hairlines — held at a FIXED
// height of `pageSize` rows (measured from the first row so it tracks the live
// font scale) so a partial last page doesn't shrink it; and the shared Pager is
// the footer. The `pages` handed in are the already-filtered, already-paginated
// slice — an empty slice with a live query shows the "no matches" state in the
// same fixed body, so the header (and card) never jumps. Tapping a row opens the
// page as a temporary, editable page (see ArchivedPageOverlay).
export function ArchivedList({
  pages,
  onOpen,
  colors,
  page,
  pageCount,
  pageSize,
  onChangePage,
  query,
  onQueryChange,
}: {
  /** The current page's slice of archived pages (the caller filters + paginates). */
  pages: Note[];
  onOpen: (note: Note) => void;
  colors: ThemeColors;
  page: number;
  pageCount: number;
  /** Rows per page — the body is fixed to this many rows' height. */
  pageSize: number;
  onChangePage: (page: number) => void;
  /** The search header's current query and its setter (owned by DashboardPage). */
  query: string;
  onQueryChange: (query: string) => void;
}) {
  // One collapsed row's height, measured from the first row (which has no divider
  // above it), so the fixed body height tracks the live font scale. Latched to the
  // first measurement so it stays stable page to page and through the empty state.
  const [rowHeight, setRowHeight] = useState<number | null>(null);
  const handleFirstRowLayout = useCallback((e: LayoutChangeEvent) => {
    const height = e.nativeEvent.layout.height;
    setRowHeight(prev => prev ?? height);
  }, []);

  // Fixed body height: `pageSize` rows + 1px per hairline divider between them.
  const bodyHeight = rowHeight ? rowHeight * pageSize + (pageSize - 1) : undefined;

  return (
    <View className="overflow-hidden rounded-2xl border border-surface1 bg-surface">
      {/* Header bar: the search field, reading as the top of the archive card. */}
      <View className="flex-row items-center gap-2 border-b border-surface1 px-3 py-2.5">
        <Search size={15} color={colors.faint} strokeWidth={2} />
        <TextInput
          value={query}
          onChangeText={onQueryChange}
          placeholder="Search archived"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          className="flex-1 p-0 text-sm text-text"
        />
        {query.length > 0 && (
          <Pressable
            onPress={() => onQueryChange('')}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear archive search">
            <X size={15} color={colors.faint} strokeWidth={2.5} />
          </Pressable>
        )}
      </View>

      {/* Body: the fixed-height row list, or the no-matches notice in its place. */}
      {pages.length > 0 ? (
        <View style={bodyHeight ? { height: bodyHeight } : undefined}>
          {pages.map((note, i) => {
            const title = note.title.trim() || deriveTitle(note.content);
            return (
              <View key={note.id} onLayout={i === 0 ? handleFirstRowLayout : undefined}>
                {i > 0 && <View className="ml-9 h-px bg-surface1/60" />}
                <Pressable
                  onPress={() => onOpen(note)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open archived page: ${title}`}
                  className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-background">
                  <FileText size={15} color={colors.faint} strokeWidth={2} />
                  <Text numberOfLines={1} className="flex-1 text-sm text-text">
                    {title}
                  </Text>
                  <Text className="text-[11px] text-faint">{shortDate(note.updatedAt)}</Text>
                  <ChevronRight size={15} color={colors.faint} strokeWidth={2.5} />
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : (
        <View
          className="items-center justify-center px-4 py-8"
          style={bodyHeight ? { height: bodyHeight } : undefined}>
          <Text numberOfLines={2} className="text-center text-xs text-muted">
            No archived pages match “{query.trim()}”.
          </Text>
        </View>
      )}

      {/* Footer: always shown (even at one page) so the page number + arrows stay. */}
      <Pager
        page={page}
        pageCount={pageCount}
        onChange={onChangePage}
        colors={colors}
        alwaysShow
      />
    </View>
  );
}

// The generic card, used for ideas and — as the graceful fallback — any unknown
// kind. A compact grid tile with a colored top accent bar, a kind glyph, and the
// title. This is what makes the engine scalable: emit a novel kind and it renders.
export function IdeaCard({ card, dimmed }: { card: DashboardCard; dimmed: boolean }) {
  const p = prio(card.priority);
  const KindIcon = card.kind === 'idea' ? Lightbulb : Sparkles;
  return (
    <View
      collapsable={false}
      className={`mb-3 w-[48%] overflow-hidden rounded-2xl border border-surface1 bg-surface p-3 ${
        dimmed ? 'opacity-30' : ''
      }`}>
      <View className={`absolute left-0 right-0 top-0 h-1 ${p.pip}`} />
      <View className="mt-1">
        <KindIcon size={16} color={p.hex} strokeWidth={2} />
      </View>
      <Text className="mt-1.5 text-sm font-semibold text-text" numberOfLines={3}>
        {card.title}
      </Text>
      {!!card.body && (
        <Text className="mt-1 text-xs text-muted" numberOfLines={2}>
          {card.body}
        </Text>
      )}
    </View>
  );
}
