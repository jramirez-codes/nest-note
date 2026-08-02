import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CalendarClock, CalendarCog, Hammer } from 'lucide-react-native';
import { useTheme } from '../../theme/colors';
import { startLabel } from '../../server/controllers/buildApi';

/**
 * Which of the four doors this sheet was opened from. The choice behind it is the
 * same in all four — one time, with "Now" meaning now — so they share a dialog and
 * differ only in what the sentences say is about to happen.
 *
 * They are two questions crossed: *what* is being placed (the whole build, or the
 * next feature of one already running) and whether it is being placed for the
 * first time or moved.
 *
 * - `start` — handing an idea over for the first time.
 * - `edit` — moving the start of a build that hasn't begun.
 * - `next` — starting the next feature of a build parked on a step card.
 * - `move` — moving the start of a next feature that has already been placed.
 */
export type BuildScheduleMode = 'start' | 'edit' | 'next' | 'move';

interface BuildScheduleDialogProps {
  visible: boolean;
  /** The idea's title (or, on a step card, the project's slug), quoted back so
   *  it's clear what is being handed over. */
  title: string;
  /** The request is in flight — the confirm button says so and stops repeating. */
  busy?: boolean;
  mode: BuildScheduleMode;
  /** Which feature the `next` and `move` doors are about to build. */
  feature?: number;
  /** The time to open on. Null (the default) is "now"; rescheduling passes the
   *  start already set, so the dialog opens on the choice being changed. */
  initialAt?: Date | null;
  /** Confirmed. Null is the default: start it now. */
  onConfirm: (startAt: Date | null) => void;
  onCancel: () => void;
}

/**
 * Milliseconds a chosen start has to be ahead of now to count as scheduling
 * rather than starting. Nudging below it snaps back to "now", which is what makes
 * the minus buttons a way back to the default rather than a way to pick a time in
 * the past. Comfortably over the server's own tolerance, so a time this side of
 * the line is never quietly re-read as "now" after the fact.
 */
const SOON_MS = 3 * 60 * 1000;

/** Round to the minute — cron's own resolution, and there is no point offering finer. */
function atMinute(d: Date): Date {
  const out = new Date(d);
  out.setSeconds(0, 0);
  return out;
}

/** The next time today or tomorrow that the clock reads `hour`. */
function nextAt(hour: number): Date {
  const out = atMinute(new Date());
  out.setHours(hour, 0, 0, 0);
  if (out.getTime() <= Date.now() + SOON_MS) out.setDate(out.getDate() + 1);
  return out;
}

/**
 * The dialog that stands between the idea page's Build button and an unattended
 * agent: what it's about to do, and when.
 *
 * "When" defaults to now — the common case, and one tap away — so this is the old
 * confirmation with a schedule folded into it rather than a new step. Choosing a
 * later time doesn't defer the *project*: the folder is created either way, so the
 * idea shows as a build immediately. What waits is the planning run, which is why
 * the idea stays editable until then and this dialog says so.
 *
 * The picker is presets plus nudges rather than a wheel or a calendar. It has no
 * date-picker dependency to earn its keep, the presets ("this evening",
 * "tomorrow") are the shapes anyone actually schedules an overnight build in, and
 * the nudges reach anything else in a few taps. Minute resolution, because the
 * crontab entry underneath cannot do better.
 *
 * The other three doors (see BuildScheduleMode) open the same sheet on a build that
 * already exists: `edit` moves the start it is waiting for, `next` starts the
 * feature after the step the user is looking at, and `move` moves that feature once
 * it has been placed. One dialog rather than four, because the decision is identical
 * — including "Now", which on a build that already exists means run it, not move it
 * to this minute — and only the wording around it changes.
 */
export default function BuildScheduleDialog({
  visible,
  title,
  busy = false,
  mode,
  feature,
  initialAt = null,
  onConfirm,
  onCancel,
}: BuildScheduleDialogProps) {
  const colors = useTheme();
  // Null is "now". Every open starts from what this build is set to — the time
  // already chosen when changing one, "now" when there isn't one yet — so nothing
  // lingers from the last open to surprise the next build.
  const [at, setAt] = useState<Date | null>(initialAt);
  useEffect(() => {
    if (visible) setAt(initialAt);
    // The open is the event; initialAt is read at that moment on purpose, so a
    // re-render can't drag the time back out from under an edit in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Frozen for as long as the dialog is open, so "In an hour" doesn't quietly
  // drift out from under the finger while the user reads the rest of the sheet.
  const presets = useMemo(() => {
    const now = Date.now();
    return [
      { label: 'Now', at: null },
      { label: 'In an hour', at: atMinute(new Date(now + 60 * 60 * 1000)) },
      { label: 'This evening', at: nextAt(20) },
      { label: 'Tomorrow', at: nextAt(9) },
    ];
    // visible is the dependency that matters: recompute once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  /** Move the chosen time by `ms`, collapsing anything imminent back to "now". */
  const nudge = (ms: number) => {
    const from = at ? at.getTime() : Date.now();
    const next = atMinute(new Date(from + ms));
    setAt(next.getTime() > Date.now() + SOON_MS ? next : null);
  };

  const sameMinute = (a: Date | null, b: Date | null) =>
    a === null || b === null ? a === b : a.getTime() === b.getTime();

  // Everything that differs by door, in one place: the glyph, the two sentences
  // either side of the picker, and what the two buttons promise. Written out per
  // door rather than assembled from fragments — these are the sentences that tell
  // someone what an unattended agent is about to do, and they read better whole.
  // Note "Now" is never "move it to this minute": on a build that already exists
  // it runs the thing, so those buttons say so.
  const copy = {
    start: {
      Icon: Hammer,
      title: 'Build this idea',
      blurb: `Turn “${title}” into a project the server builds for you? It writes a plan, then builds one feature at a time, pausing after each for you to check the result.`,
      consequence: at
        ? 'The project folder is made now, but nothing runs until then — keep working on the idea, and whatever it says then is what gets built.'
        : 'The idea locks while that runs.',
      confirm: at
        ? { label: 'Schedule it', busy: 'Starting…', hint: 'Schedule this build' }
        : { label: 'Build it', busy: 'Starting…', hint: 'Build it now' },
      cancel: { label: 'Cancel', hint: 'Cancel' },
    },
    edit: {
      Icon: CalendarCog,
      title: 'Change the start time',
      blurb: `The build of “${title}” hasn't started yet, so it can start whenever you like — later, sooner, or right now.`,
      consequence: at
        ? 'Nothing has run yet, so only the start time moves — keep working on the idea, and whatever it says then is what gets built.'
        : 'The idea locks while that runs.',
      confirm: at
        ? { label: 'Move it', busy: 'Moving…', hint: 'Move this build to the new start time' }
        : { label: 'Build it now', busy: 'Starting…', hint: 'Start this build now' },
      cancel: { label: 'Leave it', hint: 'Leave the start time alone' },
    },
    next: {
      Icon: Hammer,
      title: feature ? `Build feature ${feature}` : 'Build the next feature',
      blurb: `Carry on building “${title}”? Choosing when the next feature runs is how you sign this step off — the build takes it as your yes and moves on.`,
      consequence: at
        ? 'This step is marked validated now. The next feature runs then, and pauses again at a step card of its own once it is built.'
        : 'This step is marked validated and the next feature starts right away.',
      confirm: at
        ? { label: 'Schedule it', busy: 'Scheduling…', hint: 'Schedule the next feature' }
        : { label: 'Build it now', busy: 'Starting…', hint: 'Build the next feature now' },
      cancel: { label: 'Cancel', hint: 'Cancel' },
    },
    // The step has already been signed off and its next feature placed at a
    // minute, so this is the `edit` question asked one feature further along: the
    // sign-off isn't being taken back, only the time it put on the clock.
    move: {
      Icon: CalendarCog,
      title: 'Change the start time',
      blurb: feature
        ? `Feature ${feature} of “${title}” hasn't started yet, so it can start whenever you like — later, sooner, or right now.`
        : `The next feature of “${title}” hasn't started yet, so it can start whenever you like — later, sooner, or right now.`,
      consequence: at
        ? 'This step stays signed off; only the time moves. The next feature pauses at a step card of its own once it is built.'
        : 'The next feature starts right away, and pauses at a step card of its own once it is built.',
      confirm: at
        ? { label: 'Move it', busy: 'Moving…', hint: 'Move the next feature to the new start time' }
        : { label: 'Build it now', busy: 'Starting…', hint: 'Build the next feature now' },
      cancel: { label: 'Leave it', hint: 'Leave the start time alone' },
    },
  }[mode];
  const confirm = copy.confirm;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onCancel}>
      <Pressable className="flex-1 items-center justify-center bg-crust/70 px-8" onPress={onCancel}>
        {/* Stop presses on the card from bubbling to the backdrop. */}
        <Pressable
          className="w-full max-w-sm rounded-2xl border border-surface1 bg-surface0 p-5"
          onPress={() => {}}>
          {/* The icon says which of the doors this is before the title does, and
              matches the glyph on the control that opened it. */}
          <View className="flex-row items-center gap-2.5">
            <View className="h-9 w-9 items-center justify-center rounded-xl bg-accent/15">
              <copy.Icon size={17} color={colors.accent} strokeWidth={2.5} />
            </View>
            <Text className="flex-1 text-[17px] font-semibold text-text">{copy.title}</Text>
          </View>
          <Text className="mt-3 text-[13px] leading-[19px] text-muted">{copy.blurb}</Text>

          <Text style={styles.eyebrow} className="mt-4 text-[10px] font-bold uppercase text-faint">
            Start
          </Text>

          {/* The four shapes an overnight build actually gets scheduled in, on a
              2×2 grid: equal halves read as one control, where a wrapping row of
              text-width pills leaves a ragged edge down the sheet. */}
          <View className="mt-2 gap-1.5">
            {[presets.slice(0, 2), presets.slice(2)].map((row, i) => (
              <View key={i} className="flex-row gap-1.5">
                {row.map(p => {
                  const on = sameMinute(at, p.at);
                  return (
                    <Pressable
                      key={p.label}
                      onPress={() => setAt(p.at)}
                      accessibilityRole="button"
                      accessibilityLabel={`Start ${p.label.toLowerCase()}`}
                      accessibilityState={{ selected: on }}
                      className={`h-9 flex-1 items-center justify-center rounded-lg border active:opacity-70 ${
                        on ? 'border-accent bg-accent/15' : 'border-surface1 bg-surface'
                      }`}>
                      <Text
                        className={`text-[12px] font-semibold ${on ? 'text-accent' : 'text-muted'}`}>
                        {p.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>

          {/* What was actually chosen, and the way to anything the presets missed. */}
          <View className="mt-2.5 rounded-xl border border-surface1 bg-surface p-2.5">
            <View className="flex-row items-center gap-2">
              <CalendarClock size={14} color={colors.accent} strokeWidth={2.5} />
              <Text className="flex-1 text-[13px] font-semibold text-text">
                Starts {startLabel(at)}
              </Text>
            </View>
            {/* Even fifths, so the nudges read as one segmented strip under the
                time they move rather than five loose chips. */}
            <View className="mt-2.5 flex-row gap-1">
              {[
                { label: '−1h', ms: -60 * 60 * 1000 },
                { label: '−15m', ms: -15 * 60 * 1000 },
                { label: '+15m', ms: 15 * 60 * 1000 },
                { label: '+1h', ms: 60 * 60 * 1000 },
                { label: '+1d', ms: 24 * 60 * 60 * 1000 },
              ].map(n => (
                <Pressable
                  key={n.label}
                  onPress={() => nudge(n.ms)}
                  accessibilityRole="button"
                  accessibilityLabel={`Move the start ${n.label}`}
                  className="h-7 flex-1 items-center justify-center rounded-lg bg-surface1/60 active:opacity-70">
                  <Text className="text-[11px] font-semibold text-muted">{n.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* The consequence, which differs by exactly this choice — and by which
              door it was taken through. */}
          <Text className="mt-2.5 text-[11px] leading-4 text-faint">{copy.consequence}</Text>

          <View className="mt-5 flex-row justify-end gap-3">
            <Pressable
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel={copy.cancel.hint}
              className="rounded-xl px-4 py-2.5 active:opacity-70">
              <Text className="text-sm font-semibold text-muted">{copy.cancel.label}</Text>
            </Pressable>
            <Pressable
              onPress={() => onConfirm(at)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={confirm.hint}
              accessibilityState={{ disabled: busy }}
              className={`rounded-xl bg-accent px-4 py-2.5 active:opacity-80 ${
                busy ? 'opacity-50' : ''
              }`}>
              <Text className="text-sm font-semibold text-crust">
                {busy ? confirm.busy : confirm.label}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Matches the idea page's section labels: tracking-wider is too tight to keep
  // 10px caps legible.
  eyebrow: { letterSpacing: 1.1 },
});
