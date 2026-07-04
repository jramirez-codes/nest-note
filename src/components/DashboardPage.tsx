import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import {
  Bell,
  BellRing,
  ChevronDown,
  Check,
  Clock,
  Folder,
  GitMerge,
  Inbox,
  Layers,
  Lightbulb,
  ListChecks,
  PenLine,
  Search,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react-native';
import { useTheme, type ThemeColors } from '../theme/colors';
import { mocha } from '../theme/catppuccin';
import type { CardDragShared } from './cardDrag';
import {
  applyDashboardAction,
  completeCard,
  dismissCard,
  fetchDashboardState,
  type DashboardCard,
  type DashboardState,
  type DashboardSuggestion,
} from '../server/aiController';

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

// --- Card sorting + presentation -------------------------------------------

// Priority ranks so a higher-urgency card sorts first. Unknown strings fall to
// the middle (normal) so a novel priority never crashes the sort.
const PRIORITY_RANK: Record<string, number> = { urgent: 3, high: 2, normal: 1, low: 0 };
const rankOf = (p: string) => PRIORITY_RANK[p] ?? 1;

// Each priority carries its own hue (for icons/pips) drawn from the raw Catppuccin
// palette, plus matching NativeWind classes so we never inline a style for it.
interface PriorityStyle {
  hex: string;
  pip: string;
  chip: string;
  label: string;
}
const PRIORITY: Record<string, PriorityStyle> = {
  urgent: { hex: mocha.red, pip: 'bg-red', chip: 'bg-red/20', label: 'Urgent' },
  high: { hex: mocha.peach, pip: 'bg-peach', chip: 'bg-peach/20', label: 'High' },
  normal: { hex: mocha.blue, pip: 'bg-blue', chip: 'bg-blue/20', label: 'Normal' },
  low: { hex: mocha.overlay0, pip: 'bg-overlay0', chip: 'bg-overlay0/30', label: 'Low' },
};
const prio = (p: string): PriorityStyle => PRIORITY[p] ?? PRIORITY.normal;

// The stable card sort key the spec calls for: priority rank desc, then soonest
// `date` asc (dated cards ahead of undated), then `created_at` asc as a tiebreak.
function compareCards(a: DashboardCard, b: DashboardCard): number {
  const pr = rankOf(b.priority) - rankOf(a.priority);
  if (pr) return pr;
  const ad = a.date || '';
  const bd = b.date || '';
  if (ad && bd && ad !== bd) return ad < bd ? -1 : 1;
  if (ad && !bd) return -1;
  if (!ad && bd) return 1;
  const ac = a.created_at || '';
  const bc = b.created_at || '';
  return ac < bc ? -1 : ac > bc ? 1 : 0;
}

// Tasks sort like everything else but completed ones sink to the bottom.
function compareTasks(a: DashboardCard, b: DashboardCard): number {
  if (!!a.done !== !!b.done) return a.done ? 1 : -1;
  return compareCards(a, b);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Format an ISO `YYYY-MM-DD` relatively (Today / Tomorrow / Yesterday / "Jul 9"),
// and report whether it's in the past so a task can flag itself overdue.
function relDate(iso: string): { label: string; overdue: boolean } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return { label: iso, overdue: false };
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (days === 0) return { label: 'Today', overdue: false };
  if (days === 1) return { label: 'Tomorrow', overdue: false };
  if (days === -1) return { label: 'Yesterday', overdue: true };
  const label =
    `${MONTHS[d.getMonth()]} ${d.getDate()}` +
    (d.getFullYear() !== today.getFullYear() ? `, ${d.getFullYear()}` : '');
  return { label, overdue: days < 0 };
}

// Title-case a kind slug into a section heading, e.g. "reading-list" → "Reading
// lists". Keeps unknown kinds presentable without any bespoke code.
function humanizeKind(kind: string): string {
  const words = kind.replace(/[-_]+/g, ' ').trim();
  if (!words) return 'Cards';
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return titled.endsWith('s') ? titled : titled + 's';
}

// --- Notebook switcher -----------------------------------------------------

// One entry in the notebook picker. `key` is 'all' (the roll-up), 'sandbox' (the
// single local pad), or a subject slug. Counts are the open tasks + notifications
// that notebook owns, shown inline so the list itself reads as a map of the world.
interface NotebookOption {
  key: string;
  label: string;
  summary?: string;
  kind: 'all' | 'local' | 'server';
  tasks: number;
  notifs: number;
}

const nbIcon = (kind: NotebookOption['kind']): LucideIcon =>
  kind === 'all' ? Layers : kind === 'local' ? PenLine : Folder;

// A one-line summary of what a notebook holds, e.g. "2 tasks · 1 alert", falling
// back to the subject's own summary (or a hint for the special entries).
function nbSubtitle(o: NotebookOption): string {
  const parts: string[] = [];
  if (o.tasks) parts.push(`${o.tasks} task${o.tasks === 1 ? '' : 's'}`);
  if (o.notifs) parts.push(`${o.notifs} alert${o.notifs === 1 ? '' : 's'}`);
  if (parts.length) return parts.join(' · ');
  if (o.kind === 'local') return 'Local scratch pad';
  if (o.kind === 'all') return 'Everything filed';
  return o.summary || 'No open items';
}

// Renders a label with the typed query substring highlighted in the accent color,
// so the autocomplete visibly matches what the user typed.
function HighlightedLabel({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) {
    return (
      <Text className="text-sm font-semibold text-text" numberOfLines={1}>
        {text}
      </Text>
    );
  }
  return (
    <Text className="text-sm font-semibold text-text" numberOfLines={1}>
      {text.slice(0, i)}
      <Text className="text-accent">{text.slice(i, i + q.length)}</Text>
      {text.slice(i + q.length)}
    </Text>
  );
}

/**
 * The notebook picker pinned to the top of the dashboard: a tap-to-open control
 * showing the current notebook, and a dropdown with a search field that
 * autocompletes the notebook list as the user types. The dropdown is anchored
 * under the trigger (measured in window coords) inside a transparent Modal, so it
 * floats cleanly over the scrolling content and gets native keyboard handling.
 */
function NotebookSwitcher({
  options,
  selected,
  onSelect,
  colors,
}: {
  options: NotebookOption[];
  selected: NotebookOption;
  onSelect: (key: string) => void;
  colors: ThemeColors;
}) {
  const triggerRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [anchor, setAnchor] = useState({ x: 0, y: 0, width: 0, height: 0 });

  const openMenu = useCallback(() => {
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
      setQuery('');
      setOpen(true);
    });
  }, []);
  const close = useCallback(() => setOpen(false), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const TriggerIcon = nbIcon(selected.kind);

  return (
    <>
      <Pressable
        ref={triggerRef}
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel={`Notebook: ${selected.label}`}
        className="flex-row items-center rounded-2xl border border-surface1 bg-surface px-3.5 py-3 active:opacity-80">
        <View className="mr-3 h-9 w-9 items-center justify-center rounded-xl bg-accent/20">
          <TriggerIcon size={18} color={colors.accent} strokeWidth={2} />
        </View>
        <View className="flex-1 pr-2">
          <Text className="text-base font-bold text-text" numberOfLines={1}>
            {selected.label}
          </Text>
          <Text className="mt-0.5 text-xs text-muted" numberOfLines={1}>
            {nbSubtitle(selected)}
          </Text>
        </View>
        <ChevronDown size={20} color={colors.faint} strokeWidth={2} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
        {/* Full-screen scrim: a tap anywhere outside the card dismisses the menu. */}
        <Pressable className="flex-1" style={{ backgroundColor: 'rgba(0,0,0,0.45)' }} onPress={close}>
          <View
            style={{
              position: 'absolute',
              top: anchor.y + anchor.height + 6,
              left: anchor.x,
              width: anchor.width,
            }}>
            {/* Inner Pressable swallows taps so they don't reach the scrim. */}
            <Pressable
              onPress={() => {}}
              className="overflow-hidden rounded-2xl border border-surface1 bg-surface">
              {/* Search field. */}
              <View className="flex-row items-center gap-2 border-b border-surface1 px-3 py-2.5">
                <Search size={16} color={colors.faint} strokeWidth={2} />
                <TextInput
                  autoFocus
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search notebooks…"
                  placeholderTextColor={colors.faint}
                  className="flex-1 p-0 text-sm text-text"
                  returnKeyType="done"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <ScrollView
                keyboardShouldPersistTaps="handled"
                style={{ maxHeight: 320 }}
                contentContainerStyle={{ paddingVertical: 4 }}>
                {filtered.length === 0 ? (
                  <Text className="px-3 py-4 text-center text-sm text-muted">No notebooks match.</Text>
                ) : (
                  filtered.map(o => {
                    const RowIcon = nbIcon(o.kind);
                    const isSel = o.key === selected.key;
                    return (
                      <Pressable
                        key={o.key}
                        onPress={() => {
                          onSelect(o.key);
                          close();
                        }}
                        className="flex-row items-center px-2.5 py-2.5 active:bg-surface1/50">
                        <View className="mr-3 h-8 w-8 items-center justify-center rounded-lg bg-background">
                          <RowIcon size={16} color={isSel ? colors.accent : colors.muted} strokeWidth={2} />
                        </View>
                        <View className="flex-1 pr-2">
                          <HighlightedLabel text={o.label} query={query} />
                          <Text className="mt-0.5 text-xs text-muted" numberOfLines={1}>
                            {nbSubtitle(o)}
                          </Text>
                        </View>
                        {o.kind === 'local' && (
                          <View className="mr-2 rounded-full bg-overlay0/30 px-2 py-0.5">
                            <Text className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                              Local
                            </Text>
                          </View>
                        )}
                        {isSel && <Check size={16} color={colors.accent} strokeWidth={2.5} />}
                      </Pressable>
                    );
                  })
                )}
              </ScrollView>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

/**
 * The dashboard: the trailing page of the pad. It's the home for the MCP world
 * `/ingest` builds up — its reminders and action items, each subject's notes, and
 * any merge suggestions — laid out as a Material-style action center. Cards are
 * removed by pressing and holding, then dragging them up onto the header, which
 * turns into a delete target, so a delete is always deliberate.
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
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Keys (suggestion 'into' or card id) currently being acted on, to disable their
  // controls while the write is in flight.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // The card currently lifted, kept locally so only this page dims its source row
  // (the screen tracks its own copy for the floating clone).
  const [liftedId, setLiftedId] = useState<string | null>(null);

  // Guard against setState after unmount / after a newer fetch superseded this one.
  const reqSeq = useRef(0);

  const load = useCallback(async (mode: 'initial' | 'refresh') => {
    const seq = ++reqSeq.current;
    if (mode === 'refresh') setRefreshing(true);
    else setLoading(true);
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

  // Fetch on mount and whenever the page is flipped to (so ingesting a page and
  // swiping here shows the freshly filed notes). Skip while already loading.
  const wasActive = useRef(false);
  useEffect(() => {
    if (isActive && !wasActive.current) load(state ? 'refresh' : 'initial');
    wasActive.current = isActive;
  }, [isActive, load, state]);
  useEffect(() => {
    load('initial');
    return () => {
      reqSeq.current++; // invalidate any in-flight fetch on unmount
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

  // The notebook picker's entries: the Sandbox (the local pad, which also rolls up every
  // notebook's cards + alerts), then one per subject server, each tagged with its own
  // open-task / notification counts (a card belongs to a notebook via its `source` slug).
  const nbOptions = useMemo<NotebookOption[]>(() => {
    const countFor = (name: string) => {
      let tasks = 0;
      let notifs = 0;
      for (const c of allCards) {
        if (c.source !== name) continue;
        if (c.kind === 'task') {
          if (!c.done) tasks++;
        } else if (c.kind === 'notification') notifs++;
      }
      return { tasks, notifs };
    };
    const opts: NotebookOption[] = [
      {
        key: 'sandbox',
        label: 'Sandbox',
        kind: 'local',
        tasks: allCards.filter(c => c.kind === 'task' && !c.done).length,
        notifs: allCards.filter(c => c.kind === 'notification').length,
      },
    ];
    for (const s of allServers) {
      const { tasks, notifs } = countFor(s.name);
      opts.push({ key: s.name, label: s.title || s.name, summary: s.summary, kind: 'server', tasks, notifs });
    }
    return opts;
  }, [allCards, allServers]);

  // The chosen notebook, falling back to the Sandbox if the selection vanished (e.g. its
  // subject was merged away since it was picked).
  const selected = nbOptions.find(o => o.key === selectedNb) ?? nbOptions[0];
  // The Sandbox is the aggregate view: every notebook's cards plus all merge suggestions.
  // A subject shows only its own cards (its notes live in the pad's pages, not here).
  const isSandbox = selected.key === 'sandbox';

  const cards = isSandbox ? allCards : allCards.filter(c => c.source === selected.key);
  const suggestions = isSandbox ? allSuggestions : [];

  // Split cards into their sections. Tasks and notifications are first-class; every
  // other kind is grouped by kind and rendered through the generic idea-card grid,
  // so a brand-new kind appears immediately with no code change here.
  const tasks = cards.filter(c => c.kind === 'task').sort(compareTasks);
  const notifications = cards.filter(c => c.kind === 'notification').sort(compareCards);
  const otherKinds: Record<string, DashboardCard[]> = {};
  for (const c of cards) {
    if (c.kind === 'task' || c.kind === 'notification') continue;
    (otherKinds[c.kind] ??= []).push(c);
  }
  const otherKindNames = Object.keys(otherKinds).sort();

  const openTaskCount = tasks.filter(t => !t.done).length;
  const nothingAtAll = cards.length === 0 && suggestions.length === 0;

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
        contentContainerStyle={{ padding: 20, paddingBottom: 120 }}
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

            {/* Notifications first — the alerts the user should see on arrival. */}
            {notifications.length > 0 && (
              <View className="mb-6">
                <SectionHeader
                  icon={Bell}
                  title="Notifications"
                  count={notifications.length}
                  colors={colors}
                />
                {notifications.map(card => (
                  <DraggableCard key={card.id} card={card} {...dragProps}>
                    <NotificationCard card={card} dimmed={liftedId === card.id} />
                  </DraggableCard>
                ))}
              </View>
            )}

            {/* Tasks — one high-density surface with hairline dividers. */}
            {tasks.length > 0 && (
              <View className="mb-6">
                <SectionHeader icon={ListChecks} title="Tasks" count={openTaskCount} colors={colors} />
                <View className="overflow-hidden rounded-2xl border border-surface1 bg-surface">
                  {tasks.map((card, i) => (
                    <View key={card.id}>
                      {i > 0 && <View className="ml-11 h-px bg-surface1/60" />}
                      <DraggableCard card={card} {...dragProps}>
                        <TaskRow
                          card={card}
                          colors={colors}
                          busy={busy}
                          onToggle={onToggle}
                          dimmed={liftedId === card.id}
                        />
                      </DraggableCard>
                    </View>
                  ))}
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

// Wraps a card in a long-press pan gesture: hold ~220ms to lift it, drag up onto
// the header (which turns into the delete target, tracked by comparing the finger's
// window-Y to the header's bottom edge), and release there to dismiss. A quick tap
// still reaches the card's own controls.
function DraggableCard({
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
function SectionHeader({
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
// title (struck through when done), a priority pip, and a due date (red when overdue).
function TaskRow({
  card,
  colors,
  busy,
  onToggle,
  dimmed,
}: {
  card: DashboardCard;
  colors: ThemeColors;
  busy: Record<string, boolean>;
  onToggle: (c: DashboardCard) => void;
  dimmed: boolean;
}) {
  const due = card.date ? relDate(card.date) : null;
  const overdue = !!due?.overdue && !card.done;
  return (
    // collapsable={false} keeps Android from view-flattening this node away, which
    // the wrapping GestureDetector needs to attach the drag gesture reliably.
    <View collapsable={false} className={`flex-row items-center px-3 py-3 ${dimmed ? 'opacity-30' : ''}`}>
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
        onPress={() => onToggle(card)}
        disabled={busy[card.id]}
        className="flex-1 flex-row items-center pl-3 pr-2">
        <View className={`mr-2 h-1.5 w-1.5 rounded-full ${prio(card.priority).pip}`} />
        <Text
          numberOfLines={1}
          className={`flex-1 text-sm ${card.done ? 'text-faint line-through' : 'text-text'}`}>
          {card.title}
        </Text>
      </Pressable>
      {due && !card.done && (
        <View className="flex-row items-center gap-1">
          <Clock size={12} color={overdue ? colors.danger : colors.muted} strokeWidth={2} />
          <Text className={`text-xs ${overdue ? 'text-danger' : 'text-muted'}`}>{due.label}</Text>
        </View>
      )}
    </View>
  );
}

// The icon for a notification chip, chosen by urgency.
function notifIcon(priority: string): LucideIcon {
  switch (priority) {
    case 'urgent':
      return TriangleAlert;
    case 'high':
      return BellRing;
    case 'low':
      return Clock;
    default:
      return Bell;
  }
}

// A notification: a tinted icon chip (colored by priority), a title, and a subtitle
// combining its date and body.
function NotificationCard({ card, dimmed }: { card: DashboardCard; dimmed: boolean }) {
  const p = prio(card.priority);
  const NotifIcon = notifIcon(card.priority);
  const date = card.date ? relDate(card.date).label : '';
  const subtitle = [date, card.body].filter(Boolean).join(' · ');
  return (
    <View
      collapsable={false}
      className={`mb-2 flex-row items-center rounded-2xl border border-surface1 bg-surface p-3 ${
        dimmed ? 'opacity-30' : ''
      }`}>
      <View className={`mr-3 h-10 w-10 items-center justify-center rounded-xl ${p.chip}`}>
        <NotifIcon size={20} color={p.hex} strokeWidth={2} />
      </View>
      <View className="flex-1 pr-1">
        <Text className="text-sm font-semibold text-text" numberOfLines={1}>
          {card.title}
        </Text>
        {!!subtitle && (
          <Text className="mt-0.5 text-xs text-muted" numberOfLines={2}>
            {subtitle}
          </Text>
        )}
      </View>
    </View>
  );
}

// The generic card, used for ideas and — as the graceful fallback — any unknown
// kind. A compact grid tile with a colored top accent bar, a kind glyph, and the
// title. This is what makes the engine scalable: emit a novel kind and it renders.
function IdeaCard({ card, dimmed }: { card: DashboardCard; dimmed: boolean }) {
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

export default React.memo(DashboardPage);
