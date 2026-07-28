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
  CalendarClock,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Clock,
  FileText,
  Hammer,
  Lightbulb,
  Search,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import type { ThemeColors } from '../../theme/colors';
import type { DashboardCard } from '../../server/controllers/aiController';
import type { CardDragShared } from '../../hooks/useCardDrag';
import {
  buildBadge,
  stepLabel,
  type BuildBadge as BuildBadgeState,
  type BuildBadgeTone,
} from '../../server/controllers/buildApi';
import { deriveTitle, type Note } from '../../types/note';
import { buildTone, prio, relDate, type TaskView } from './cardModel';

// The bundle of drag callbacks + shared values every draggable card needs. The
// dashboard builds this once and spreads it onto each card / section, so the wiring
// travels as a single prop instead of four.
export interface CardDragProps {
  drag: CardDragShared;
  onLift: (c: DashboardCard) => void;
  onDrop: (c: DashboardCard) => void;
  onRelease: () => void;
}

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
}: CardDragProps & {
  card: DashboardCard;
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

// The view toggle above the Tasks list: 'priority' leads with urgency (shown as
// the red→orange→blue→gray legend dots, high to low), 'date' leads with the soonest
// due date, and 'calendar' swaps the whole list for a month grid. Exactly one is
// always active — this is a radio, not a set of filters.
export function TaskViewToggle({
  view,
  onChange,
  colors,
}: {
  view: TaskView;
  onChange: (view: TaskView) => void;
  colors: ThemeColors;
}) {
  const priorityActive = view === 'priority';
  const dateActive = view === 'date';
  const calendarActive = view === 'calendar';
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
      <Pressable
        onPress={() => onChange('calendar')}
        className={`flex-row items-center gap-1.5 rounded-full border px-3 py-1.5 ${
          calendarActive ? 'border-accent bg-accent' : 'border-surface1 bg-surface'
        }`}>
        <CalendarDays
          size={12}
          color={calendarActive ? colors.background : colors.muted}
          strokeWidth={2.5}
        />
        <Text
          className={`text-xs font-semibold ${calendarActive ? 'text-background' : 'text-muted'}`}>
          Calendar
        </Text>
      </Pressable>
    </View>
  );
}

// Past this many pages the numbered buttons stop fitting on one line and the pager
// wraps into a block of digits, which would defeat the fixed height of the card it
// sits under. Beyond it the numbers collapse to a "3 / 24" readout between the same
// two arrows — a one-card-per-page section (Ideas, Builds) reaches that easily.
const MAX_NUMBERED_PAGES = 7;

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
      {pageCount <= MAX_NUMBERED_PAGES ? (
        Array.from({ length: pageCount }, (_, i) => i).map(i => {
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
        })
      ) : (
        // Too many pages to number: the position reads as text instead. Not a button
        // — with no page numbers to hit, the arrows are the only way through.
        <View className="h-7 items-center justify-center rounded-full bg-surface1/60 px-3">
          <Text className="text-xs font-bold text-muted">
            {page + 1} / {pageCount}
          </Text>
        </View>
      )}
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

// The glyph each build tone wears — the same four the idea page's header card uses
// for the same states, so the row and the page it opens read as one thing at two
// sizes. 'done' takes the checkmark the task list already means "finished" by.
const TONE_ICON: Record<BuildBadgeTone, LucideIcon> = {
  scheduled: CalendarClock,
  running: Hammer,
  waiting: Clock,
  stopped: CircleStop,
  done: Check,
};

// A card's build state as the row's leading chip: the same square the kind glyph
// sits in, grown sideways to hold the state in a word and — for the two states
// where a word isn't enough — the minute it's due or the reason it stopped.
//
// It *replaces* that glyph rather than following it. A badge beside the glyph spent
// two icons, two paddings and a gap on the row's most expensive edge, and the two
// icons were usually the same icon: the glyph already turned into a clock or a
// hammer for exactly the states the badge names. So there is one chip, and it says
// the more useful of the two things — a card a build has touched is better
// described by where that build has got to than by being, once again, an idea.
//
// Held at h-7, the plain glyph chip's height to the pixel, because a group mixes
// rows with badges and rows without: the list box measures its first row and holds
// every other row to it, so a taller (or shorter) badge would clip the group.
//
// Capped and truncated, never wrapped — a build's note can be a sentence, and a row
// is not where a sentence is read. The rest of it is one tap away on the card's
// page, which is where the same note leads the header card.
function BuildBadge({ badge }: { badge: BuildBadgeState }) {
  const tone = buildTone(badge.tone);
  const Icon = TONE_ICON[badge.tone] ?? Clock;

  return (
    <View
      className={`h-7 max-w-[55%] shrink flex-row items-center gap-1 rounded-lg px-1.5 ${tone.chip}`}>
      <Icon size={13} color={tone.hex} strokeWidth={2.5} />
      <Text numberOfLines={1} className={`shrink-0 text-[10px] font-bold ${tone.text}`}>
        {badge.label}
      </Text>
      {!!badge.detail && (
        <Text numberOfLines={1} className={`shrink text-[10px] ${tone.dim}`}>
          {badge.detail}
        </Text>
      )}
    </View>
  );
}

// One row in a card list — ideas, build steps and, as the graceful fallback, any
// unknown kind. Deliberately the same shape as TaskRow: a fixed-height row (so the
// list box can measure one and hold five of them), reading as one chip on the left,
// the title, the due date when the card carries one, and a chevron for the page
// behind it. Tapping the row opens the card as a full read-only page (see onPress →
// IdeaPageOverlay), which is where the body, tags and untruncated title live. This
// is what makes the engine scalable: emit a novel kind and it renders.
//
// That one chip is whichever of two things the card has to say. Ordinarily it is the
// kind's glyph in a priority-tinted square — the chip's colour IS the priority, so
// the row spends no width on the word "Urgent". For a card a build has touched it is
// that build's state instead (see BuildBadge), tinted by the state rather than the
// priority: those cards are read for what the build is doing, and a row has room for
// one chip, not for a glyph and a badge saying the same thing beside each other.
//
// A **build step** is the one kind that takes two lines, because it is the one kind
// that answers two questions. Its title is the *idea* — a build step is where an
// idea lives once the project exists, and the Ideas section no longer has a card
// for it — and under that, in the faint colour, the feature it is asking you to
// validate. Titled by the feature alone (as it was) a list of steps read as a pile
// of unrelated chores with no way to tell whose project each belonged to; titled by
// the idea alone, every step of a build would be the same row repeated. Both lines
// are always drawn for a step card, even one filed before steps carried what the
// second line says, so the group keeps one row height for the box to measure.
export function IdeaRow({
  card,
  colors,
  dimmed,
  onPress,
}: {
  card: DashboardCard;
  colors: ThemeColors;
  dimmed: boolean;
  onPress?: (card: DashboardCard) => void;
}) {
  const p = prio(card.priority);
  const isStep = card.kind === 'build-step';
  // Where this card's build has got to, for every card a build touches — the idea
  // it was started from and each step card it filed alike. When there is one it is
  // the row's leading chip, in place of the kind glyph: a card in a build's hands is
  // better described by what the build is doing than by what kind of card it is, and
  // the row has width for one chip, not two.
  const badge = buildBadge(card);
  // No build, so the glyph answers the only question left: what kind of card is
  // this? It no longer bends for a scheduled or running build the way it used to —
  // the badge that replaced it says that in words, and in the state's own colour.
  const KindIcon = card.kind === 'idea' ? Lightbulb : Sparkles;
  // What a step card is asking about, under the idea's name.
  const step = isStep ? stepLabel(card) : null;
  const due = card.date ? relDate(card.date) : null;
  const overdue = !!due?.overdue;
  return (
    // collapsable={false} keeps Android from view-flattening this node away, which
    // the wrapping GestureDetector needs to attach the drag gesture reliably.
    <Pressable
      onPress={() => onPress?.(card)}
      disabled={!onPress}
      accessibilityRole="button"
      // The badge's own words, rather than a second wording of the same state:
      // what a screen reader announces is then exactly what is on the row.
      accessibilityLabel={`Open ${card.kind === 'idea' ? 'idea' : card.kind}${
        badge ? `, ${badge.label}${badge.detail ? ` ${badge.detail}` : ''}` : ''
      }: ${card.title}${step ? `, ${step}` : ''}`}
      collapsable={false}
      className={`flex-row items-center gap-3 px-3 py-3 active:bg-background ${
        dimmed ? 'opacity-30' : ''
      }`}>
      {/* One chip, whichever it is: the build's state when there is one, the kind's
          glyph when there isn't. Both are h-7, so every row in a group is the one
          height the list box measures off the first of them. */}
      {badge ? (
        <BuildBadge badge={badge} />
      ) : (
        <View className={`h-7 w-7 items-center justify-center rounded-lg ${p.chip}`}>
          <KindIcon size={15} color={p.hex} strokeWidth={2} />
        </View>
      )}
      {/* The idea's name leads, because that's what the card is a step of. The
          feature under it is the decision being asked for, so it's the smaller,
          fainter line — present but never competing with the project's name. */}
      <View className="flex-1 gap-0.5">
        <Text numberOfLines={1} className="text-sm text-text">
          {card.title}
        </Text>
        {step && (
          <Text numberOfLines={1} className="text-[11px] leading-4 text-faint">
            {step}
          </Text>
        )}
      </View>
      {due && (
        <View className="flex-row items-center gap-1">
          <Clock size={12} color={overdue ? colors.danger : colors.muted} strokeWidth={2} />
          <Text className={`text-xs ${overdue ? 'text-danger' : 'text-muted'}`}>{due.label}</Text>
        </View>
      )}
      <ChevronRight size={15} color={colors.faint} strokeWidth={2.5} />
    </Pressable>
  );
}
