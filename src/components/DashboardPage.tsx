import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Folder, GitMerge, Inbox, Lightbulb, ListChecks } from 'lucide-react-native';
import { useTheme } from '../theme/colors';
import type { CardDragShared } from './cardDrag';
import {
  applyDashboardAction,
  completeCard,
  dismissCard,
  fetchDashboardState,
  getCachedDashboardState,
  setCachedDashboardState,
  type DashboardCard,
  type DashboardState,
  type DashboardSuggestion,
} from '../server/aiController';
import {
  compareCards,
  compareTasksBy,
  humanizeKind,
  TASK_PAGE_SIZE,
  type TaskSort,
} from './dashboard/cardModel';
import { NotebookSwitcher, type NotebookOption } from './dashboard/NotebookSwitcher';
import {
  DraggableCard,
  IdeaCard,
  Pager,
  SectionHeader,
  TaskRow,
  TaskSortToggle,
} from './dashboard/DashboardCards';

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
   *  the screen so the switcher can swap the pad's pages, not just the dashboard's view. */
  selectedNb: string;
  /** Switch the active notebook (drives both this dashboard and the pad's pages). */
  onSelectNotebook: (key: string) => void;
}

/**
 * The dashboard: the trailing page of the pad. It's the home for the MCP world
 * `/ingest` builds up — its reminders and action items, each subject's notes, and
 * any merge suggestions — laid out as a Material-style action center. Cards are
 * removed by pressing and holding, then dragging them up onto the header, which
 * turns into a delete target, so a delete is always deliberate.
 *
 * This component owns the dashboard's state and orchestration; the notebook picker
 * lives in ./dashboard/NotebookSwitcher, the card renderers in
 * ./dashboard/DashboardCards, and the sorting/formatting rules in
 * ./dashboard/cardModel.
 */
function DashboardPage({
  width,
  isActive,
  dragShared,
  onLift,
  onRelease,
  selectedNb,
  onSelectNotebook,
}: DashboardPageProps) {
  const colors = useTheme();
  // Seed from the module cache so a remount (the common case — swiping back to the
  // dashboard, which the pager unmounts at rest) paints the last-known cards at once
  // instead of flashing the spinner. A silent background refresh then reconciles.
  const [state, setState] = useState<DashboardState | null>(() => getCachedDashboardState());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Keys (suggestion 'into' or card id) currently being acted on, to disable their
  // controls while the write is in flight.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
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
    setTaskRowHeight(prev => prev ?? e.nativeEvent.layout.height);
  }, []);

  // Guard against setState after unmount / after a newer fetch superseded this one.
  const reqSeq = useRef(0);

  // 'initial' shows the centered loader (only when there's nothing on screen yet),
  // 'refresh' drives the pull-to-refresh control, and 'silent' reconciles in the
  // background with no visible indicator — used for auto-refreshes when cards are
  // already showing, so returning to the dashboard never flashes a spinner.
  const load = useCallback(async (mode: 'initial' | 'refresh' | 'silent') => {
    const seq = ++reqSeq.current;
    if (mode === 'refresh') setRefreshing(true);
    else if (mode === 'initial') setLoading(true);
    try {
      const data = await fetchDashboardState();
      if (seq !== reqSeq.current) return;
      setState(data);
      setError(null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === reqSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Keep the module cache in step with the latest state (fresh fetches and optimistic
  // edits alike), so the next remount seeds from current data rather than a stale snapshot.
  useEffect(() => {
    if (state) setCachedDashboardState(state);
  }, [state]);

  // Fetch on mount and whenever the page is flipped to (so ingesting a page and
  // swiping here shows the freshly filed notes). When cards are already on screen
  // (seeded from cache, or previously loaded) the refresh is silent — no spinner.
  const wasActive = useRef(false);
  useEffect(() => {
    if (isActive && !wasActive.current) load('silent');
    wasActive.current = isActive;
  }, [isActive, load]);
  useEffect(() => {
    // A cold start with no cache shows the loader; a cache hit reconciles silently.
    load(getCachedDashboardState() ? 'silent' : 'initial');
    // Capture the ref object so the cleanup mutates the same counter even if the
    // component's ref were to change; bumping it invalidates any in-flight fetch.
    const seq = reqSeq;
    return () => {
      seq.current++; // invalidate any in-flight fetch on unmount
    };
  }, [load]);

  const act = useCallback(
    async (s: DashboardSuggestion, action: 'merge' | 'dismiss') => {
      setBusy(b => ({ ...b, [s.into]: true }));
      try {
        await applyDashboardAction({ action, into: s.into, from: s.from });
        // Drop the suggestion locally; a merge also changes servers, so refetch.
        setState(prev =>
          prev
            ? { ...prev, suggestions: prev.suggestions.filter(x => x.into !== s.into) }
            : prev,
        );
        if (action === 'merge') load('refresh');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(b => ({ ...b, [s.into]: false }));
      }
    },
    [load],
  );

  // Toggle a task's done state with an optimistic flip, reverted if the write fails.
  const onToggle = useCallback(async (card: DashboardCard) => {
    const next = !card.done;
    setBusy(b => ({ ...b, [card.id]: true }));
    setState(prev =>
      prev
        ? { ...prev, cards: prev.cards.map(c => (c.id === card.id ? { ...c, done: next } : c)) }
        : prev,
    );
    try {
      await completeCard(card.id, next, card.source);
    } catch (e) {
      setState(prev =>
        prev
          ? { ...prev, cards: prev.cards.map(c => (c.id === card.id ? { ...c, done: !next } : c)) }
          : prev,
      );
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(b => ({ ...b, [card.id]: false }));
    }
  }, []);

  // Dismiss a card, removing it optimistically and restoring it if the write fails.
  const onDismiss = useCallback(async (card: DashboardCard) => {
    setBusy(b => ({ ...b, [card.id]: true }));
    setState(prev =>
      prev ? { ...prev, cards: prev.cards.filter(c => c.id !== card.id) } : prev,
    );
    try {
      await dismissCard(card.id, card.source);
    } catch (e) {
      setState(prev => (prev ? { ...prev, cards: [...prev.cards, card] } : prev));
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(b => ({ ...b, [card.id]: false }));
    }
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

  // The notebook picker's entries: the Sandbox (the local pad, which also rolls up every
  // notebook's cards), then one per subject server, each tagged with its own open-task
  // count (a card belongs to a notebook via its `source` slug).
  const nbOptions = useMemo<NotebookOption[]>(() => {
    const tasksFor = (name: string) =>
      allCards.filter(c => c.source === name && c.kind === 'task' && !c.done).length;
    const opts: NotebookOption[] = [
      {
        key: 'sandbox',
        label: 'Sandbox',
        kind: 'local',
        tasks: allCards.filter(c => c.kind === 'task' && !c.done).length,
      },
    ];
    for (const s of allServers) {
      opts.push({ key: s.name, label: s.title || s.name, summary: s.summary, kind: 'server', tasks: tasksFor(s.name) });
    }
    return opts;
  }, [allCards, allServers]);

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
  const nothingAtAll = cards.length === 0 && suggestions.length === 0;

  // Reset the pager whenever the notebook changes — a page index from one
  // notebook's task list is meaningless against another's.
  useEffect(() => setTaskPage(0), [selected.key]);
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
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load('refresh')}
            tintColor={colors.muted}
          />
        }>
        {/* Notebook switcher — the top-of-dashboard control to swap notebooks. */}
        <View className="mb-5 z-10">
          <SectionHeader icon={Folder} title="Subjects" count={nbOptions.length} colors={colors} />
          <NotebookSwitcher
            options={nbOptions}
            selected={selected}
            onSelect={onSelectNotebook}
            colors={colors}
          />
        </View>

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
                      // +1px per hairline divider between rows (there's none above the
                      // first row), so 5 collapsed rows fit with no scroll sliver.
                      taskRowHeight
                        ? { maxHeight: taskRowHeight * TASK_PAGE_SIZE + (TASK_PAGE_SIZE - 1) }
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
