/**
 * The Tasks section's calendar view: a month grid that stands in for the task list
 * card (same width, same fixed height) when the "Calendar" bubble is active. Days
 * that carry due tasks show a priority-tinted pip; tapping a day swaps the card's
 * body for that day's tasks (with a back arrow home to the grid), so both states
 * fit the one fixed height instead of stacking taller.
 */
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import type { ThemeColors } from '../../../theme/colors';
import type { DashboardCard } from '../../../server/controllers/aiController';
import {
  buildMonthGrid,
  compareTasks,
  formatCalendarDay,
  MONTH_NAMES,
  prio,
  tasksByDueDate,
  topPriority,
  WEEKDAYS,
} from '../cardModel';
import { TaskRow } from '../DashboardCards';

// Chunk the flat 42-cell grid into six week rows for rendering.
function toWeeks<T>(cells: T[]): T[][] {
  const weeks: T[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export default function TaskCalendar({
  tasks,
  colors,
  busy,
  onToggle,
  subjectTitleFor,
  height,
}: {
  /** This notebook's task cards — the calendar buckets the dated ones by day. */
  tasks: DashboardCard[];
  colors: ThemeColors;
  busy: Record<string, boolean>;
  onToggle: (c: DashboardCard) => void;
  /** Maps a card's `source` slug to its notebook's display title, for the badge. */
  subjectTitleFor: (source?: string) => string;
  /** The task list card's measured height, so the calendar card matches it exactly. */
  height?: number;
}) {
  const today = useMemo(() => new Date(), []);
  // Build today's key from local date parts (matching buildMonthGrid), not UTC —
  // toISOString() can name the wrong calendar day near midnight.
  const todayKey = useMemo(() => {
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }, [today]);

  // The month on screen (0-based), and the day whose task list is showing (null =
  // the month grid). Default to the current month; no day selected.
  const [ym, setYm] = useState<{ year: number; month: number }>({
    year: today.getFullYear(),
    month: today.getMonth(),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const byDay = useMemo(() => tasksByDueDate(tasks), [tasks]);
  const grid = useMemo(() => buildMonthGrid(ym.year, ym.month), [ym]);
  const weeks = useMemo(() => toWeeks(grid), [grid]);

  const step = (delta: number) => {
    setYm(prev => {
      const d = new Date(prev.year, prev.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  // The selected day's cards in the list view's default (priority) order, so the
  // most urgent lead.
  const dayTasks = useMemo(
    () => (selected ? (byDay.get(selected) ?? []).slice().sort(compareTasks) : []),
    [selected, byDay],
  );

  const style = height ? { height } : undefined;

  // Day view: the tapped day's tasks (or an empty note), with a back arrow to the grid.
  if (selected) {
    return (
      <View
        style={style}
        className="overflow-hidden rounded-2xl border border-surface1 bg-surface">
        <View className="flex-row items-center gap-2 border-b border-surface1 px-2 py-2.5">
          <Pressable
            onPress={() => {
              setSelected(null);
              setExpandedId(null);
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back to calendar"
            className="h-7 w-7 items-center justify-center rounded-full active:bg-background">
            <ChevronLeft size={18} color={colors.muted} strokeWidth={2.5} />
          </Pressable>
          <Text className="flex-1 text-sm font-semibold text-text">
            {formatCalendarDay(selected)}
          </Text>
          {dayTasks.length > 0 && (
            <Text className="pr-1 text-xs font-bold text-faint">· {dayTasks.length}</Text>
          )}
        </View>
        {dayTasks.length > 0 ? (
          <ScrollView className="flex-1">
            {dayTasks.map((card, i) => (
              <View key={card.id}>
                {i > 0 && <View className="ml-11 h-px bg-surface1/60" />}
                <TaskRow
                  card={card}
                  colors={colors}
                  busy={busy}
                  onToggle={onToggle}
                  dimmed={false}
                  subjectTitle={subjectTitleFor(card.source)}
                  expanded={expandedId === card.id}
                  onExpandToggle={() =>
                    setExpandedId(prev => (prev === card.id ? null : card.id))
                  }
                />
              </View>
            ))}
          </ScrollView>
        ) : (
          <View className="flex-1 items-center justify-center px-4">
            <Text className="text-center text-xs text-muted">No tasks due this day.</Text>
          </View>
        )}
      </View>
    );
  }

  // Month view: the header (prev / month year / next), weekday labels, then the grid.
  return (
    <View
      style={style}
      className="overflow-hidden rounded-2xl border border-surface1 bg-surface">
      <View className="flex-row items-center border-b border-surface1 px-2 py-2.5">
        <Pressable
          onPress={() => step(-1)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          className="h-7 w-7 items-center justify-center rounded-full active:bg-background">
          <ChevronLeft size={18} color={colors.muted} strokeWidth={2.5} />
        </Pressable>
        <Text className="flex-1 text-center text-sm font-semibold text-text">
          {MONTH_NAMES[ym.month]} {ym.year}
        </Text>
        <Pressable
          onPress={() => step(1)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Next month"
          className="h-7 w-7 items-center justify-center rounded-full active:bg-background">
          <ChevronRight size={18} color={colors.muted} strokeWidth={2.5} />
        </Pressable>
      </View>

      {/* Weekday header row. */}
      <View className="flex-row px-1 pt-1.5">
        {WEEKDAYS.map(w => (
          <View key={w} className="flex-1 items-center">
            <Text className="text-[10px] font-bold uppercase text-faint">{w[0]}</Text>
          </View>
        ))}
      </View>

      {/* The 6×7 grid fills the remaining height, each week row an equal share. */}
      <View className="flex-1 px-1 pb-1">
        {weeks.map((week, wi) => (
          <View key={wi} className="flex-1 flex-row">
            {week.map(cell => {
              const open = (byDay.get(cell.key) ?? []).filter(t => !t.done);
              const has = open.length > 0;
              const isToday = cell.key === todayKey;
              // A day with open tasks reads as a filled, priority-tinted disc with a
              // solid count badge in the corner — a far stronger "something's here"
              // signal on a phone than a hairline dot. Empty days stay plain text.
              const p = has ? prio(topPriority(open)) : null;
              return (
                <Pressable
                  key={cell.key}
                  onPress={() => setSelected(cell.key)}
                  accessibilityRole="button"
                  accessibilityLabel={`${cell.key}, ${open.length} tasks due`}
                  className="flex-1 items-center justify-center">
                  <View className="relative">
                    <View
                      className={`h-7 w-7 items-center justify-center rounded-full ${
                        p ? p.chip : ''
                      } ${isToday ? 'border border-accent' : ''}`}>
                      <Text
                        className={`text-xs ${
                          !cell.inMonth
                            ? 'text-faint'
                            : p
                              ? `font-bold ${p.text}`
                              : isToday
                                ? 'font-bold text-accent'
                                : 'text-text'
                        }`}>
                        {cell.day}
                      </Text>
                    </View>
                    {p && (
                      <View
                        className={`absolute -right-1 -top-1 h-4 min-w-[16px] items-center justify-center rounded-full px-1 ${p.pip}`}>
                        <Text className="text-[9px] font-bold text-background">{open.length}</Text>
                      </View>
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}
