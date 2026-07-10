/**
 * Pure sorting and presentation logic for dashboard cards — no React, no JSX.
 * Kept separate from the view components so the ordering/formatting rules are
 * easy to find and reason about on their own.
 */
import { mocha } from '../../theme/catppuccin';
import type { DashboardCard } from '../../server/aiController';

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

// Tasks per page in the Tasks card's pager.
export const TASK_PAGE_SIZE = 5;

// Title-case a kind slug into a section heading, e.g. "reading-list" → "Reading
// lists". Keeps unknown kinds presentable without any bespoke code.
export function humanizeKind(kind: string): string {
  const words = kind.replace(/[-_]+/g, ' ').trim();
  if (!words) return 'Cards';
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return titled.endsWith('s') ? titled : titled + 's';
}
