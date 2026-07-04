import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import {
  Bell,
  BellRing,
  ChevronDown,
  ChevronRight,
  Check,
  Clock,
  Folder,
  GitMerge,
  Inbox,
  Lightbulb,
  ListChecks,
  Sparkles,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import { useTheme, type ThemeColors } from '../theme/colors';
import { mocha } from '../theme/catppuccin';
import {
  applyDashboardAction,
  completeCard,
  dismissCard,
  fetchDashboardState,
  type DashboardCard,
  type DashboardServer,
  type DashboardState,
  type DashboardSuggestion,
} from '../server/aiController';

interface DashboardPageProps {
  /** Exact page width so the sheet fills its slot in the pager. */
  width: number;
  /** True when this is the page on top — used to refresh state when flipped to. */
  isActive: boolean;
}

// Strip the trailing `<!-- 2026-07-04 12:00 -->` timestamps the notes servers add,
// so a subject's notes read cleanly in the dashboard.
function cleanNotes(md: string): string {
  return md
    .replace(/\s*<!--[^>]*-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

/**
 * The dashboard: the trailing page of the pad. It's the home for the MCP world
 * `/ingest` builds up — its action items and reminders, each subject's notes, and
 * any merge suggestions — laid out as a Material-style action center.
 */
function DashboardPage({ width, isActive }: DashboardPageProps) {
  const colors = useTheme();
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Keys (suggestion 'into' or card id) currently being acted on, to disable their
  // controls while the write is in flight.
  const [busy, setBusy] = useState<Record<string, boolean>>({});

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
      await completeCard(card.id, next);
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
      await dismissCard(card.id);
    } catch (e) {
      setState(prev => (prev ? { ...prev, cards: [...prev.cards, card] } : prev));
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(b => ({ ...b, [card.id]: false }));
    }
  }, []);

  const servers = state?.servers ?? [];
  const suggestions = state?.suggestions ?? [];
  const cards = state?.cards ?? [];

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
  const pending = openTaskCount + notifications.length;
  const nothingAtAll =
    cards.length === 0 && servers.length === 0 && suggestions.length === 0;

  const cardActions: CardActions = { colors, busy, onToggle, onDismiss };

  return (
    <View style={{ width }} className="flex-1 bg-background">
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 120 }}
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

            {/* Tasks — one high-density surface with hairline dividers. */}
            {tasks.length > 0 && (
              <View className="mb-6">
                <SectionHeader icon={ListChecks} title="Tasks" count={openTaskCount} colors={colors} />
                <View className="overflow-hidden rounded-2xl border border-surface1 bg-surface">
                  {tasks.map((card, i) => (
                    <View key={card.id}>
                      {i > 0 && <View className="ml-11 h-px bg-surface1/60" />}
                      <TaskRow card={card} {...cardActions} />
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Notifications — insight rows with a tinted icon chip. */}
            {notifications.length > 0 && (
              <View className="mb-6">
                <SectionHeader
                  icon={Bell}
                  title="Notifications"
                  count={notifications.length}
                  colors={colors}
                />
                {notifications.map(card => (
                  <NotificationCard key={card.id} card={card} {...cardActions} />
                ))}
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
                      <IdeaCard key={card.id} card={card} {...cardActions} />
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

            {/* Subjects — the per-topic notes stores /ingest builds up. */}
            {servers.length > 0 && (
              <View className="mb-6">
                <SectionHeader icon={Folder} title="Subjects" count={servers.length} colors={colors} />
                {servers.map(srv => (
                  <ServerCard
                    key={srv.name}
                    server={srv}
                    colors={colors}
                    expanded={expanded === srv.name}
                    onToggle={() => setExpanded(cur => (cur === srv.name ? null : srv.name))}
                  />
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
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

// The shared props every card renderer receives.
interface CardActions {
  colors: ThemeColors;
  busy: Record<string, boolean>;
  onToggle: (c: DashboardCard) => void;
  onDismiss: (c: DashboardCard) => void;
}

// A small circular dismiss (✕) affordance shared by the card renderers.
function DismissButton({
  card,
  busy,
  onDismiss,
  colors,
}: {
  card: DashboardCard;
  busy: boolean;
  onDismiss: (c: DashboardCard) => void;
  colors: ThemeColors;
}) {
  return (
    <Pressable
      onPress={() => onDismiss(card)}
      disabled={busy}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={`Dismiss ${card.title}`}
      className="p-1 active:opacity-60">
      <X size={16} color={colors.faint} strokeWidth={2} />
    </Pressable>
  );
}

// One task row inside the grouped Tasks surface: a checkbox that toggles done, the
// title (struck through when done), a priority pip, a due date (red when overdue),
// and a dismiss ✕.
function TaskRow({ card, colors, busy, onToggle, onDismiss }: { card: DashboardCard } & CardActions) {
  const due = card.date ? relDate(card.date) : null;
  const overdue = !!due?.overdue && !card.done;
  return (
    <View className="flex-row items-center px-3 py-3">
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
        <View className="mr-1 flex-row items-center gap-1">
          <Clock size={12} color={overdue ? colors.danger : colors.muted} strokeWidth={2} />
          <Text className={`text-xs ${overdue ? 'text-danger' : 'text-muted'}`}>{due.label}</Text>
        </View>
      )}
      <DismissButton card={card} busy={busy[card.id]} onDismiss={onDismiss} colors={colors} />
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

// A notification: a tinted icon chip (colored by priority), a title, a subtitle
// combining its date and body, and a dismiss ✕.
function NotificationCard({ card, colors, busy, onDismiss }: { card: DashboardCard } & CardActions) {
  const p = prio(card.priority);
  const NotifIcon = notifIcon(card.priority);
  const date = card.date ? relDate(card.date).label : '';
  const subtitle = [date, card.body].filter(Boolean).join(' · ');
  return (
    <View className="mb-2 flex-row items-center rounded-2xl border border-surface1 bg-surface p-3">
      <View className={`mr-3 h-10 w-10 items-center justify-center rounded-xl ${p.chip}`}>
        <NotifIcon size={20} color={p.hex} strokeWidth={2} />
      </View>
      <View className="flex-1 pr-2">
        <Text className="text-sm font-semibold text-text" numberOfLines={1}>
          {card.title}
        </Text>
        {!!subtitle && (
          <Text className="mt-0.5 text-xs text-muted" numberOfLines={2}>
            {subtitle}
          </Text>
        )}
      </View>
      <DismissButton card={card} busy={busy[card.id]} onDismiss={onDismiss} colors={colors} />
    </View>
  );
}

// The generic card, used for ideas and — as the graceful fallback — any unknown
// kind. A compact grid tile with a colored top accent bar, a kind glyph, and the
// title. This is what makes the engine scalable: emit a novel kind and it renders.
function IdeaCard({ card, colors, busy, onDismiss }: { card: DashboardCard } & CardActions) {
  const p = prio(card.priority);
  const KindIcon = card.kind === 'idea' ? Lightbulb : Sparkles;
  return (
    <View className="mb-3 w-[48%] overflow-hidden rounded-2xl border border-surface1 bg-surface p-3">
      <View className={`absolute left-0 right-0 top-0 h-1 ${p.pip}`} />
      <View className="mt-1 flex-row items-center justify-between">
        <KindIcon size={16} color={p.hex} strokeWidth={2} />
        <DismissButton card={card} busy={busy[card.id]} onDismiss={onDismiss} colors={colors} />
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

// One subject server: a tappable header (folder icon + name + summary) that expands
// to reveal its notes markdown. Its own component so only the toggled card re-renders.
function ServerCard({
  server,
  colors,
  expanded,
  onToggle,
}: {
  server: DashboardServer;
  colors: ThemeColors;
  expanded: boolean;
  onToggle: () => void;
}) {
  const notes = cleanNotes(server.notes || '');
  return (
    <View className="mb-2 overflow-hidden rounded-2xl border border-surface1 bg-surface">
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        className="flex-row items-center p-3 active:opacity-70">
        <View className="mr-3 h-9 w-9 items-center justify-center rounded-xl bg-accent/20">
          <Folder size={18} color={colors.accent} strokeWidth={2} />
        </View>
        <View className="flex-1 pr-2">
          <Text className="text-base font-semibold text-text">{server.name}</Text>
          {!!server.summary && (
            <Text className="mt-0.5 text-xs text-muted" numberOfLines={expanded ? undefined : 1}>
              {server.summary}
            </Text>
          )}
        </View>
        {expanded ? (
          <ChevronDown size={20} color={colors.faint} strokeWidth={2} />
        ) : (
          <ChevronRight size={20} color={colors.faint} strokeWidth={2} />
        )}
      </Pressable>
      {expanded && (
        <View className="border-t border-surface1 px-3 py-3">
          <Text className="text-sm leading-5 text-text">{notes || 'No notes yet.'}</Text>
        </View>
      )}
    </View>
  );
}

export default React.memo(DashboardPage);
