import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { CalendarClock } from 'lucide-react-native';
import { useTheme } from '../../theme/colors';
import { startLabel } from '../../server/controllers/buildApi';

interface BuildScheduleDialogProps {
  visible: boolean;
  /** The idea's title, quoted back so it's clear what is being handed over. */
  title: string;
  /** The request is in flight — the confirm button says so and stops repeating. */
  busy?: boolean;
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
 */
export default function BuildScheduleDialog({
  visible,
  title,
  busy = false,
  onConfirm,
  onCancel,
}: BuildScheduleDialogProps) {
  const colors = useTheme();
  // Null is "now". Every open starts there — a schedule is a decision for this
  // build, not a preference that should linger to surprise the next one.
  const [at, setAt] = useState<Date | null>(null);
  useEffect(() => {
    if (visible) setAt(null);
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
          className="w-full max-w-sm rounded-2xl border border-surface1 bg-surface0 p-6"
          onPress={() => {}}>
          <Text className="text-lg font-semibold text-text">Build this idea</Text>
          <Text className="mt-2 text-sm leading-5 text-muted">
            Turn “{title}” into a project the server builds for you? It writes a plan, then builds
            one feature every so often — pausing each time for you to check the result on the
            dashboard before it goes on.
          </Text>

          <Text className="mt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
            Start
          </Text>

          {/* The four shapes an overnight build actually gets scheduled in. */}
          <View className="mt-2 flex-row flex-wrap gap-1.5">
            {presets.map(p => {
              const on = sameMinute(at, p.at);
              return (
                <Pressable
                  key={p.label}
                  onPress={() => setAt(p.at)}
                  accessibilityRole="button"
                  accessibilityLabel={`Start ${p.label.toLowerCase()}`}
                  accessibilityState={{ selected: on }}
                  className={`rounded-full border px-3 py-1.5 active:opacity-70 ${
                    on ? 'border-accent bg-accent/20' : 'border-surface1 bg-surface'
                  }`}>
                  <Text
                    className={`text-[12px] font-semibold ${on ? 'text-accent' : 'text-muted'}`}>
                    {p.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* What was actually chosen, and the way to anything the presets missed. */}
          <View className="mt-3 rounded-xl border border-surface1 bg-surface px-3 py-2.5">
            <View className="flex-row items-center gap-2">
              <CalendarClock size={14} color={colors.accent} strokeWidth={2.5} />
              <Text className="flex-1 text-[13px] font-semibold text-text">
                Starts {startLabel(at)}
              </Text>
            </View>
            <View className="mt-2 flex-row justify-between">
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
                  hitSlop={4}
                  accessibilityRole="button"
                  accessibilityLabel={`Move the start ${n.label}`}
                  className="rounded-lg bg-surface1/70 px-2.5 py-1 active:opacity-70">
                  <Text className="text-[12px] font-semibold text-muted">{n.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* The consequence, which differs by exactly this choice. */}
          <Text className="mt-3 text-[12px] leading-4 text-faint">
            {at
              ? 'The project folder is made now, but nothing runs until then — so you can keep working on the idea, and whatever it says at that point is what gets built.'
              : 'The idea locks while that runs.'}
          </Text>

          <View className="mt-6 flex-row justify-end gap-3">
            <Pressable
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              className="rounded-xl px-4 py-2.5 active:opacity-70">
              <Text className="text-sm font-semibold text-muted">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => onConfirm(at)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={at ? 'Schedule this build' : 'Build it now'}
              accessibilityState={{ disabled: busy }}
              className={`rounded-xl bg-accent px-4 py-2.5 active:opacity-80 ${
                busy ? 'opacity-50' : ''
              }`}>
              <Text className="text-sm font-semibold text-crust">
                {busy ? 'Starting…' : at ? 'Schedule it' : 'Build it'}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
