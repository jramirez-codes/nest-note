import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, CircleStop, Hammer, Lightbulb, ListChecks, Undo2 } from 'lucide-react-native';
import { mocha } from '../../theme/catppuccin';
import { useTheme } from '../../theme/colors';
import { useKeyboardHeight } from '../../hooks/useKeyboardHeight';
import type { Note } from '../../types/note';
import { fetchCard, type DashboardCard } from '../../server/controllers/aiController';
import {
  buildIsLive,
  cardBuild,
  fetchBuild,
  planMarkdown,
  startBuild,
  stopBuild,
  type BuildInfo,
} from '../../server/controllers/buildApi';
import * as ideaChat from '../../server/ideaChat';
import { prio } from '../dashboard/cardModel';
import ConfirmDialog from '../modals/ConfirmDialog';
import CardComposer from './CardComposer';
import IdeaChatCard, { DEFAULT_CARD_HEIGHT, MIN_CARD_HEIGHT } from './IdeaChatCard';
import NotePage from './NotePage';

interface IdeaPageOverlayProps {
  /** The card (an idea) being viewed as a full page. */
  card: DashboardCard;
  /** Exact page width so the editor fills the sheet. */
  width: number;
  /** Close the page and return to the dashboard. */
  onClose: () => void;
  /** Whether the speech-to-text session is live (owned by the screen). */
  dictating: boolean;
  /** Ask the screen to start/stop that session for the chat composer. */
  onDictate: (on: boolean) => void;
  /** Claude edited this card; hand back the re-read copy so the page — and the
   *  dashboard behind it — show the new body rather than the one opened with. */
  onCardUpdated: (card: DashboardCard) => void;
}

const noop = () => {};

/**
 * A card (an idea) opened from the dashboard's card grid, shown full-screen over
 * everything — the same shape as ArchivedPageOverlay, so opening an idea feels
 * identical to reopening an archived page. The body — the "## Problem / ## Idea /
 * ## Project plan / ## Next steps" template — renders through the very same
 * NotePage editor the pad uses, so the Markdown looks exactly as it does on an
 * archived page. The header carries the kind, title, priority, and the idea's tags.
 *
 * The page is read-only to the *user* (ideas are server cards authored by Claude —
 * no caret, no edits, nothing to persist), but it isn't a dead end: the composer
 * pinned to the bottom is a chat with Claude about this one idea, which is how the
 * idea gets changed. Agreed tweaks are written back to the same card server-side
 * (upsert_card, reusing its id), so the body under the chat is re-read and repaints
 * as the conversation firms the idea up into a project plan. Claude's side of that
 * conversation — typically a question it needs answered — sits in a card in the
 * header, under the tags.
 *
 * Because those writes are Claude's and not the user's, they're undoable: once a
 * turn has changed the card, an Undo control appears over the body's top-right
 * corner, below the header's edge, and — after a confirmation — puts the idea back
 * the way it read before that change.
 *

 * The thread itself lives in ../../server/ideaChat, not here: closing this page
 * mid-answer must not kill the run or lose the transcript later turns are threaded
 * with.
 */
export default function IdeaPageOverlay({
  card,
  width,
  onClose,
  dictating,
  onDictate,
  onCardUpdated,
}: IdeaPageOverlayProps) {
  const insets = useSafeAreaInsets();
  const colors = useTheme();
  // This sheet is a Modal — its own window on Android — so nothing lifts the
  // composer off the keyboard by itself. Pad the sheet by the keyboard instead.
  const keyboard = useKeyboardHeight();
  const p = prio(card.priority);
  const tags = card.tags ?? [];
  const kindLabel = card.kind === 'idea' ? 'Idea' : card.kind;

  const id = card.id;
  const thread = useSyncExternalStore(
    useCallback(cb => ideaChat.subscribe(id, cb), [id]),
    useCallback(() => ideaChat.getThread(id), [id]),
  );
  const running = ideaChat.isRunning(id);

  // The card as Claude has left it. Re-read whenever a turn ends (it may have
  // rewritten the body mid-answer) and once on open, in case a turn finished
  // while this page was closed. Failures are ignored: the page keeps showing what
  // it has rather than blanking on a dropped connection.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const latestUpdated = useRef(onCardUpdated);
  latestUpdated.current = onCardUpdated;
  const refresh = useCallback(async () => {
    try {
      const fresh = await fetchCard(id);
      if (!fresh) return;
      // Settle the turn's undo snapshot first — that's a store fact, true whether
      // or not this page is still on screen to show the button it enables.
      ideaChat.recordCard(fresh);
      if (mounted.current) latestUpdated.current(fresh);
    } catch {
      /* keep the copy we have */
    }
  }, [id]);

  const hadTurns = useRef(thread.turns.length > 0);
  useEffect(() => {
    if (hadTurns.current) refresh();
  }, [refresh]);

  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) refresh();
    wasRunning.current = running;
  }, [running, refresh]);

  // How much of the header the reply card may take. Driven on the UI thread so
  // the edge tracks the finger, and written back to the thread on release —
  // which is also what survives closing the page. The ceiling leaves the idea
  // itself a readable strip no matter how far the drag goes.
  const { height: screenH } = useWindowDimensions();
  const maxCardHeight = Math.max(MIN_CARD_HEIGHT, screenH * 0.55);
  const cardHeight = useSharedValue(thread.cardHeight ?? DEFAULT_CARD_HEIGHT);
  const dragStart = useSharedValue(0);
  /** 0 → 1 while the edge is being dragged; the handle takes the accent color so
   *  it's clear the finger has hold of it and not the page behind it. */
  const dragging = useSharedValue(0);
  // Opening a different idea reuses this component, so take the new card's height.
  useEffect(() => {
    cardHeight.value = ideaChat.getThread(id).cardHeight ?? DEFAULT_CARD_HEIGHT;
  }, [id, cardHeight]);

  const commitHeight = useCallback((h: number) => ideaChat.setCardHeight(id, h), [id]);
  const resize = useMemo(
    () =>
      Gesture.Pan()
        // A hairline is a small target; take the drag from either side of it.
        .hitSlop({ top: 12, bottom: 12 })
        .onStart(() => {
          dragStart.value = cardHeight.value;
          dragging.value = withTiming(1, { duration: 120 });
        })
        .onUpdate(e => {
          const next = dragStart.value + e.translationY;
          cardHeight.value = Math.min(maxCardHeight, Math.max(MIN_CARD_HEIGHT, next));
        })
        // Finalize, not end: a drag interrupted partway still leaves the card
        // where the finger left it, so what's on screen is what gets remembered.
        .onFinalize(() => {
          dragging.value = withTiming(0, { duration: 160 });
          runOnJS(commitHeight)(cardHeight.value);
        }),
    [cardHeight, dragStart, dragging, maxCardHeight, commitHeight],
  );
  const cardStyle = useAnimatedStyle(() => ({ maxHeight: cardHeight.value }));

  // Both halves of the handle — the hairline and the grip riding it — light up
  // together, so the edge reads as one control that's been picked up.
  const edgeColor = useAnimatedStyle(() => ({
    borderBottomColor: interpolateColor(dragging.value, [0, 1], [mocha.surface1, colors.accent]),
  }));
  const gripColor = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(dragging.value, [0, 1], [mocha.surface1, colors.accent]),
  }));

  // The same resize by keyboard/screen reader, a step at a time.
  const nudgeHeight = useCallback(
    (by: number) => {
      const next = Math.min(maxCardHeight, Math.max(MIN_CARD_HEIGHT, cardHeight.value + by));
      cardHeight.value = next;
      commitHeight(next);
    },
    [cardHeight, maxCardHeight, commitHeight],
  );

  const hasReplies = thread.turns.length > 0;

  // Claude has rewritten this idea at least once, so there's something to put
  // back. Hidden mid-turn: a restore racing the edit Claude is streaming would
  // have them writing over each other on the same card.
  const canUndo = ideaChat.canUndo(id) && !running;
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const undo = useCallback(async () => {
    setUndoing(true);
    try {
      await ideaChat.undoLast(card);
      await refresh();
    } catch (e) {
      // The snapshot is still in the thread — the button stays, so this is a
      // retry rather than a lost revert.
      if (mounted.current) {
        setUndoError(e instanceof Error ? e.message : 'The idea could not be restored.');
      }
    } finally {
      if (mounted.current) setUndoing(false);
    }
  }, [card, refresh]);

  // ── The build ────────────────────────────────────────────────────────────
  // An idea can be handed to the companion server to become a real project that
  // a scheduled agent builds one feature at a time. Everything about that state
  // is derived from the card the server stamped — never from local state — so it
  // survives an app restart and is the same on every device.
  const stamp = cardBuild(card);
  const buildSlug = stamp?.slug ?? null;
  const locked = buildIsLive(stamp?.status);
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [buildBusy, setBuildBusy] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  const refreshBuild = useCallback(async () => {
    if (!buildSlug) return;
    try {
      const info = await fetchBuild(buildSlug);
      if (mounted.current) setBuild(info);
    } catch {
      /* keep whatever the page already has rather than blanking it */
    }
  }, [buildSlug]);

  useEffect(() => {
    refreshBuild();
  }, [refreshBuild]);

  // While the plan is on screen and the build is live, keep it current: a feature
  // finishing is the one thing that changes this page without the user acting.
  useEffect(() => {
    if (!showPlan || !buildIsLive(build?.status ?? stamp?.status)) return;
    const t = setInterval(refreshBuild, 20000);
    return () => clearInterval(t);
  }, [showPlan, build?.status, stamp?.status, refreshBuild]);

  const runBuildAction = useCallback(
    async (action: () => Promise<BuildInfo>, thenShowPlan: boolean) => {
      setBuildBusy(true);
      try {
        const info = await action();
        if (!mounted.current) return;
        setBuild(info);
        if (thenShowPlan) setShowPlan(true);
        // Re-read the card: the server stamps payload.build on it, and that stamp
        // is what locks (or unlocks) this page.
        await refresh();
      } catch (e) {
        if (mounted.current) {
          setBuildError(e instanceof Error ? e.message : 'The build could not be changed.');
        }
      } finally {
        if (mounted.current) setBuildBusy(false);
      }
    },
    [refresh],
  );

  // The card presented as a Note so the shared editor can render its Markdown body.
  // Timestamps are best-effort (0 when absent) — read-only, so they're never written.
  //
  // The progress view is the same object built from the plan instead of the idea,
  // which is why a rendered PROJECT_PLAN.md needs no renderer of its own.
  const showingPlan = showPlan && build !== null;
  const note: Note = showingPlan
    ? {
        id: `${card.id}::plan`,
        content: planMarkdown(build),
        title: build.slug,
        createdAt: 0,
        updatedAt: Date.parse(build.last_run ?? '') || 0,
      }
    : {
        id: card.id,
        content: card.body ?? '',
        title: card.title,
        createdAt: Date.parse(card.created_at ?? '') || 0,
        updatedAt: Date.parse(card.updated_at ?? '') || 0,
      };

  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      {/* A Modal is its own view hierarchy, so the app's root gesture handler
          doesn't reach into it — the header's drag needs one in here. */}
      <GestureHandlerRootView style={styles.root}>
        <View
          className="flex-1 bg-background"
          style={{
            paddingTop: insets.top,
            paddingBottom: Math.max(insets.bottom, keyboard),
          }}>
          {/* The page header — title row, tags, and Claude's side of the chat. */}
          <View>
            {/* Back to the dashboard, the kind + title, and a priority pill. */}
            <View className="flex-row items-center px-3 pb-2 pt-1">
              <Pressable
                onPress={onClose}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Back to dashboard"
                className="mr-1 h-9 w-9 items-center justify-center rounded-full active:bg-surface">
                <ChevronLeft size={24} color={colors.text} strokeWidth={2} />
              </Pressable>
              {/* With a build attached, the title block is the progress toggle:
                  tapping it swaps the body between the idea and its plan. */}
              <Pressable
                disabled={!build}
                onPress={() => setShowPlan(v => !v)}
                accessibilityRole={build ? 'button' : undefined}
                accessibilityLabel={showPlan ? 'Show the idea' : 'Show the build plan'}
                className="flex-1 pr-2">
                <Text className="text-[11px] font-bold uppercase tracking-wider text-faint">
                  {showingPlan ? `Build · ${build.status.replace(/-/g, ' ')}` : kindLabel}
                </Text>
                <Text numberOfLines={1} className="text-lg font-bold text-text">
                  {showingPlan ? build.slug : card.title}
                </Text>
              </Pressable>

              {/* Hand the idea to the server as a project it builds on a
                  schedule. Confirmed first: this starts an unattended agent, so
                  it should feel deliberate. */}
              {!build && !locked && (
                <Pressable
                  onPress={() => setConfirmStart(true)}
                  disabled={buildBusy}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Build this idea"
                  accessibilityState={{ disabled: buildBusy }}
                  className={`mr-1.5 flex-row items-center gap-1.5 rounded-full border border-surface1 bg-surface px-2.5 py-1 active:opacity-70 ${
                    buildBusy ? 'opacity-50' : ''
                  }`}>
                  <Hammer size={13} color={colors.accent} strokeWidth={2.5} />
                  <Text className="text-[11px] font-semibold text-muted">
                    {buildBusy ? 'Starting…' : 'Build'}
                  </Text>
                </Pressable>
              )}

              {/* A live build can be called off from here — the same place it was
                  started. The project and everything built so far stay put. */}
              {build && buildIsLive(build.status) && (
                <Pressable
                  onPress={() => setConfirmStop(true)}
                  disabled={buildBusy}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Stop this build"
                  accessibilityState={{ disabled: buildBusy }}
                  className={`mr-1.5 h-8 w-8 items-center justify-center rounded-full active:bg-surface ${
                    buildBusy ? 'opacity-50' : ''
                  }`}>
                  <CircleStop size={18} color={colors.faint} strokeWidth={2} />
                </Pressable>
              )}

              {build ? (
                <Pressable
                  onPress={() => setShowPlan(v => !v)}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={showPlan ? 'Show the idea' : 'Show the build plan'}
                  className="h-8 w-8 items-center justify-center rounded-full active:bg-surface">
                  {showPlan ? (
                    <Lightbulb size={18} color={colors.faint} strokeWidth={2} />
                  ) : (
                    <ListChecks size={18} color={colors.accent} strokeWidth={2} />
                  )}
                </Pressable>
              ) : (
                <View className={`flex-row items-center gap-1 rounded-full px-2.5 py-1 ${p.chip}`}>
                  <View className={`h-1.5 w-1.5 rounded-full ${p.pip}`} />
                  <Text className={`text-[10px] font-bold uppercase tracking-wide ${p.text}`}>
                    {p.label}
                  </Text>
                </View>
              )}
            </View>

            {/* Tags, when present — the same chips as the card, under the title. */}
            {tags.length > 0 && (
              <View className="flex-row flex-wrap items-center gap-1.5 px-3 pb-2">
                {tags.map(t => (
                  <View
                    key={t}
                    className="flex-row items-center rounded-full bg-surface1/60 px-2 py-0.5">
                    <Text className="text-[10px] font-bold text-faint">#</Text>
                    <Text className="text-[10px] font-semibold text-muted">{t}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Claude's side of the conversation, under the tags, as tall as the
                header's edge has been dragged. */}
            {hasReplies && (
              <Animated.View style={[styles.cardWrap, cardStyle]}>
                <IdeaChatCard turns={thread.turns} onDelete={() => ideaChat.clear(id)} />
              </Animated.View>
            )}
          </View>

          {/* The header's bottom edge: the same hairline the dashboard's cards use,
              so the idea's body below reads as its own surface. With replies in the
              header it's also the grab handle that sizes them — drag it down for
              more of the conversation, up for more of the idea. */}
          {hasReplies ? (
            <GestureDetector gesture={resize}>
              <Animated.View
                accessibilityRole="adjustable"
                accessibilityLabel="Resize Claude's replies"
                accessibilityActions={ADJUST_ACTIONS}
                onAccessibilityAction={e =>
                  nudgeHeight(e.nativeEvent.actionName === 'increment' ? 40 : -40)
                }
                style={[styles.edge, edgeColor]}>
                <Animated.View style={[styles.grip, gripColor]} />
              </Animated.View>
            </GestureDetector>
          ) : (
            <View className="border-b border-surface1" />
          )}

          {/* The idea's body, with the undo control parked over its top-right
              corner rather than sitting in a row of its own — the way the editor's
              cards carry their action buttons. That leaves the header's surface
              ending at the edge above, and starts the Markdown at the button's own
              height instead of pushing it down past a strip of empty page. */}
          <View className="relative flex-1">
            {/* Keyed on the body: the editor takes its content at boot, so a card
                Claude has just rewritten needs a fresh one to repaint. */}
            <NotePage
              key={note.content}
              note={note}
              width={width}
              isActive
              readOnly
              onChangeContent={noop}
              onSetTitle={noop}
              onIngested={noop}
              notebookId={card.source ?? ''}
            />

            {/* Claude rewrote the idea in this conversation: offer to put it back.
                Opaque and raised, so the body's text runs under it. Hidden while
                the plan is on screen — the button would be sitting over a body it
                doesn't act on. */}
            {canUndo && !showingPlan && (
              <Pressable
                onPress={() => setConfirmUndo(true)}
                disabled={undoing}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel="Undo Claude's changes to this idea"
                accessibilityState={{ disabled: undoing }}
                style={styles.undoFloat}
                className={`absolute right-3 top-2 flex-row items-center gap-1.5 rounded-full border border-surface1 bg-surface px-2.5 py-1 active:opacity-70 ${
                  undoing ? 'opacity-50' : ''
                }`}>
                <Undo2 size={13} color={colors.faint} strokeWidth={2.5} />
                <Text className="text-[11px] font-semibold text-muted">
                  {undoing ? 'Undoing…' : 'Undo AI changes'}
                </Text>
              </Pressable>
            )}
          </View>

          {/* The chat, pinned under the idea it's about — the only writable thing
              on the page, and how the idea itself gets changed.

              Once a build exists the idea is locked: its body is now the input to
              the project's PROJECT_PLAN.md, and further chat edits would silently
              diverge from what is actually being built. Stopping the build (or
              letting it finish) hands the idea back. */}
          {locked ? (
            <View className="flex-row items-center gap-2 border-t border-border px-4 py-3">
              <Hammer size={14} color={colors.faint} strokeWidth={2.5} />
              <Text className="flex-1 text-[12px] leading-4 text-faint">
                This idea is being built, so it's locked — its wording is what the
                project plan was written from. Stop the build to edit it again.
              </Text>
            </View>
          ) : (
            <View className="border-t border-border px-3 pb-1">
              <CardComposer
                value={thread.draft}
                onChangeText={text => ideaChat.setDraft(id, text)}
                placeholder="Work on this idea…"
                onSubmit={text => ideaChat.send(card, text)}
                dictating={dictating}
                onDictate={onDictate}
                running={running}
                onStop={() => ideaChat.stop(id)}
              />
            </View>
          )}
        </View>

        {/* Reverting rewrites the card server-side, so it's confirmed first — and
            the message says what "undo" means here: one step back, not a reset to
            how the idea was filed. */}
        <ConfirmDialog
          visible={confirmUndo}
          title="Undo AI changes"
          message={`Put this idea back the way it read before Claude's last change to it? ${
            thread.undo.length > 1
              ? `That's one of ${thread.undo.length} changes from this conversation — undo again to step further back.`
              : 'The conversation itself is kept.'
          }`}
          confirmLabel="Undo"
          cancelLabel="Cancel"
          destructive
          onConfirm={() => {
            setConfirmUndo(false);
            undo();
          }}
          onCancel={() => setConfirmUndo(false)}
        />

        {/* Starting a build hands the idea to an agent that will run unattended
            on a schedule, so it's spelled out rather than confirmed with a shrug. */}
        <ConfirmDialog
          visible={confirmStart}
          title="Build this idea"
          message={`Turn “${card.title}” into a project the server builds for you? It writes a plan, then builds one feature every so often — pausing each time for you to check the result on the dashboard before it goes on. The idea itself locks while that runs.`}
          confirmLabel="Build it"
          cancelLabel="Cancel"
          onConfirm={() => {
            setConfirmStart(false);
            runBuildAction(() => startBuild(card, card.title), true);
          }}
          onCancel={() => setConfirmStart(false)}
        />

        {/* Stopping is destructive in the sense that matters: the schedule goes
            and a run in flight is killed. The code it already wrote is kept. */}
        <ConfirmDialog
          visible={confirmStop}
          title="Stop this build"
          message="Stop building this project? The schedule is removed and anything running now is cancelled. The project folder and every feature already built stay where they are, and the idea unlocks."
          confirmLabel="Stop"
          cancelLabel="Keep building"
          destructive
          onConfirm={() => {
            setConfirmStop(false);
            if (build) runBuildAction(() => stopBuild(build.slug), false);
          }}
          onCancel={() => setConfirmStop(false)}
        />

        {/* The build call didn't take (server gone, /code or /exec off, a folder
            that already has a build). Nothing has changed, so this is a retry. */}
        <ConfirmDialog
          visible={buildError !== null}
          title="Couldn't change the build"
          message={buildError ?? ''}
          confirmLabel="OK"
          hideCancel
          onConfirm={() => setBuildError(null)}
          onCancel={() => setBuildError(null)}
        />

        {/* The revert didn't take (server gone, card deleted). The snapshot is
            still held, so the button is still there to try again. */}
        <ConfirmDialog
          visible={undoError !== null}
          title="Couldn't undo"
          message={undoError ?? ''}
          confirmLabel="OK"
          hideCancel
          onConfirm={() => setUndoError(null)}
          onCancel={() => setUndoError(null)}
        />
      </GestureHandlerRootView>
    </Modal>
  );
}

/** Resize by 40px a step for anyone driving the handle from a screen reader. */
const ADJUST_ACTIONS = [{ name: 'increment' }, { name: 'decrement' }];

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The reply card's margins live out here, on the box whose height is dragged.
  cardWrap: { marginHorizontal: 12, marginBottom: 8 },
  // The draggable edge. Colors come from the animated styles above — these are
  // the same metrics the plain hairline has, plus room for the grip.
  edge: { alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1 },
  grip: { height: 4, width: 36, borderRadius: 2 },
  // The undo pill floats over the editor. Android draws a WebView on its own
  // layer, so raise the pill with elevation as well as zIndex or it ends up
  // behind the body it sits on.
  undoFloat: { zIndex: 10, elevation: 4 },
});
