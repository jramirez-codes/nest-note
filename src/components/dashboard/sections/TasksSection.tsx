/**
 * The Tasks section: a sort toggle over a fixed-height, internally-scrolling surface
 * of task rows, with a pager beneath. Owns all of its own UI state — the chosen sort,
 * the current page, which row is expanded, and the measured row height — so the
 * dashboard shell can render it with just the raw task cards.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { type LayoutChangeEvent, ScrollView, View } from 'react-native';
import { ListChecks } from 'lucide-react-native';
import type { ThemeColors } from '../../../theme/colors';
import type { DashboardCard } from '../../../server/controllers/aiController';
import { compareTasksBy, TASK_PAGE_SIZE, type TaskSort, type TaskView } from '../cardModel';
import {
  type CardDragProps,
  DraggableCard,
  Pager,
  SectionHeader,
  TaskRow,
  TaskViewToggle,
} from '../DashboardCards';
import TaskCalendar from './TaskCalendar';

function TasksSection({
  tasks,
  notebookKey,
  colors,
  busy,
  onToggle,
  dragProps,
  liftedId,
  subjectTitleFor,
}: {
  /** This notebook's task cards, unsorted — the section applies the chosen sort. */
  tasks: DashboardCard[];
  /** The active notebook's key; changing it resets the pager to page 0. */
  notebookKey: string;
  colors: ThemeColors;
  busy: Record<string, boolean>;
  onToggle: (c: DashboardCard) => void;
  dragProps: CardDragProps;
  liftedId: string | null;
  /** Maps a card's `source` slug to its notebook's display title, for the badge. */
  subjectTitleFor: (source?: string) => string;
}) {
  // The view toggle's current mode: the two list orders ('priority'/'date') or the
  // month 'calendar'. The pager resets to page 0 whenever the list order changes,
  // since the old page may no longer line up.
  const [taskView, setTaskView] = useState<TaskView>('priority');
  const [taskPage, setTaskPage] = useState(0);
  const changeTaskView = useCallback((v: TaskView) => {
    setTaskView(v);
    setTaskPage(0);
  }, []);
  const isCalendar = taskView === 'calendar';
  // The list order in play (the calendar carries its own ordering); either list mode
  // is itself a valid TaskSort.
  const taskSort: TaskSort = isCalendar ? 'priority' : taskView;

  // The one row (if any) currently expanded to show its full, wrapped title. A single
  // id, not a set — expanding a row collapses whichever was open.
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const toggleExpand = useCallback((id: string) => {
    setExpandedTaskId(prev => (prev === id ? null : id));
  }, []);

  // The box holds a fixed number of collapsed rows' worth of height (measured from
  // the first row, so it tracks the live font scale) and scrolls internally —
  // expanding a row grows it past that height instead of growing the whole page.
  const [taskRowHeight, setTaskRowHeight] = useState<number | null>(null);
  const handleFirstTaskRowLayout = useCallback((e: LayoutChangeEvent) => {
    // Read the height synchronously — the event is pooled and `e.nativeEvent` goes
    // null after this handler returns, but the setState updater below can run again
    // later (e.g. Strict Mode's double-invoke), so it must close over a plain number.
    const height = e.nativeEvent.layout.height;
    setTaskRowHeight(prev => prev ?? height);
  }, []);

  // The whole list card's measured height (rows + pager), so the calendar card can
  // stand in at exactly the same size. Measured live in list mode — including the
  // pager, which only shows past one page — so it stays accurate as the list grows.
  const [cardHeight, setCardHeight] = useState<number | null>(null);
  const handleCardLayout = useCallback((e: LayoutChangeEvent) => {
    setCardHeight(e.nativeEvent.layout.height);
  }, []);
  // What the calendar card should be tall: the measured list card if we have it,
  // else an estimate from the row height (before the list has ever laid out).
  const calendarHeight =
    cardHeight ??
    (taskRowHeight ? taskRowHeight * TASK_PAGE_SIZE + (TASK_PAGE_SIZE - 1) + 44 : undefined);

  const sorted = useMemo(() => tasks.slice().sort(compareTasksBy(taskSort)), [tasks, taskSort]);
  const openTaskCount = sorted.filter(t => !t.done).length;

  const pageCount = Math.max(1, Math.ceil(sorted.length / TASK_PAGE_SIZE));
  // Clamp rather than resync via effect: cheap, and avoids a stale-page flash when
  // e.g. completing the last task on the last page shrinks the list.
  const safePage = Math.min(taskPage, pageCount - 1);
  const paged = sorted.slice(safePage * TASK_PAGE_SIZE, safePage * TASK_PAGE_SIZE + TASK_PAGE_SIZE);

  // Reset the pager on a notebook swap — a page index from one notebook's task list
  // is meaningless against another's.
  useEffect(() => setTaskPage(0), [notebookKey]);
  // Collapse any expanded row whenever the visible set of rows changes underneath it
  // — the row it referred to may no longer be on screen.
  useEffect(() => setExpandedTaskId(null), [notebookKey, taskView, taskPage]);

  return (
    <View className="mb-6">
      <SectionHeader icon={ListChecks} title="Tasks" count={openTaskCount} colors={colors} />
      <View className="mb-2">
        <TaskViewToggle view={taskView} onChange={changeTaskView} colors={colors} />
      </View>
      {isCalendar ? (
        <TaskCalendar
          tasks={tasks}
          colors={colors}
          busy={busy}
          onToggle={onToggle}
          subjectTitleFor={subjectTitleFor}
          height={calendarHeight}
        />
      ) : (
        <View
          onLayout={handleCardLayout}
          className="overflow-hidden rounded-2xl border border-surface1 bg-surface">
          <ScrollView
            nestedScrollEnabled
            scrollEnabled={!liftedId}
            style={
              // Fixed, not max — the box holds this height even when a page has fewer
              // than TASK_PAGE_SIZE tasks, so it doesn't resize page to page. +1px per
              // hairline divider between rows (there's none above the first row).
              taskRowHeight
                ? { height: taskRowHeight * TASK_PAGE_SIZE + (TASK_PAGE_SIZE - 1) }
                : undefined
            }>
            {paged.map((card, i) => (
              <View key={card.id} onLayout={i === 0 ? handleFirstTaskRowLayout : undefined}>
                {i > 0 && <View className="ml-11 h-px bg-surface1/60" />}
                <DraggableCard card={card} {...dragProps}>
                  <TaskRow
                    card={card}
                    colors={colors}
                    busy={busy}
                    onToggle={onToggle}
                    dimmed={liftedId === card.id}
                    subjectTitle={subjectTitleFor(card.source)}
                    expanded={expandedTaskId === card.id}
                    onExpandToggle={() => toggleExpand(card.id)}
                  />
                </DraggableCard>
              </View>
            ))}
          </ScrollView>
          <Pager page={safePage} pageCount={pageCount} onChange={setTaskPage} colors={colors} />
        </View>
      )}
    </View>
  );
}

export default React.memo(TasksSection);
