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
import {
  CalendarClock,
  CalendarCog,
  CalendarX,
  ChevronLeft,
  CircleStop,
  Hammer,
  Lightbulb,
  ListChecks,
  MessageSquare,
  Undo2,
  X,
} from 'lucide-react-native';
import { mocha } from '../../theme/catppuccin';
import { useTheme } from '../../theme/colors';
import { useKeyboardHeight } from '../../hooks/useKeyboardHeight';
import type { Note } from '../../types/note';
import { fetchCard, type DashboardCard } from '../../server/controllers/aiController';
import {
  buildIsLive,
  buildLocksIdea,
  cardBuild,
  fetchBuild,
  planMarkdown,
  rescheduleBuild,
  startBuild,
  startLabel,
  stopBuild,
  type BuildInfo,
} from '../../server/controllers/buildApi';
import * as ideaChat from '../../server/ideaChat';
import BuildScheduleDialog from '../modals/BuildScheduleDialog';
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
 * archived page. The header carries the kind, the title, and the idea's tags.
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
 * A build scheduled for later gets a card of its own above that one, same width and
 * same surface, saying when it starts. The square button down its right edge swaps
 * the card underneath
 * between Claude's replies and the two things that can still be done about the start
 * time, so the schedule is edited where it's stated rather than from a control in
 * the title row.
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
  const hasBuild = buildIsLive(stamp?.status);
  // Holding the idea and locking it are different: a build the user scheduled for
  // later hasn't planned anything from the idea's wording yet, so it stays theirs
  // to work on right up to the start time — and so does the start time itself,
  // which can be moved or called off until it comes round.
  const locked = buildLocksIdea(stamp?.status);
  const [build, setBuild] = useState<BuildInfo | null>(null);
  // The build hasn't started yet, and when it will. Both prefer the fetched build
  // but fall back to the card's stamp, so the page reads right on the first frame
  // after opening rather than only once /build has answered.
  const waiting = (build?.status ?? stamp?.status) === 'scheduled';
  const startsAt = build?.start_at ?? stamp?.start_at;
  // The slug either source knows this build by. The fetched build is the fresher
  // of the two, but the stamp is there on the first frame — so the controls that
  // act on a build work before /build has answered.
  const slug = build?.slug ?? buildSlug;
  const [showPlan, setShowPlan] = useState(false);
  // Which schedule decision is on screen: handing the idea over for the first
  // time, or moving the start of a build that hasn't begun. One dialog, two doors.
  const [scheduling, setScheduling] = useState<'start' | 'edit' | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [buildBusy, setBuildBusy] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  // Which surface the header's card slot is showing: Claude's replies, or what
  // can still be done about the start time. One slot, because both are about the
  // same idea and the header can only give the height to one of them.
  const [editingSchedule, setEditingSchedule] = useState(false);
  const scheduleOpen = waiting && editingSchedule;
  const showReplies = hasReplies && !scheduleOpen;
  // Nothing left to edit once the build starts (or is called off), so the slot
  // goes back to the conversation rather than stranding dead controls in it.
  useEffect(() => {
    if (!waiting) setEditingSchedule(false);
  }, [waiting]);

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
            {/* Back to the dashboard, and the kind + title. */}
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
                  schedule. Never straight through: this arms an unattended agent,
                  so the dialog behind it says what that means and takes the one
                  decision worth taking first — when it should start. */}
              {!build && !hasBuild && (
                <Pressable
                  onPress={() => setScheduling('start')}
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

              {/* A build that has begun can be called off from here — the same
                  place it was started. The project and everything built so far
                  stay put. A build still waiting for its start time isn't stopped
                  from up here: calling it off is one of the two things the
                  schedule card below offers, next to the time it would undo. */}
              {build && buildIsLive(build.status) && !waiting && (
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

              {build && (
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

            {/* Scheduled, not started. The idea stays open for editing — the plan
                is written from whatever it says at the start time — so this states
                the deadline rather than that the page is shut. It's a card the
                width of Claude's replies below it, and the same surface, because
                it's the same kind of thing: the header telling you where this idea
                stands. */}
            {waiting && (
              <View
                style={styles.cardWrap}
                className="flex-row items-stretch gap-2 rounded-xl border border-surface1 bg-surface/40 p-1.5">
                <View className="flex-1 flex-row items-center gap-2 py-0.5 pl-1.5">
                  <CalendarClock size={13} color={colors.accent} strokeWidth={2.5} />
                  <Text className="flex-1 text-[11px] leading-4 text-faint">
                    Building starts{' '}
                    <Text className="font-semibold text-muted">
                      {startLabel(startsAt ? new Date(startsAt) : null)}
                    </Text>
                    . Keep working on the idea until then — the plan is written from what it says
                    at that point.
                  </Text>
                </View>

                {/* The only way to that start time: it swaps the card below between
                    Claude's replies and what can still be done about the schedule.
                    A column of the card rather than a badge floating in its corner —
                    stretched to the text's full height and kept square off that, so
                    it reads as the card's own button, with the card's padding the
                    only gap around it. */}
                <Pressable
                  onPress={() => setEditingSchedule(v => !v)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={
                    scheduleOpen
                      ? hasReplies
                        ? "Show Claude's replies"
                        : 'Close the schedule'
                      : 'Change when this build starts'
                  }
                  accessibilityState={{ expanded: scheduleOpen }}
                  className="aspect-square items-center justify-center self-stretch rounded-lg border border-surface1 bg-surface active:opacity-70">
                  {!scheduleOpen ? (
                    <CalendarCog size={13} color={colors.accent} strokeWidth={2.5} />
                  ) : hasReplies ? (
                    <MessageSquare size={13} color={colors.faint} strokeWidth={2.5} />
                  ) : (
                    <X size={13} color={colors.faint} strokeWidth={2.5} />
                  )}
                </Pressable>
              </View>
            )}

            {/* The header's one resizable slot. Either what can still be done
                about the start time, or — the rest of the time — Claude's side of
                the conversation, as tall as the header's edge has been dragged. */}
            {scheduleOpen ? (
              <View
                style={styles.cardWrap}
                className="rounded-xl border border-surface1 bg-surface/40 px-3 py-2">
                <Text className="text-[11px] leading-4 text-faint">
                  Nothing has run yet, so that time is still a choice rather than a commitment.
                  Move it, or call the build off — either way the idea stays yours.
                </Text>
                {/* Cancelling goes through the same stop dialog the header used to
                    offer, which already words the not-yet-started case. */}
                <View className="mt-2 flex-row justify-center gap-1.5">
                  <Pressable
                    onPress={() => setScheduling('edit')}
                    disabled={buildBusy || !slug}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel="Change when this build starts"
                    accessibilityState={{ disabled: buildBusy || !slug }}
                    className={`flex-row items-center gap-1.5 rounded-full border border-surface1 bg-surface px-2.5 py-1 active:opacity-70 ${
                      buildBusy || !slug ? 'opacity-50' : ''
                    }`}>
                    <CalendarCog size={13} color={colors.accent} strokeWidth={2.5} />
                    <Text className="text-[11px] font-semibold text-muted">Reschedule</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setConfirmStop(true)}
                    disabled={buildBusy || !slug}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel this build before it starts"
                    accessibilityState={{ disabled: buildBusy || !slug }}
                    className={`flex-row items-center gap-1.5 rounded-full border border-surface1 bg-surface px-2.5 py-1 active:opacity-70 ${
                      buildBusy || !slug ? 'opacity-50' : ''
                    }`}>
                    <CalendarX size={13} color={colors.faint} strokeWidth={2.5} />
                    <Text className="text-[11px] font-semibold text-muted">Cancel build</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              hasReplies && (
                <Animated.View style={[styles.cardWrap, cardStyle]}>
                  <IdeaChatCard turns={thread.turns} onDelete={() => ideaChat.clear(id)} />
                </Animated.View>
              )
            )}
          </View>

          {/* The header's bottom edge: the same hairline the dashboard's cards use,
              so the idea's body below reads as its own surface. With replies in the
              header it's also the grab handle that sizes them — drag it down for
              more of the conversation, up for more of the idea. The schedule card
              has a size of its own, so while it holds the slot the edge is just
              the hairline again. */}
          {showReplies ? (
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
            on a schedule, so it's spelled out rather than confirmed with a shrug —
            and picking when it starts is part of the same decision. The default is
            now, so the quick path is still one tap.

            Reopened later, the same sheet moves a start time that hasn't come
            round yet: the choice is identical, and so is the sentence explaining
            it, so there's no second dialog to keep in step with this one. */}
        <BuildScheduleDialog
          visible={scheduling !== null}
          title={card.title}
          busy={buildBusy}
          reschedule={scheduling === 'edit'}
          initialAt={scheduling === 'edit' && startsAt ? new Date(startsAt) : null}
          onConfirm={startAt => {
            const editing = scheduling === 'edit';
            setScheduling(null);
            // Only show the plan straight away for a build that's actually about
            // to write one; a scheduled build would flip to an empty page.
            if (!editing) {
              runBuildAction(() => startBuild(card, card.title, startAt), startAt === null);
            } else if (slug) {
              runBuildAction(() => rescheduleBuild(slug, startAt), startAt === null);
            }
          }}
          onCancel={() => setScheduling(null)}
        />

        {/* Stopping is destructive in the sense that matters: the schedule goes
            and a run in flight is killed. The code it already wrote is kept. */}
        <ConfirmDialog
          visible={confirmStop}
          title={waiting ? 'Cancel this build' : 'Stop this build'}
          message={
            waiting
              ? 'Call this build off before it starts? The crontab entry is removed and nothing ever runs — no plan is written and no code is generated. The empty project folder stays where it is.'
              : 'Stop building this project? The schedule is removed and anything running now is cancelled. The project folder and every feature already built stay where they are, and the idea unlocks.'
          }
          confirmLabel="Stop"
          cancelLabel={waiting ? 'Leave it scheduled' : 'Keep building'}
          destructive
          onConfirm={() => {
            setConfirmStop(false);
            if (slug) runBuildAction(() => stopBuild(slug), false);
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
