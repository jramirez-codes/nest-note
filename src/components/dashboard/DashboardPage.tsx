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
import { type DashboardView } from './DashboardViewToggle';
import TasksSection from './sections/TasksSection';
import ArchivedSection from './sections/ArchivedSection';
import CardListSection from './sections/CardListSection';
import SuggestionsSection from './sections/SuggestionsSection';
import ReorgSection from './sections/ReorgSection';
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
  /** Which half of the dashboard to show — 'organize' (tasks, archive, decisions) or
   *  'ideas' (idea cards and their build steps). Owned by the screen, since the
   *  toggle that swaps it sits in the header above this page. */
  view: DashboardView;
  /** The local pad's archived pages (from `/archive`), shown in the Sandbox dashboard's
   *  Archived section. Owned by the screen so it can open one as a temporary page. */
  archivedPages: Note[];
  /** Open an archived page as a temporary, editable page. */
  onOpenArchived: (note: Note) => void;
  /** Open a card (an idea) as a full read-only page. */
  onOpenIdea: (card: DashboardCard) => void;
  /** Bumped when a card changed elsewhere (an idea page's chat rewrote one), so this
   *  page re-reads rather than keeping the copy it last fetched. */
  cardsVersion: number;
}

// The generic list's sections, in the order they sit on the page. Ideas lead:
// they're the thing you read and edit, while a build step is the follow-up an
// idea already spawned, so it belongs under the ideas it came from. Kinds not
// named here fall in alphabetically behind these, keeping the "a new kind needs
// no code change" property of the list.
const KIND_ORDER = ['idea', 'build-step'];

function compareKinds(a: string, b: string): number {
  const ia = KIND_ORDER.indexOf(a);
  const ib = KIND_ORDER.indexOf(b);
  if (ia === ib) return a.localeCompare(b);
  return (ia < 0 ? KIND_ORDER.length : ia) - (ib < 0 ? KIND_ORDER.length : ib);
}

/**
 * The dashboard: the trailing page of the pad. It's the home for the MCP world
 * `/ingest` builds up — its reminders and action items, each subject's notes, and
 * any merge suggestions — laid out as a Material-style action center. Cards are
 * removed by pressing and holding, then dragging them up onto the header, which
 * turns into a delete target, so a delete is always deliberate.
 *
 * The page shows one of two views at a time, picked by the header's bubble toggle:
 * **Organize** — tasks, the archive, and the filing decisions (reorg proposals and
 * merge suggestions) — and **Ideas** — idea cards and the build steps they spawn.
 *
 * This component is the orchestrator: it owns the data layer and the drag/lift
 * plumbing, filters the cards down to the selected notebook, and splits them into
 * sections. Each section (./sections/*) owns its own view state — pagination, sort,
 * search — the card renderers live in ./DashboardCards, and the sorting/formatting
 * rules in ./cardModel. Both the notebook and the view are swapped from the header
 * (this page just reads `selectedNb` and `view`).
 */
function DashboardPage({
  width,
  isActive,
  dragShared,
  onLift,
  onRelease,
  selectedNb,
  view,
  archivedPages,
  onOpenArchived,
  onOpenIdea,
  cardsVersion,
}: DashboardPageProps) {
  const colors = useTheme();
  const { state, error, loading, refreshing, busy, load, act, actReorg, onToggle, onDismiss } =
    useDashboardData(isActive, cardsVersion);
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
  const allReorgs = state?.reorgs ?? [];

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
  // the kind was retired) are hidden here rather than falling into the generic list.
  const cards = (isSandbox ? allCards : allCards.filter(c => c.source === selected.key)).filter(
    c => c.kind !== 'notification',
  );
  const suggestions = isSandbox ? allSuggestions : [];
  // Reorg proposals show in the Sandbox aggregate and inside their own notebook's view.
  const reorgs = isSandbox ? allReorgs : allReorgs.filter(r => r.subject === selected.key);

  // Split cards into their sections. Tasks are first-class; every other kind is
  // grouped by kind and rendered through the generic list, so a brand-new kind
  // appears immediately with no code change here.
  const tasks = cards.filter(c => c.kind === 'task');
  const otherKinds: Record<string, DashboardCard[]> = {};
  for (const c of cards) {
    if (c.kind === 'task') continue;
    (otherKinds[c.kind] ??= []).push(c);
  }
  const otherKindNames = Object.keys(otherKinds).sort(compareKinds);

  // Archived pages are a local-pad concept, so they only surface on the Sandbox
  // dashboard (subjects have no local pages of their own here).
  const showArchived = isSandbox && archivedPages.length > 0;

  // The two halves of the page (see DashboardViewToggle). Organize is the named,
  // finite set — the things you work through and file. Ideas is the generic list,
  // so an unrecognized kind lands there rather than in Organize: the list renders
  // any kind with no code change, while every Organize section is a bespoke view of
  // a specific shape, and a new kind is far likelier to be idea-shaped material than
  // a new kind of decision.
  const organizing = view === 'organize';
  const showingIdeas = view === 'ideas';
  const nothingHere = organizing
    ? tasks.length === 0 && !showArchived && reorgs.length === 0 && suggestions.length === 0
    : otherKindNames.length === 0;

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

            {nothingHere && <EmptyState view={view} colors={colors} />}

            {organizing && tasks.length > 0 && (
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

            {/* Archived — pages lifted off the pad by /archive. Below Tasks; Sandbox only. */}
            {organizing && showArchived && (
              <ArchivedSection
                archivedPages={archivedPages}
                onOpenArchived={onOpenArchived}
                colors={colors}
              />
            )}

            {/* Ideas, build steps, and any future kind: grouped by kind, each group
                a paged, fixed-height row list (the generic card list). */}
            {showingIdeas &&
              otherKindNames.map(kind => (
                <CardListSection
                  key={kind}
                  kind={kind}
                  cards={otherKinds[kind]}
                  dragProps={dragProps}
                  liftedId={liftedId}
                  colors={colors}
                  onOpenIdea={onOpenIdea}
                />
              ))}

            {/* The decisions — reorg proposals and merge suggestions are both
                "how should this be filed?", so they close out the Organize view. */}
            {organizing && reorgs.length > 0 && (
              <ReorgSection
                reorgs={reorgs}
                busy={busy}
                act={actReorg}
                titleFor={subjectTitleFor}
                colors={colors}
              />
            )}

            {organizing && suggestions.length > 0 && (
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
