import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Archive, GitMerge, Inbox, Lightbulb, ListChecks } from 'lucide-react-native';
import { useTheme } from '../../theme/colors';
import type { CardDragShared } from '../../hooks/useCardDrag';
import type { Note } from '../../types/note';
import { type DashboardCard } from '../../server/controllers/aiController';
import { useDashboardData } from './useDashboardData';
import {
  ARCHIVE_PAGE_SIZE,
  buildNotebookOptions,
  compareCards,
  compareTasksBy,
  humanizeKind,
  TASK_PAGE_SIZE,
  type TaskSort,
} from './cardModel';
import { type NotebookOption } from './NotebookSwitcher';
import {
  ArchivedList,
  DraggableCard,
  IdeaCard,
  Pager,
  SectionHeader,
  TaskRow,
  TaskSortToggle,
} from './DashboardCards';

interface DashboardPageProps {
  /** Exact page width so the sheet fills its slot in the pager. */
  width: number;
  /** True when this is the page on top — used to refresh state when flipped to. */
  isActive: boolean;
  /** Shared values the card gesture writes; read by the header + floating clone. */
  dragShared: CardDragShared;
  /** Notify the screen a card was lifted (so it can show the floating clone). */
  onLift: (card: DashboardCard) => void;
  /** Notify the screen the drag ended. */
  onRelease: () => void;
  /** The notebook currently filling the pad: 'sandbox' (local) or a subject slug. Owned by
   *  the screen (swapped via the header switcher), and read here to filter the cards shown. */
  selectedNb: string;
  /** The local pad's archived pages (from `/archive`), shown in the Sandbox dashboard's
   *  Archived section. Owned by the screen so it can open one as a temporary page. */
  archivedPages: Note[];
  /** Open an archived page as a temporary, editable page. */
  onOpenArchived: (note: Note) => void;
}

/**
 * The dashboard: the trailing page of the pad. It's the home for the MCP world
 * `/ingest` builds up — its reminders and action items, each subject's notes, and
 * any merge suggestions — laid out as a Material-style action center. Cards are
 * removed by pressing and holding, then dragging them up onto the header, which
 * turns into a delete target, so a delete is always deliberate.
 *
 * This component owns the dashboard's state and orchestration; the notebook is
 * swapped from the header switcher (this page just reads `selectedNb` to filter),
 * the card renderers live in ./dashboard/DashboardCards, and the sorting/formatting
 * rules in ./dashboard/cardModel.
 */
function DashboardPage({
  width,
  isActive,
  dragShared,
  onLift,
  onRelease,
  selectedNb,
  archivedPages,
  onOpenArchived,
}: DashboardPageProps) {
  const colors = useTheme();
  const { state, error, loading, refreshing, busy, load, act, onToggle, onDismiss } =
    useDashboardData(isActive);
  // The card currently lifted, kept locally so only this page dims its source row
  // (the screen tracks its own copy for the floating clone).
  const [liftedId, setLiftedId] = useState<string | null>(null);

  // The Tasks section's sort toggle and current page (reset to page 0 whenever the
  // sort or notebook changes, since the old page may no longer line up).
  const [taskSort, setTaskSort] = useState<TaskSort>('priority');
  const [taskPage, setTaskPage] = useState(0);
  const changeTaskSort = useCallback((s: TaskSort) => {
    setTaskSort(s);
    setTaskPage(0);
  }, []);

  // The Archived section's current page (reset when the notebook changes, since a
  // page index from one notebook's archive is meaningless against another's) and
  // its search query (filters the archive by title/body, client-side).
  const [archivePage, setArchivePage] = useState(0);
  const [archiveQuery, setArchiveQuery] = useState('');

  // The one task row (if any) currently expanded to show its full, wrapped title.
  // A single id, not a set — expanding a row collapses whichever was open.
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const toggleExpand = useCallback((id: string) => {
    setExpandedTaskId(prev => (prev === id ? null : id));
  }, []);

  // The Tasks box holds a fixed number of collapsed rows' worth of height (measured
  // from the first row, so it tracks the live font scale) and scrolls internally —
  // expanding a row grows it past that height instead of growing the whole page.
  const [taskRowHeight, setTaskRowHeight] = useState<number | null>(null);
  const handleFirstTaskRowLayout = useCallback((e: LayoutChangeEvent) => {
    // Read the height synchronously — the event is pooled and `e.nativeEvent` goes
    // null after this handler returns, but the setState updater below can run again
    // later (e.g. Strict Mode's double-invoke), so it must close over a plain number.
    const height = e.nativeEvent.layout.height;
    setTaskRowHeight(prev => prev ?? height);
  }, []);

  // Wrap the screen's lift/release so this page can also dim the lifted source row.
  const handleLift = useCallback(
    (card: DashboardCard) => {
      setLiftedId(card.id);
      onLift(card);
    },
    [onLift],
  );
  const handleRelease = useCallback(() => {
    setLiftedId(null);
    onRelease();
  }, [onRelease]);

  // Memoized so they're stable render-to-render (a fresh `?? []` each time would
  // otherwise re-trigger the notebook-options memo below on every render).
  const allServers = useMemo(() => state?.servers ?? [], [state]);
  const allCards = useMemo(() => state?.cards ?? [], [state]);
  const allSuggestions = state?.suggestions ?? [];

  // Maps a card's `source` slug to its notebook's display title, for the Tasks
  // list's subject badge — falls back to the slug itself, or "Sandbox" for cards
  // with no source (local-pad-only cards).
  const subjectTitleFor = useCallback(
    (source?: string) => {
      if (!source) return 'Sandbox';
      return allServers.find(s => s.name === source)?.title || source;
    },
    [allServers],
  );

  // The notebook picker's entries, shared with the header badge (see cardModel).
  const nbOptions = useMemo<NotebookOption[]>(
    () => buildNotebookOptions(allCards, allServers),
    [allCards, allServers],
  );

  // The chosen notebook, falling back to the Sandbox if the selection vanished (e.g. its
  // subject was merged away since it was picked).
  const selected = nbOptions.find(o => o.key === selectedNb) ?? nbOptions[0];
  // The Sandbox is the aggregate view: every notebook's cards plus all merge suggestions.
  // A subject shows only its own cards (its notes live in the pad's pages, not here).
  const isSandbox = selected.key === 'sandbox';

  // Notifications are deprecated: any that still exist on the server (filed before
  // the kind was retired) are hidden here rather than falling into the generic grid.
  const cards = (isSandbox ? allCards : allCards.filter(c => c.source === selected.key)).filter(
    c => c.kind !== 'notification',
  );
  const suggestions = isSandbox ? allSuggestions : [];

  // Split cards into their sections. Tasks are first-class; every other kind is
  // grouped by kind and rendered through the generic idea-card grid, so a brand-new
  // kind appears immediately with no code change here.
  const tasks = cards.filter(c => c.kind === 'task').sort(compareTasksBy(taskSort));
  const otherKinds: Record<string, DashboardCard[]> = {};
  for (const c of cards) {
    if (c.kind === 'task') continue;
    (otherKinds[c.kind] ??= []).push(c);
  }
  const otherKindNames = Object.keys(otherKinds).sort();

  const openTaskCount = tasks.filter(t => !t.done).length;
  // Archived pages are a local-pad concept, so they only surface on the Sandbox
  // dashboard (subjects have no local pages of their own here). The search bar
  // stays put once the section is shown, so base visibility on the full archive
  // (not the filtered set) — a query that matches nothing shows an empty state.
  const showArchived = isSandbox && archivedPages.length > 0;
  const archiveQ = archiveQuery.trim().toLowerCase();
  const filteredArchived = archiveQ
    ? archivedPages.filter(
        p =>
          p.title.toLowerCase().includes(archiveQ) ||
          p.content.toLowerCase().includes(archiveQ),
      )
    : archivedPages;
  // Paginate the filtered set, like Tasks.
  const archivePageCount = Math.max(1, Math.ceil(filteredArchived.length / ARCHIVE_PAGE_SIZE));
  // Clamp rather than resync via effect (matches the Tasks pager): avoids a stale-page
  // flash when deleting the last page on the last archive page shrinks the list.
  const safeArchivePage = Math.min(archivePage, archivePageCount - 1);
  const pagedArchived = filteredArchived.slice(
    safeArchivePage * ARCHIVE_PAGE_SIZE,
    safeArchivePage * ARCHIVE_PAGE_SIZE + ARCHIVE_PAGE_SIZE,
  );
  const nothingAtAll = cards.length === 0 && suggestions.length === 0 && !showArchived;

  // Reset the pagers whenever the notebook changes — a page index from one
  // notebook's task/archive list is meaningless against another's. The archive
  // search is cleared on a swap too, then reset to page 0 on any query change.
  useEffect(() => setTaskPage(0), [selected.key]);
  useEffect(() => {
    setArchivePage(0);
    setArchiveQuery('');
  }, [selected.key]);
  useEffect(() => setArchivePage(0), [archiveQuery]);
  // Collapse any expanded task whenever the visible set of rows changes underneath
  // it — the row it referred to may no longer be on screen.
  useEffect(() => setExpandedTaskId(null), [selected.key, taskSort, taskPage]);

  const taskPageCount = Math.max(1, Math.ceil(tasks.length / TASK_PAGE_SIZE));
  // Clamp rather than resync via effect: cheap, and avoids a stale-page flash when
  // e.g. completing the last task on the last page shrinks the list.
  const safeTaskPage = Math.min(taskPage, taskPageCount - 1);
  const pagedTasks = tasks.slice(
    safeTaskPage * TASK_PAGE_SIZE,
    safeTaskPage * TASK_PAGE_SIZE + TASK_PAGE_SIZE,
  );

  // Shared drag props handed to every draggable card.
  const dragProps = {
    drag: dragShared,
    onLift: handleLift,
    onDrop: onDismiss,
    onRelease: handleRelease,
  };

  return (
    <View style={{ width }} className="flex-1 bg-background">
      <ScrollView
        // Freeze the scroll while a card is being dragged so the list stays put.
        scrollEnabled={!liftedId}
        // Let a tap on a result / clear button register while the archive search
        // keyboard is up, instead of being swallowed to dismiss it first.
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load('refresh')}
            tintColor={colors.muted}
          />
        }>
        {loading && !state ? (
          <View className="items-center py-10">
            <ActivityIndicator color={colors.muted} />
          </View>
        ) : error && !state ? (
          <View className="rounded-2xl border border-surface1 bg-surface p-4">
            <Text className="text-sm text-danger">{error}</Text>
            <Pressable
              onPress={() => load('initial')}
              className="mt-3 self-start rounded-lg bg-background px-4 py-2 active:opacity-70">
              <Text className="text-sm font-semibold text-muted">Retry</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {/* A non-fatal error once data is on screen (e.g. an action failed). */}
            {error && (
              <View className="mb-4 rounded-2xl border border-surface1 bg-surface p-3">
                <Text className="text-sm text-danger">{error}</Text>
              </View>
            )}

            {nothingAtAll && (
              <View className="items-center rounded-2xl border border-surface1 bg-surface px-6 py-10">
                <Inbox size={32} color={colors.faint} strokeWidth={1.75} />
                <Text className="mt-3 text-center text-sm text-muted">
                  Nothing here yet. Write some notes, then run{' '}
                  <Text className="text-text">/ingest</Text> to file tasks, reminders and
                  subjects here.
                </Text>
              </View>
            )}

            {/* Archived — pages lifted off the pad by /archive, reopenable as temporary
                pages. Sits above Tasks; local-pad only (Sandbox). */}
            {showArchived && (
              <View className="mb-6">
                <SectionHeader
                  icon={Archive}
                  title="Archived"
                  count={archivedPages.length}
                  colors={colors}
                />
                {/* One cohesive card: the search field is its header, the filtered/
                    paginated rows its body, and the pager its footer. */}
                <ArchivedList
                  pages={pagedArchived}
                  onOpen={onOpenArchived}
                  colors={colors}
                  page={safeArchivePage}
                  pageCount={archivePageCount}
                  pageSize={ARCHIVE_PAGE_SIZE}
                  onChangePage={setArchivePage}
                  query={archiveQuery}
                  onQueryChange={setArchiveQuery}
                />
              </View>
            )}

            {/* Tasks — sort toggle, a high-density surface with hairline dividers, then a pager. */}
            {tasks.length > 0 && (
              <View className="mb-6">
                <SectionHeader icon={ListChecks} title="Tasks" count={openTaskCount} colors={colors} />
                <View className="mb-2">
                  <TaskSortToggle sort={taskSort} onChange={changeTaskSort} colors={colors} />
                </View>
                <View className="overflow-hidden rounded-2xl border border-surface1 bg-surface">
                  <ScrollView
                    nestedScrollEnabled
                    scrollEnabled={!liftedId}
                    style={
                      // Fixed, not max — the box holds this height even when a page has
                      // fewer than 5 tasks, so it doesn't resize page to page. +1px per
                      // hairline divider between rows (there's none above the first row).
                      taskRowHeight
                        ? { height: taskRowHeight * TASK_PAGE_SIZE + (TASK_PAGE_SIZE - 1) }
                        : undefined
                    }>
                    {pagedTasks.map((card, i) => (
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
                  <Pager
                    page={safeTaskPage}
                    pageCount={taskPageCount}
                    onChange={setTaskPage}
                    colors={colors}
                  />
                </View>
              </View>
            )}

            {/* Any future kind: grouped, rendered via the generic idea-card grid. */}
            {otherKindNames.map(kind => {
              const group = otherKinds[kind].slice().sort(compareCards);
              return (
                <View key={kind} className="mb-6">
                  <SectionHeader
                    icon={Lightbulb}
                    title={humanizeKind(kind)}
                    count={group.length}
                    colors={colors}
                  />
                  <View className="flex-row flex-wrap justify-between">
                    {group.map(card => (
                      <DraggableCard key={card.id} card={card} {...dragProps}>
                        <IdeaCard card={card} dimmed={liftedId === card.id} />
                      </DraggableCard>
                    ))}
                  </View>
                </View>
              );
            })}

            {/* Optional yes/no questions from ingest — merge suggestions. */}
            {suggestions.length > 0 && (
              <View className="mb-6">
                <SectionHeader icon={GitMerge} title="Suggestions" colors={colors} />
                {suggestions.map(s => (
                  <View
                    key={s.into}
                    className="mb-2 rounded-2xl border border-surface1 bg-surface p-3">
                    <Text className="text-sm text-text">
                      Merge{' '}
                      <Text className="font-semibold text-text">{s.from.join(', ')}</Text> into{' '}
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
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  scrollContent: { padding: 20, paddingBottom: 120 },
});

export default React.memo(DashboardPage);
