/**
 * Pure sorting and presentation logic for dashboard cards — no React, no JSX.
 * Kept separate from the view components so the ordering/formatting rules are
 * easy to find and reason about on their own.
 */
import { mocha } from '../../theme/catppuccin';
import type { DashboardCard, DashboardServer } from '../../server/controllers/aiController';
import type { NotebookOption } from './NotebookSwitcher';

// Priority ranks so a higher-urgency card sorts first. Unknown strings fall to
// the middle (normal) so a novel priority never crashes the sort.
const PRIORITY_RANK: Record<string, number> = { urgent: 3, high: 2, normal: 1, low: 0 };
const rankOf = (p: string) => PRIORITY_RANK[p] ?? 1;

// Each priority carries its own hue (for icons/pips) drawn from the raw Catppuccin
// palette, plus matching NativeWind classes so we never inline a style for it.
export interface PriorityStyle {
  hex: string;
  pip: string;
  chip: string;
  text: string;
  label: string;
}
const PRIORITY: Record<string, PriorityStyle> = {
  urgent: { hex: mocha.red, pip: 'bg-red', chip: 'bg-red/20', text: 'text-red', label: 'Urgent' },
  high: { hex: mocha.peach, pip: 'bg-peach', chip: 'bg-peach/20', text: 'text-peach', label: 'High' },
  normal: { hex: mocha.blue, pip: 'bg-blue', chip: 'bg-blue/20', text: 'text-blue', label: 'Normal' },
  low: { hex: mocha.overlay0, pip: 'bg-overlay0', chip: 'bg-overlay0/30', text: 'text-overlay0', label: 'Low' },
};
export const prio = (p: string): PriorityStyle => PRIORITY[p] ?? PRIORITY.normal;

// The build badge's five tones (see buildBadge), each a hue plus the classes a row
// renders it with. Same shape and the same job as PRIORITY above: a state is a
// colour, and the colour is written down once.
//
// `dim` is the tone at reading weight, for the second half of a badge — the start
// time, or why a build stopped. Spelled out rather than composed as `${text}/70`,
// because a class assembled at runtime is a class the Tailwind scanner never sees
// and so never generates.
export interface BuildToneStyle {
  hex: string;
  chip: string;
  text: string;
  dim: string;
}
const BUILD_TONE: Record<string, BuildToneStyle> = {
  // Blue for a run that is placed but not going, matching the calendar/clock
  // language the rest of the pad uses for "later".
  scheduled: { hex: mocha.blue, chip: 'bg-blue/20', text: 'text-blue', dim: 'text-blue/70' },
  // The accent, because a run in flight is the app doing the thing it exists to do.
  running: { hex: mocha.mauve, chip: 'bg-mauve/20', text: 'text-mauve', dim: 'text-mauve/70' },
  // Peach: not an error, but the one state that is waiting on the user to move.
  waiting: { hex: mocha.peach, chip: 'bg-peach/20', text: 'text-peach', dim: 'text-peach/70' },
  stopped: { hex: mocha.red, chip: 'bg-red/20', text: 'text-red', dim: 'text-red/70' },
  done: { hex: mocha.green, chip: 'bg-green/20', text: 'text-green', dim: 'text-green/70' },
};
export const buildTone = (tone: string): BuildToneStyle => BUILD_TONE[tone] ?? BUILD_TONE.waiting;

// The stable card sort key the spec calls for: priority rank desc, then soonest
// `date` asc (dated cards ahead of undated), then `created_at` asc as a tiebreak.
export function compareCards(a: DashboardCard, b: DashboardCard): number {
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

// Tasks sort like everything else; completion doesn't affect order, so checking
// a task off leaves it in place instead of jumping it elsewhere in the list.
// This is the 'priority' order: priority rank desc (red → orange → blue → gray),
// then soonest due date as the tiebreak.
export function compareTasks(a: DashboardCard, b: DashboardCard): number {
  return compareCards(a, b);
}

// The 'date' order: soonest due date first (dated tasks ahead of undated), then
// priority rank desc as the tiebreak. Completion doesn't affect order here either.
export function compareTasksByDate(a: DashboardCard, b: DashboardCard): number {
  const ad = a.date || '';
  const bd = b.date || '';
  if (ad && bd && ad !== bd) return ad < bd ? -1 : 1;
  if (ad && !bd) return -1;
  if (!ad && bd) return 1;
  const pr = rankOf(b.priority) - rankOf(a.priority);
  if (pr) return pr;
  const ac = a.created_at || '';
  const bc = b.created_at || '';
  return ac < bc ? -1 : ac > bc ? 1 : 0;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Full month names for the calendar's month header, indexed the same as MONTHS.
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Single-letter-ish weekday labels for the calendar's header row, Sunday first.
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Format an ISO `YYYY-MM-DD` relatively (Today / Tomorrow / Yesterday / "Jul 9"),
// and report whether it's in the past so a task can flag itself overdue.
export function relDate(iso: string): { label: string; overdue: boolean } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return { label: iso, overdue: false };
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (days === 0) return { label: 'Today', overdue: false };
  if (days === 1) return { label: 'Tomorrow', overdue: false };
  if (days === -1) return { label: 'Yesterday', overdue: true };
  // Near-future days (2–7 out) read as a relative countdown rather than a calendar
  // date — "3 days" instead of "Jul 26". Past dates keep their calendar wording.
  if (days >= 2 && days <= 7) return { label: `${days} days`, overdue: false };
  const label =
    `${MONTHS[d.getMonth()]} ${d.getDate()}` +
    (d.getFullYear() !== today.getFullYear() ? `, ${d.getFullYear()}` : '');
  return { label, overdue: days < 0 };
}

// The Tasks section's sort toggle: 'priority' leads with urgency (date breaks
// ties), 'date' leads with the soonest due date (priority breaks ties).
export type TaskSort = 'priority' | 'date';

export const compareTasksBy = (sort: TaskSort): typeof compareTasks =>
  sort === 'date' ? compareTasksByDate : compareTasks;

// The Tasks section's view modes: the two sorted-list orders plus the month
// calendar. 'priority'/'date' order the same task list; 'calendar' swaps that
// list for the month grid. Exactly one is active at a time — the toggle is a
// radio, not a set of independent filters.
export type TaskView = TaskSort | 'calendar';

// Tasks per page in the Tasks card's pager.
export const TASK_PAGE_SIZE = 5;

// --- Calendar view --------------------------------------------------------

// Pad a 1- or 2-digit number to two digits for a `YYYY-MM-DD` key segment.
const pad2 = (n: number) => String(n).padStart(2, '0');

// The date portion ('YYYY-MM-DD') of a card's ISO `date`, or null when it's absent
// or malformed. This is the key task cards are bucketed under for the calendar's
// day grid, and the key a tapped day looks its tasks up by.
export function dateKey(iso?: string): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// One cell in the calendar's month grid.
export interface CalendarDay {
  key: string; // 'YYYY-MM-DD'
  day: number; // day-of-month (1–31)
  inMonth: boolean; // false for the leading/trailing days borrowed from adjacent months
}

// Build the 6×7 = 42-cell month grid for `year`/`month` (month 0-based), weeks
// starting Sunday. Always exactly 42 cells (six full weeks) so the grid's height
// is stable from month to month, padded at both ends with the neighbouring months'
// days (flagged `inMonth: false`).
export function buildMonthGrid(year: number, month: number): CalendarDay[] {
  const firstWeekday = new Date(year, month, 1).getDay(); // 0 = Sunday
  const days: CalendarDay[] = [];
  for (let i = 0; i < 42; i++) {
    // Count forward from the Sunday on/before the 1st; Date normalises overflow,
    // so day-of-month/adjacent-month rollover is handled for us.
    const d = new Date(year, month, 1 - firstWeekday + i);
    days.push({
      key: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
      day: d.getDate(),
      inMonth: d.getMonth() === month,
    });
  }
  return days;
}

// Bucket task cards by their due-date key ('YYYY-MM-DD'). Cards without a valid
// `date` are dropped. The calendar reads this for both the per-day pips (open-task
// presence) and the tapped day's task list, so it parses dates exactly once.
export function tasksByDueDate(cards: DashboardCard[]): Map<string, DashboardCard[]> {
  const byDay = new Map<string, DashboardCard[]>();
  for (const c of cards) {
    const key = dateKey(c.date);
    if (!key) continue;
    const arr = byDay.get(key);
    if (arr) arr.push(c);
    else byDay.set(key, [c]);
  }
  return byDay;
}

// The highest-urgency priority among a set of tasks (defaulting to 'normal' for an
// empty set) — drives the colour of a calendar day's pip, so a day with an urgent
// task reads red the same way its row would in the list.
export function topPriority(cards: DashboardCard[]): string {
  let best = 'normal';
  let bestRank = -1;
  for (const c of cards) {
    const r = rankOf(c.priority);
    if (r > bestRank) {
      bestRank = r;
      best = c.priority;
    }
  }
  return best;
}

// A tapped day's header label: "Today"/"Tomorrow"/"Yesterday" when near, else a
// weekday + month/day like "Wed, Jul 22". Reuses relDate only for the "near" wording
// — the calendar header always spells out the actual date for other days (including
// the 2–7-day range that the task rows show as an "X days" countdown).
export function formatCalendarDay(key: string): string {
  const rel = relDate(key);
  if (rel.label === 'Today' || rel.label === 'Tomorrow' || rel.label === 'Yesterday') {
    return rel.label;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  if (!m) return key;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const monthDay =
    `${MONTHS[d.getMonth()]} ${d.getDate()}` +
    (d.getFullYear() !== new Date().getFullYear() ? `, ${d.getFullYear()}` : '');
  return `${WEEKDAYS[d.getDay()]}, ${monthDay}`;
}

// Archived pages per page in the Archived card's pager. The box holds this many
// rows' worth of fixed height (like Tasks), so it never resizes page to page.
export const ARCHIVE_PAGE_SIZE = 3;

// Idea / build-step rows per page in the Ideas view's card pagers. One short of
// TASK_PAGE_SIZE — the Ideas view stacks two of these lists (ideas and build steps),
// each with a tag bar and a pager of its own, so they're kept shorter than the Tasks
// list that has the top of its view to itself.
export const IDEA_PAGE_SIZE = 4;

/**
 * The notebook picker's entries, derived from dashboard state: the Sandbox (the local
 * pad, which rolls up every notebook's open tasks) first, then one per subject server,
 * each tagged with its own open-task count (a card belongs to a notebook via `source`).
 * Shared by the dashboard's full switcher and the header's compact badge so both render
 * the exact same list.
 */
export function buildNotebookOptions(
  cards: DashboardCard[],
  servers: DashboardServer[],
): NotebookOption[] {
  const tasksFor = (name: string) =>
    cards.filter(c => c.source === name && c.kind === 'task' && !c.done).length;
  const opts: NotebookOption[] = [
    {
      key: 'sandbox',
      label: 'Sandbox',
      kind: 'local',
      tasks: cards.filter(c => c.kind === 'task' && !c.done).length,
    },
  ];
  for (const s of servers) {
    opts.push({
      key: s.name,
      label: s.title || s.name,
      summary: s.summary,
      kind: 'server',
      tasks: tasksFor(s.name),
    });
  }
  return opts;
}

// The Markdown scaffold an idea card's body follows: four sections Claude fills in
// from the notes (see the orchestrator's upsert_card guidance). Shared here so the
// preview extractor and any future editor seed reference one definition.
export const IDEA_TEMPLATE = '## Problem\n\n## Idea\n\n## Project plan\n\n## Next steps\n';

// Roll a set of cards up into their distinct tags with a count each, ordered most-used
// first then alphabetically — the source for the Ideas section's tag filter bar. Tags
// are matched case-insensitively but reported in their first-seen spelling.
export interface TagCount {
  tag: string;
  count: number;
}
export function tagCounts(cards: DashboardCard[]): TagCount[] {
  const byKey = new Map<string, TagCount>();
  for (const c of cards) {
    for (const raw of c.tags ?? []) {
      const tag = raw.trim();
      if (!tag) continue;
      const key = tag.toLowerCase();
      const existing = byKey.get(key);
      if (existing) existing.count++;
      else byKey.set(key, { tag, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// True when a card carries `tag` (case-insensitive) — the predicate behind the tag filter.
export function cardHasTag(card: DashboardCard, tag: string): boolean {
  const want = tag.toLowerCase();
  return (card.tags ?? []).some(t => t.trim().toLowerCase() === want);
}

// Title-case a kind slug into a section heading, e.g. "reading-list" → "Reading
// lists". Keeps unknown kinds presentable without any bespoke code.
export function humanizeKind(kind: string): string {
  const words = kind.replace(/[-_]+/g, ' ').trim();
  if (!words) return 'Cards';
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return titled.endsWith('s') ? titled : titled + 's';
}
