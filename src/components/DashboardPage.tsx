import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useTheme } from '../theme/colors';
import {
  applyDashboardAction,
  fetchDashboardState,
  type DashboardServer,
  type DashboardState,
  type DashboardSuggestion,
} from '../server/aiController';

interface DashboardPageProps {
  /** Exact page width so the sheet fills its slot in the pager. */
  width: number;
  /** True when this is the page on top — used to refresh state when flipped to. */
  isActive: boolean;
  /** Create a fresh note and flip to it (shared with the old +New affordance). */
  onCreateNote: () => void;
}

// Strip the trailing `<!-- 2026-07-04 12:00 -->` timestamps the notes servers add,
// so a subject's notes read cleanly in the dashboard.
function cleanNotes(md: string): string {
  return md
    .replace(/\s*<!--[^>]*-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The dashboard: the trailing page of the pad (where the "new note" sheet used to
 * be). It's the home for the MCP world `/ingest` builds up — create a note, browse
 * each subject server and its notes, and clear any optional merge suggestions.
 */
function DashboardPage({ width, isActive, onCreateNote }: DashboardPageProps) {
  const colors = useTheme();
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Suggestion keys ('into') currently being acted on, to disable their buttons.
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

  const servers = state?.servers ?? [];
  const suggestions = state?.suggestions ?? [];

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
        <Text className="mb-1 text-2xl font-bold text-text">Dashboard</Text>
        <Text className="mb-5 text-sm text-faint">
          Your notes, sorted into subjects by <Text className="text-muted">/ingest</Text>.
        </Text>

        {/* New note — the create affordance that used to be the trailing sheet. */}
        <Pressable
          onPress={onCreateNote}
          accessibilityRole="button"
          accessibilityLabel="Add a new note"
          className="mb-6 flex-row items-center justify-center rounded-2xl bg-accent py-3.5 active:opacity-80">
          <Text className="text-lg font-bold leading-none text-background">＋</Text>
          <Text className="ml-2 text-base font-semibold text-background">New note</Text>
        </Pressable>

        {/* Optional yes/no questions from ingest — merge suggestions. */}
        {suggestions.length > 0 && (
          <View className="mb-6">
            <Text className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">
              Suggestions
            </Text>
            {suggestions.map(s => (
              <View
                key={s.into}
                className="mb-2 rounded-xl border border-border bg-surface p-3">
                <Text className="text-sm text-text">
                  Merge{' '}
                  <Text className="font-semibold text-text">{s.from.join(', ')}</Text> into{' '}
                  <Text className="font-semibold text-text">{s.into}</Text>?
                </Text>
                {!!s.reason && (
                  <Text className="mt-1 text-xs text-muted">{s.reason}</Text>
                )}
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

        <Text className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">
          Subjects{servers.length > 0 ? ` · ${servers.length}` : ''}
        </Text>

        {loading && !state ? (
          <View className="items-center py-10">
            <ActivityIndicator color={colors.muted} />
          </View>
        ) : error ? (
          <View className="rounded-xl border border-border bg-surface p-4">
            <Text className="text-sm text-danger">{error}</Text>
            <Pressable
              onPress={() => load('initial')}
              className="mt-3 self-start rounded-lg bg-background px-4 py-2 active:opacity-70">
              <Text className="text-sm font-semibold text-muted">Retry</Text>
            </Pressable>
          </View>
        ) : servers.length === 0 ? (
          <View className="rounded-xl border border-border bg-surface p-4">
            <Text className="text-sm text-muted">
              No subjects yet. Write some notes, then run{' '}
              <Text className="text-text">/ingest</Text> on the page to sort them here.
            </Text>
          </View>
        ) : (
          servers.map(srv => (
            <ServerCard
              key={srv.name}
              server={srv}
              expanded={expanded === srv.name}
              onToggle={() =>
                setExpanded(cur => (cur === srv.name ? null : srv.name))
              }
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

// One subject server: a tappable header (name + summary) that expands to reveal
// its notes markdown. Kept as its own component so only the toggled card re-renders.
function ServerCard({
  server,
  expanded,
  onToggle,
}: {
  server: DashboardServer;
  expanded: boolean;
  onToggle: () => void;
}) {
  const notes = cleanNotes(server.notes || '');
  return (
    <View className="mb-2 overflow-hidden rounded-xl border border-border bg-surface">
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        className="flex-row items-center p-3 active:opacity-70">
        <View className="flex-1 pr-2">
          <Text className="text-base font-semibold text-text">{server.name}</Text>
          {!!server.summary && (
            <Text className="mt-0.5 text-xs text-muted" numberOfLines={expanded ? undefined : 1}>
              {server.summary}
            </Text>
          )}
        </View>
        <Text className="text-faint">{expanded ? '▾' : '▸'}</Text>
      </Pressable>
      {expanded && (
        <View className="border-t border-border px-3 py-3">
          <Text className="text-sm leading-5 text-text">
            {notes || 'No notes yet.'}
          </Text>
        </View>
      )}
    </View>
  );
}

export default React.memo(DashboardPage);
