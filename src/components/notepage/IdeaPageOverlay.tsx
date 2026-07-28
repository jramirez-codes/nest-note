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
  Play,
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
  cardStep,
  fetchBuild,
  planMarkdown,
  resumeBuild,
  reviseBuild,
  scheduleBuild,
  startBuild,
  startLabel,
  stopBuild,
  type BuildInfo,
} from '../../server/controllers/buildApi';
import * as ideaChat from '../../server/ideaChat';
import BuildScheduleDialog, { type BuildScheduleMode } from '../modals/BuildScheduleDialog';
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

/** The one sentence the header's state card says about the build, and the glyph
 *  in front of it. See headerCard below for which state says which. */
interface HeaderCard {
  Icon: typeof CalendarClock;
  title: string;
  note: string;
  /** Nothing is going to happen by itself, so the glyph takes the muted well the
   *  disabled composer strip uses rather than the accent one that means "live". */
  dim?: boolean;
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
 * A build with a run placed at a minute gets a card of its own above that one, same
 * width and same surface, saying when it starts. The button on its right swaps the
 * card underneath between Claude's replies and the two things that can still be done
 * about the start time, so the schedule is edited where it's stated rather than
 * from a control in the title row. That card is not the idea's alone: a step whose
 * sign-off named a time for the next feature is the same sentence about a different
 * run, so it gets the same card, the same button, and the same Reschedule / stop
 * pair underneath — where before it could state a start time but not move it.
 *
 * The same page opens the **build-step** cards a running build files, and both of
 * its halves keep their jobs there, aimed at the project instead of the card. The
 * header's Build button places the *next feature* — now or at a chosen minute,
 * with signing this step off part of that one choice. The composer sends what you
 * say about the feature you were just shown back to the agent that built it, which
 * makes the change (to the code, or to the plan) and pauses at this same step
 * again. So a step is reviewed the way anyone actually reviews something: "nearly,
 * but…", as many times as it takes, and then yes.
 *
 * A step page is also where the idea itself ends up. The build's *first* step card
 * takes the idea's name, body and tags, and the idea card is retired from the
 * dashboard behind it — so this page opened on a step shows the idea under the
 * header, exactly as it did when the idea had a card of its own, with the toggle
 * swapping it for the plan (whose Overview says the same thing). That is also why a
 * step now carries the stop button: it is the page the build has.
 *
 * And, for the same reason, the way back from one. A stopped build isn't a finished
 * one — the plan, the code and every step card are still there — so its step page
 * offers Resume where Build would be, putting the build back at the feature it
 * reached with that step asking for its decision again. Without it, stopping was a
 * one-way door out of a project that still existed.
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
  // A step card is titled by the idea, so its eyebrow carries the other half of
  // what it is: which feature of that idea this page is about.
  const step = cardStep(card);
  const kindLabel =
    card.kind === 'idea'
      ? 'Idea'
      : card.kind === 'build-step'
        ? step
          ? `Build step · feature ${step.feature}`
          : 'Build step'
        : card.kind;

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
  // A build step is not an idea. It's a card the build filed about itself, asking
  // for a decision on one feature, and it carries the same stamp — so this page
  // opens on it too, and every control below has to mean what it means *there*.
  // Chiefly: there is no idea here to hand over, only a build already running,
  // whose next feature is the thing that can be placed in time.
  const isStep = card.kind === 'build-step';
  // Holding the idea and locking it are different: a build the user scheduled for
  // later hasn't planned anything from the idea's wording yet, so it stays theirs
  // to work on right up to the start time — and so does the start time itself,
  // which can be moved or called off until it comes round.
  const locked = buildLocksIdea(stamp?.status);
  const [build, setBuild] = useState<BuildInfo | null>(null);
  // The build's state, preferring the fetched build but falling back to the card's
  // stamp, so the page reads right on the first frame after opening rather than
  // only once /build has answered.
  const status = build?.status ?? stamp?.status;
  const waiting = status === 'scheduled';
  const startsAt = build?.start_at ?? stamp?.start_at;
  // Parked at a step card, with a feature built and nothing running. This is the
  // one state where the *next* run is the user's to place: from here, picking a
  // time signs this step off and starts the feature after it — and it's the only
  // moment anything can be said to the build, since saying it starts a run.
  const atStep = status === 'awaiting-validation';
  // A run is going in the project right now: the plan being written, a feature
  // being built, or a revision the user just asked for.
  const buildRunning = status === 'planning' || status === 'building';
  // The build ended before its plan did — stopped from a page, or a feature
  // rejected. Nothing has been thrown away, so this is a state the page offers a
  // way out of rather than the end of the project.
  const stopped = status === 'halted';
  // The feature this page is about — the one a step card records, and the one the
  // build is on — and the one a "build the next" from here would start.
  const stepFeature = build?.feature ?? stamp?.feature ?? 0;
  const nextFeature = stepFeature + 1;
  // Whether a build has hold of this idea *right now*, on the same "fetched build
  // first, card stamp behind it" footing as `waiting`.
  //
  // Not "is there a build object" — that's a different question with a different
  // answer. A stopped or finished build is still fetched and still on screen: its
  // plan stays readable behind the header's toggle. So the controls that belong to
  // a live build have to key off the status, or they'd go on hiding (or offering)
  // themselves for a build that ended.
  const liveBuild = buildIsLive(status);
  // The slug either source knows this build by. The fetched build is the fresher
  // of the two, but the stamp is there on the first frame — so the controls that
  // act on a build work before /build has answered.
  const slug = build?.slug ?? buildSlug;
  const [showPlan, setShowPlan] = useState(false);
  // Which schedule decision is on screen: handing the idea over for the first time,
  // moving the start of a build that hasn't begun, or starting the feature after the
  // step being looked at. One dialog, three doors.
  const [scheduling, setScheduling] = useState<BuildScheduleMode | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const [buildBusy, setBuildBusy] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  // A run is placed at a minute that hasn't come round yet. Two states hold one,
  // and they are the same fact about the build: an idea handed over for later, and
  // a step whose sign-off named a time for the feature after it. So they get the
  // same header card, the same button on it, and the same two ways out — the only
  // difference is which run is being moved.
  const placed = waiting || (isStep && atStep && !!startsAt);
  // Which surface the header's card slot is showing: Claude's replies, or what
  // can still be done about the start time. One slot, because both are about the
  // same page and the header can only give the height to one of them.
  const [editingSchedule, setEditingSchedule] = useState(false);
  const scheduleOpen = placed && editingSchedule;
  const showReplies = hasReplies && !scheduleOpen;
  // Nothing left to move once that run starts (or is called off), so the slot goes
  // back to the conversation rather than stranding dead controls in it.
  useEffect(() => {
    if (!placed) setEditingSchedule(false);
  }, [placed]);

  // The header's state card: one card, the same one on both kinds of page, saying
  // where this build stands. It sits above Claude's replies at the same width and
  // on the same surface, because it is the same kind of thing — the header telling
  // you where the thing you are looking at has got to.
  //
  // Every line of it is read off the build's own state, so none of them can drift
  // from it. The build's `note` is preferred to anything written here wherever
  // there is one: it is what the last run was asked for, or what it reported, and
  // that says more than any wording of ours could.
  const buildNote = build?.note?.trim() || null;
  const headerCard = ((): HeaderCard | null => {
    // Scheduled, not started. The idea stays open for editing — the plan is
    // written from whatever it says at the start time — so this states the
    // deadline rather than that the page is shut.
    if (waiting) {
      return {
        Icon: CalendarClock,
        title: `Starts ${startLabel(startsAt ? new Date(startsAt) : null)}`,
        note: 'Keep editing — the plan follows what the idea says then.',
      };
    }
    if (!isStep) return null;
    if (buildRunning) {
      return {
        Icon: Hammer,
        title: `Working on feature ${stepFeature}`,
        note: buildNote ?? 'Nothing to do but wait — this comes back when the run lands.',
      };
    }
    // Parked at the step. Either the next feature has been placed at a minute, or
    // nothing runs until the user says so.
    if (atStep) {
      return {
        Icon: CalendarClock,
        title: startsAt
          ? `Feature ${nextFeature} starts ${startLabel(new Date(startsAt))}`
          : 'Waiting on you',
        note:
          buildNote ??
          (startsAt
            ? 'This step is signed off — nothing runs until then.'
            : 'Nothing is scheduled. Say what to change, or Build to carry on.'),
      };
    }
    // Stopped, which is a state and not an ending: the plan, the code and the
    // steps are all still there, and Resume in the header puts the build back on
    // this feature.
    if (stopped) {
      return {
        Icon: CircleStop,
        title: 'This build is stopped',
        // Here the build's note is *why*, so it leads a sentence rather than
        // replacing one: "feature 2 was rejected" on its own says nothing about
        // what can be done about it, which is the point of this card.
        note: buildNote
          ? `${buildNote} — nothing runs until you resume it, and everything built stays where it is.`
          : 'Nothing runs until you resume it. Everything built so far stays where it is.',
        dim: true,
      };
    }
    return null;
  })();

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

  // Keep the build current while something is going to change without the user
  // acting: the plan on screen with a live build behind it, or a run in flight on
  // a step page — where the run is one the user started by sending a message, and
  // this poll is how the page notices it landing and asks them to look again.
  useEffect(() => {
    if (!((showPlan && liveBuild) || (isStep && buildRunning))) return;
    const t = setInterval(refreshBuild, 20000);
    return () => clearInterval(t);
  }, [showPlan, liveBuild, isStep, buildRunning, refreshBuild]);

  // Send what the user typed on a step card into the project. It starts a run, so
  // it goes through the same busy/error plumbing as the other build actions rather
  // than through ideaChat: nothing here is a turn about a card's wording, it's an
  // instruction to the agent standing in the project directory.
  const sendRevision = useCallback(
    async (text: string) => {
      if (!slug) return;
      setBuildBusy(true);
      try {
        const info = await reviseBuild(slug, text);
        if (!mounted.current) return;
        // Accepted, so the box is emptied — the message is the run's now.
        ideaChat.setDraft(id, '');
        setBuild(info);
        await refresh();
      } catch (e) {
        // The draft is deliberately left in the box: nothing ran, so this is a
        // retry rather than a message the user has to type again.
        if (mounted.current) {
          setBuildError(e instanceof Error ? e.message : 'That could not be sent to the build.');
        }
      } finally {
        if (mounted.current) setBuildBusy(false);
      }
    },
    [slug, id, refresh],
  );

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
            {/* Back to the dashboard, and the kind + title. Every action in the
                row is the same 32pt height on the same chassis — one radius, one
                border, one surface — so the right-hand end reads as one toolbar
                rather than a pill and two floating glyphs. The back chevron keeps
                no chassis of its own: it leaves the page rather than acting on
                it, and shouldn't compete with the actions that do. */}
            <View className="flex-row items-center gap-2 px-3 pb-2.5 pt-1">
              <Pressable
                onPress={onClose}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Back to dashboard"
                className="h-8 w-8 items-center justify-center rounded-lg active:bg-surface">
                <ChevronLeft size={22} color={colors.text} strokeWidth={2} />
              </Pressable>
              {/* With a build attached, the title block is the progress toggle:
                  tapping it swaps the body between the idea and its plan. */}
              <Pressable
                disabled={!build}
                onPress={() => setShowPlan(v => !v)}
                accessibilityRole={build ? 'button' : undefined}
                accessibilityLabel={showPlan ? 'Show the idea' : 'Show the build plan'}
                className="flex-1">
                <Text style={styles.eyebrow} className="text-[10px] font-bold uppercase text-faint">
                  {showingPlan ? `Build · ${build.status.replace(/-/g, ' ')}` : kindLabel}
                </Text>
                <Text numberOfLines={1} className="text-[17px] font-bold leading-6 text-text">
                  {showingPlan ? build.slug : card.title}
                </Text>
              </Pressable>

              {/* Build. The same accent-filled control on both kinds of card,
                  because it is the same sentence in both: "put this in the
                  server's hands, and say when."

                  On an idea it hands the whole thing over as a project. On a build
                  step it starts the feature after the one the step is about — the
                  build is already running, so what's left to decide is when it
                  carries on. Never straight through either way: it arms an
                  unattended agent, so the dialog behind it says what that means.

                  On an idea it comes back the moment no build holds it — cancelled,
                  stopped or finished — because then building it again is exactly
                  what the page is for. On a step it's there only while the build is
                  parked at that step with nothing placed: once the next feature is
                  running there is nothing to place, and once it has been given a
                  minute the card below moves it rather than this placing it twice. */}
              {(isStep ? atStep && !placed : !liveBuild) && (
                <Pressable
                  onPress={() => setScheduling(isStep ? 'next' : 'start')}
                  disabled={buildBusy}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={isStep ? 'Build the next feature' : 'Build this idea'}
                  accessibilityState={{ disabled: buildBusy }}
                  className={`h-8 flex-row items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/15 px-2.5 active:opacity-70 ${
                    buildBusy ? 'opacity-50' : ''
                  }`}>
                  <Hammer size={13} color={colors.accent} strokeWidth={2.5} />
                  <Text className="text-[12px] font-semibold text-accent">
                    {buildBusy ? 'Starting…' : 'Build'}
                  </Text>
                </Pressable>
              )}

              {/* Carry on. A stopped build isn't a finished one — the plan, the
                  code and the step cards are all still there — so the step page it
                  left behind offers the way back in, in the slot Build would be in
                  if there were anything to build. It takes no time with it: the
                  build goes back to asking about the feature it reached, and
                  placing the next one is the ordinary decision it always is.

                  Only on a step. An idea whose build stopped before its first
                  feature still has its Build button and its own wording, and
                  handing it over again is a truer description of that than
                  resuming a build that never built anything. */}
              {isStep && stopped && (
                <Pressable
                  onPress={() => setConfirmResume(true)}
                  disabled={buildBusy || !slug}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Resume this build"
                  accessibilityState={{ disabled: buildBusy || !slug }}
                  className={`h-8 flex-row items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/15 px-2.5 active:opacity-70 ${
                    buildBusy || !slug ? 'opacity-50' : ''
                  }`}>
                  <Play size={13} color={colors.accent} strokeWidth={2.5} />
                  <Text className="text-[12px] font-semibold text-accent">
                    {buildBusy ? 'Resuming…' : 'Resume'}
                  </Text>
                </Pressable>
              )}

              {/* A build that has begun can be called off from wherever it is being
                  watched. The project and everything built so far stay put. A build
                  with a run placed at a minute isn't stopped from up here: calling
                  it off is one of the two things the schedule card below offers,
                  next to the time it would undo.

                  Including on a build step, which is a change: it used to be the
                  idea's control alone, on the grounds that ending a build isn't
                  what a step card is about. That reasoning has expired — the idea
                  moves onto the first step card and comes off the dashboard, so a
                  step page is the page a running build has. Leaving stop on the
                  idea would leave a build with nowhere to stop it. It still sits
                  second to the Build button, because carrying on is the common
                  answer and stopping is the rare one. */}
              {liveBuild && !placed && (
                <Pressable
                  onPress={() => setConfirmStop(true)}
                  disabled={buildBusy}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Stop this build"
                  accessibilityState={{ disabled: buildBusy }}
                  className={`h-8 w-8 items-center justify-center rounded-lg border border-surface1 bg-surface active:opacity-70 ${
                    buildBusy ? 'opacity-50' : ''
                  }`}>
                  <CircleStop size={16} color={colors.faint} strokeWidth={2} />
                </Pressable>
              )}

              {build && (
                <Pressable
                  onPress={() => setShowPlan(v => !v)}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={showPlan ? 'Show the idea' : 'Show the build plan'}
                  accessibilityState={{ expanded: showPlan }}
                  className="h-8 w-8 items-center justify-center rounded-lg border border-surface1 bg-surface active:opacity-70">
                  {showPlan ? (
                    <Lightbulb size={16} color={colors.faint} strokeWidth={2} />
                  ) : (
                    <ListChecks size={16} color={colors.accent} strokeWidth={2} />
                  )}
                </Pressable>
              )}
            </View>

            {/* Tags, when present — the same chips as the card, under the title. */}
            {tags.length > 0 && (
              <View className="flex-row flex-wrap items-center gap-1.5 px-3 pb-2.5">
                {tags.map(t => (
                  <View
                    key={t}
                    className="flex-row items-center rounded-md bg-surface1/50 px-2 py-0.5">
                    <Text className="text-[10px] font-bold text-faint">#</Text>
                    <Text className="text-[10px] font-semibold text-muted">{t}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Where the build stands, above Claude's replies and at the same
                width and surface — and, when a run has been placed at a minute,
                the way to what can still be done about it.

                One card on both kinds of page. A scheduled idea and a signed-off
                step are the same sentence with a different subject: something is
                due to run, here is when, and here are the two things you can still
                do about it. The step page used to say the first half and stop,
                leaving a start time you could read but not move. */}
            {headerCard && (
              <View
                style={styles.cardWrap}
                className="flex-row items-center gap-2.5 rounded-xl border border-surface1 bg-surface/50 p-2.5">
                {/* The time leads, in the page's text color, with the caveat under
                    it in the faint one — so the card answers "when?" at a glance
                    instead of burying it in a sentence. */}
                <View
                  className={`h-8 w-8 items-center justify-center rounded-lg ${
                    headerCard.dim ? 'bg-surface1/50' : 'bg-accent/15'
                  }`}>
                  <headerCard.Icon
                    size={15}
                    color={headerCard.dim ? colors.faint : colors.accent}
                    strokeWidth={2.5}
                  />
                </View>
                <View className="flex-1 gap-0.5">
                  <Text className="text-[12px] font-semibold leading-4 text-text">
                    {headerCard.title}
                  </Text>
                  <Text className="text-[11px] leading-4 text-faint" numberOfLines={2}>
                    {headerCard.note}
                  </Text>
                </View>

                {/* The only way to that start time: it swaps the card below between
                    Claude's replies and what can still be done about the schedule.
                    The same 32pt square as the header's controls, so a button that
                    opens a surface looks like every other button on the page. */}
                {placed && (
                  <Pressable
                    onPress={() => setEditingSchedule(v => !v)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={
                      scheduleOpen
                        ? hasReplies
                          ? "Show Claude's replies"
                          : 'Close the schedule'
                        : isStep
                          ? 'Change when the next feature starts'
                          : 'Change when this build starts'
                    }
                    accessibilityState={{ expanded: scheduleOpen }}
                    className="h-8 w-8 items-center justify-center rounded-lg border border-surface1 bg-surface active:opacity-70">
                    {!scheduleOpen ? (
                      <CalendarCog size={15} color={colors.accent} strokeWidth={2.5} />
                    ) : hasReplies ? (
                      <MessageSquare size={15} color={colors.faint} strokeWidth={2.5} />
                    ) : (
                      <X size={15} color={colors.faint} strokeWidth={2.5} />
                    )}
                  </Pressable>
                )}
              </View>
            )}

            {/* The header's one resizable slot. Either what can still be done
                about the start time, or — the rest of the time — Claude's side of
                the conversation, as tall as the header's edge has been dragged. */}
            {scheduleOpen ? (
              <View
                style={styles.cardWrap}
                className="rounded-xl border border-surface1 bg-surface/50 p-2.5">
                <Text className="text-[11px] leading-4 text-faint">
                  {isStep
                    ? `Feature ${nextFeature} hasn't started, so that time is still a choice. Move it, or stop the build — either way everything built so far stays where it is.`
                    : 'Nothing has run yet, so that time is still a choice. Move it, or call the build off — either way the idea stays yours.'}
                </Text>
                {/* Two halves of one row: the choice is between exactly these, so
                    they split the card's width evenly rather than sitting as two
                    differently-sized pills in the middle of it. Ending it goes
                    through the same stop dialog the header offers on a build with
                    nothing placed, which already words both cases. */}
                <View className="mt-2.5 flex-row gap-1.5">
                  <Pressable
                    onPress={() => setScheduling(isStep ? 'move' : 'edit')}
                    disabled={buildBusy || !slug}
                    accessibilityRole="button"
                    accessibilityLabel={
                      isStep
                        ? 'Change when the next feature starts'
                        : 'Change when this build starts'
                    }
                    accessibilityState={{ disabled: buildBusy || !slug }}
                    className={`h-8 flex-1 flex-row items-center justify-center gap-1.5 rounded-lg border border-surface1 bg-surface active:opacity-70 ${
                      buildBusy || !slug ? 'opacity-50' : ''
                    }`}>
                    <CalendarCog size={13} color={colors.accent} strokeWidth={2.5} />
                    <Text className="text-[12px] font-semibold text-muted">Reschedule</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setConfirmStop(true)}
                    disabled={buildBusy || !slug}
                    accessibilityRole="button"
                    accessibilityLabel={
                      isStep ? 'Stop this build' : 'Cancel this build before it starts'
                    }
                    accessibilityState={{ disabled: buildBusy || !slug }}
                    className={`h-8 flex-1 flex-row items-center justify-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 active:opacity-70 ${
                      buildBusy || !slug ? 'opacity-50' : ''
                    }`}>
                    <CalendarX size={13} color={colors.danger} strokeWidth={2.5} />
                    {/* "Cancel" on an idea, where nothing has run and there is
                        nothing to stop; "Stop" on a step, where the same button
                        ends a build that has already written code. */}
                    <Text className="text-[12px] font-semibold text-danger">
                      {isStep ? 'Stop build' : 'Cancel build'}
                    </Text>
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
                className={`absolute right-3 top-2 h-8 flex-row items-center gap-1.5 rounded-lg border border-surface1 bg-surface px-2.5 active:opacity-70 ${
                  undoing ? 'opacity-50' : ''
                }`}>
                <Undo2 size={13} color={colors.faint} strokeWidth={2.5} />
                <Text className="text-[12px] font-semibold text-muted">
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
              letting it finish) hands the idea back.

              A build step keeps the box, pointed somewhere else. What you type
              there isn't a turn about the card's wording — it goes to the agent
              standing in the project, which does what you asked and pauses at this
              same step again. That's what makes reviewing a feature a conversation
              rather than a yes/no: most of what anyone wants to say about
              something just built is "nearly, but…", including "…and the plan
              should change". Only at the gate, though — while a run is going,
              there is nothing to say to it that wouldn't be a second agent in the
              same working tree. */}
          {isStep ? (
            atStep ? (
              <View className="border-t border-border px-3 pb-1">
                <CardComposer
                  value={thread.draft}
                  onChangeText={text => ideaChat.setDraft(id, text)}
                  placeholder={
                    stepFeature
                      ? `Change something in feature ${stepFeature}…`
                      : 'Change something in this feature…'
                  }
                  onSubmit={sendRevision}
                  dictating={dictating}
                  onDictate={onDictate}
                  // No Stop: this is the POST that starts the run, not the run.
                  // The box locks for the moment it's in flight, then the strip
                  // below replaces it for as long as the agent is working.
                  running={buildBusy}
                />
              </View>
            ) : (
              <View className="flex-row items-center gap-2.5 border-t border-border px-3 py-2.5">
                <View className="h-8 w-8 items-center justify-center rounded-lg bg-surface1/50">
                  <Hammer size={15} color={colors.faint} strokeWidth={2.5} />
                </View>
                <Text className="flex-1 text-[11px] leading-4 text-faint">
                  {buildRunning
                    ? `${slug ?? 'The project'} is working. This step comes back when the run lands, and you can pick it up from there.`
                    : stopped
                      ? `This build is stopped, so there is nothing running to talk to. Resume it to put ${
                          slug ?? 'the project'
                        } back at feature ${stepFeature} — the code, the plan and every step stay exactly where they are.`
                      : `This step is closed — the build has moved on. Its latest step is where ${
                          slug ?? 'the project'
                        } is picked back up.`}
                </Text>
              </View>
            )
          ) : locked ? (
            <View className="flex-row items-center gap-2.5 border-t border-border px-3 py-2.5">
              <View className="h-8 w-8 items-center justify-center rounded-lg bg-surface1/50">
                <Hammer size={15} color={colors.faint} strokeWidth={2.5} />
              </View>
              <Text className="flex-1 text-[11px] leading-4 text-faint">
                This idea is locked while it's being built — its wording is what the project plan
                was written from, and it moves onto the build's first step once that lands. Stop
                the build to edit it again.
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
            round yet — the build's own, or the next feature's — because the choice
            is identical, and so is the sentence explaining it. One dialog to keep
            in step with itself rather than four. */}
        <BuildScheduleDialog
          visible={scheduling !== null}
          // A step page is about the project, not about the card it's filed under,
          // so both doors that open from one quote the project back.
          title={isStep ? (slug ?? card.title) : card.title}
          busy={buildBusy}
          mode={scheduling ?? 'start'}
          feature={nextFeature}
          // The two doors that move something already placed open on the time it is
          // set to; the two that place one for the first time open on "now".
          initialAt={
            (scheduling === 'edit' || scheduling === 'move') && startsAt ? new Date(startsAt) : null
          }
          onConfirm={startAt => {
            const door = scheduling;
            setScheduling(null);
            // Only show the plan straight away for a build that's actually about
            // to write one; a scheduled build would flip to an empty page.
            if (door === 'start') {
              runBuildAction(() => startBuild(card, card.title, startAt), startAt === null);
            } else if (slug) {
              // One endpoint for the other three: moving a start that hasn't come
              // round, placing the next feature of a build parked at a step, and
              // moving that feature once it has been placed.
              runBuildAction(() => scheduleBuild(slug, startAt), startAt === null);
            }
          }}
          onCancel={() => setScheduling(null)}
        />

        {/* Stopping is destructive in the sense that matters: the schedule goes
            and a run in flight is killed. The code it already wrote is kept — and
            on a step, so is the way back in, which the wording says rather than
            leaving the user to find out by pressing it. */}
        <ConfirmDialog
          visible={confirmStop}
          title={waiting ? 'Cancel this build' : 'Stop this build'}
          message={
            waiting
              ? 'Call this build off before it starts? The crontab entry is removed and nothing ever runs — no plan is written and no code is generated. The empty project folder stays where it is.'
              : isStep
                ? 'Stop building this project? The schedule is removed and anything running now is cancelled. The project folder and every feature already built stay where they are, and this step stays on the dashboard as the record of what was built — with Resume on it, so this can be picked back up.'
                : 'Stop building this project? The schedule is removed and anything running now is cancelled. The project folder and every feature already built stay where they are, and the idea unlocks.'
          }
          confirmLabel="Stop"
          cancelLabel={placed ? 'Leave it scheduled' : 'Keep building'}
          destructive
          onConfirm={() => {
            setConfirmStop(false);
            if (slug) runBuildAction(() => stopBuild(slug), false);
          }}
          onCancel={() => setConfirmStop(false)}
        />

        {/* Resuming runs nothing, and says so — it puts the build back at the step
            it reached and hands the next decision straight back to the user. It's
            confirmed all the same, because it re-arms a crontab entry and puts a
            card back on the dashboard asking for an answer, and neither of those
            should happen from a tap whose meaning had to be guessed. */}
        <ConfirmDialog
          visible={confirmResume}
          title="Resume this build"
          message={`Put ${
            slug ?? 'this project'
          } back at feature ${stepFeature}? Its step goes back to asking for a decision and the schedule is armed again, but nothing runs until you say when the next feature starts — or say what to change about this one first.`}
          confirmLabel="Resume"
          cancelLabel="Leave it stopped"
          onConfirm={() => {
            setConfirmResume(false);
            if (slug) runBuildAction(() => resumeBuild(slug), false);
          }}
          onCancel={() => setConfirmResume(false)}
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
  // Tailwind's tracking-wider is too tight for 10px caps; this is the letter
  // spacing that keeps the eyebrow legible at the size the header shrank it to.
  eyebrow: { letterSpacing: 1.1 },
  // The draggable edge. Colors come from the animated styles above — these are
  // the same metrics the plain hairline has, plus room for the grip.
  edge: { alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1 },
  grip: { height: 4, width: 36, borderRadius: 2 },
  // The undo pill floats over the editor. Android draws a WebView on its own
  // layer, so raise the pill with elevation as well as zIndex or it ends up
  // behind the body it sits on.
  undoFloat: { zIndex: 10, elevation: 4 },
});
