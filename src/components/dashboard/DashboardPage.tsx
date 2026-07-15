import React, { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme/colors';
import type { CardDragShared } from '../../hooks/useCardDrag';
import type { Note } from '../../types/note';
import { type DashboardCard } from '../../server/controllers/aiController';
import { useDashboardData } from './useDashboardData';
import { buildNotebookOptions } from './cardModel';
import { type NotebookOption } from './NotebookSwitcher';
import { type CardDragProps } from './DashboardCards';
import TasksSection from './sections/TasksSection';
import ArchivedSection from './sections/ArchivedSection';
import CardGridSection from './sections/CardGridSection';
import SuggestionsSection from './sections/SuggestionsSection';
import { EmptyState, ErrorState, InlineError, LoadingState } from './sections/DashboardStates';

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
  /** Open a card (an idea) as a full read-only page. */
  onOpenIdea: (card: DashboardCard) => void;
}

/**
 * The dashboard: the trailing page of the pad. It's the home for the MCP world
 * `/ingest` builds up — its reminders and action items, each subject's notes, and
 * any merge suggestions — laid out as a Material-style action center. Cards are
 * removed by pressing and holding, then dragging them up onto the header, which
 * turns into a delete target, so a delete is always deliberate.
 *
 * This component is the orchestrator: it owns the data layer and the drag/lift
 * plumbing, filters the cards down to the selected notebook, and splits them into
 * sections. Each section (./sections/*) owns its own view state — pagination, sort,
 * search — the card renderers live in ./DashboardCards, and the sorting/formatting
 * rules in ./cardModel. The notebook is swapped from the header switcher (this page
 * just reads `selectedNb` to filter).
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
  onOpenIdea,
}: DashboardPageProps) {
  const colors = useTheme();
  const { state, error, loading, refreshing, busy, load, act, onToggle, onDismiss } =
    useDashboardData(isActive);
  // The card currently lifted, kept locally so only this page dims its source row
  // (the screen tracks its own copy for the floating clone).
  const [liftedId, setLiftedId] = useState<string | null>(null);

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
  // grouped by kind and rendered through the generic grid, so a brand-new kind
  // appears immediately with no code change here.
  const tasks = cards.filter(c => c.kind === 'task');
  const otherKinds: Record<string, DashboardCard[]> = {};
  for (const c of cards) {
    if (c.kind === 'task') continue;
    (otherKinds[c.kind] ??= []).push(c);
  }
  const otherKindNames = Object.keys(otherKinds).sort();

  // Archived pages are a local-pad concept, so they only surface on the Sandbox
  // dashboard (subjects have no local pages of their own here).
  const showArchived = isSandbox && archivedPages.length > 0;
  const nothingAtAll = cards.length === 0 && suggestions.length === 0 && !showArchived;

  // The drag wiring handed to every draggable card / section, built once so the
  // memoized sections aren't re-rendered by a fresh object each time.
  const dragProps = useMemo<CardDragProps>(
    () => ({ drag: dragShared, onLift: handleLift, onDrop: onDismiss, onRelease: handleRelease }),
    [dragShared, handleLift, onDismiss, handleRelease],
  );

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
          <LoadingState colors={colors} />
        ) : error && !state ? (
          <ErrorState message={error} onRetry={() => load('initial')} />
        ) : (
          <>
            {/* A non-fatal error once data is on screen (e.g. an action failed). */}
            {error && <InlineError message={error} />}

            {nothingAtAll && <EmptyState colors={colors} />}

            {/* Archived — pages lifted off the pad by /archive. Above Tasks; Sandbox only. */}
            {showArchived && (
              <ArchivedSection
                archivedPages={archivedPages}
                onOpenArchived={onOpenArchived}
                colors={colors}
              />
            )}

            {tasks.length > 0 && (
              <TasksSection
                tasks={tasks}
                notebookKey={selected.key}
                colors={colors}
                busy={busy}
                onToggle={onToggle}
                dragProps={dragProps}
                liftedId={liftedId}
                subjectTitleFor={subjectTitleFor}
              />
            )}

            {/* Any future kind: grouped, rendered via the generic idea-card grid. */}
            {otherKindNames.map(kind => (
              <CardGridSection
                key={kind}
                kind={kind}
                cards={otherKinds[kind]}
                dragProps={dragProps}
                liftedId={liftedId}
                colors={colors}
                onOpenIdea={onOpenIdea}
              />
            ))}

            {suggestions.length > 0 && (
              <SuggestionsSection suggestions={suggestions} busy={busy} act={act} colors={colors} />
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
