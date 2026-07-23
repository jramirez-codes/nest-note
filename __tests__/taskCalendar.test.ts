/**
 * Unit tests for the calendar view's pure date/bucketing helpers — the logic behind
 * the Tasks section's month grid, its per-day task lists, and the priority-tinted pips.
 */
import {
  buildMonthGrid,
  dateKey,
  relDate,
  tasksByDueDate,
  topPriority,
} from '../src/components/dashboard/cardModel';
import type { DashboardCard } from '../src/server/controllers/dashboardApi';

const task = (over: Partial<DashboardCard>): DashboardCard => ({
  id: over.id ?? 'x',
  kind: 'task',
  priority: over.priority ?? 'normal',
  title: over.title ?? 'A task',
  ...over,
});

describe('dateKey', () => {
  test('keeps just the YYYY-MM-DD, dropping any time part', () => {
    expect(dateKey('2026-07-22')).toBe('2026-07-22');
    expect(dateKey('2026-07-22T15:04:00Z')).toBe('2026-07-22');
  });
  test('returns null for missing or malformed dates', () => {
    expect(dateKey(undefined)).toBeNull();
    expect(dateKey('')).toBeNull();
    expect(dateKey('soon')).toBeNull();
  });
});

describe('relDate', () => {
  // A YYYY-MM-DD key `offset` days from local midnight today.
  const keyDaysFromNow = (offset: number): string => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  test('names today, tomorrow, and yesterday', () => {
    expect(relDate(keyDaysFromNow(0)).label).toBe('Today');
    expect(relDate(keyDaysFromNow(1)).label).toBe('Tomorrow');
    expect(relDate(keyDaysFromNow(-1))).toEqual({ label: 'Yesterday', overdue: true });
  });

  test('counts down future days 2–7 out as "X days", not a calendar date', () => {
    expect(relDate(keyDaysFromNow(2)).label).toBe('2 days');
    expect(relDate(keyDaysFromNow(3)).label).toBe('3 days');
    expect(relDate(keyDaysFromNow(7)).label).toBe('7 days');
    expect(relDate(keyDaysFromNow(2)).overdue).toBe(false);
  });

  test('spells out the calendar date past the 7-day window', () => {
    expect(relDate(keyDaysFromNow(8)).label).not.toMatch(/days$/);
    expect(relDate(keyDaysFromNow(8)).overdue).toBe(false);
  });

  test('past dates beyond yesterday stay a calendar date and read overdue', () => {
    const rel = relDate(keyDaysFromNow(-5));
    expect(rel.overdue).toBe(true);
    expect(rel.label).not.toMatch(/days$/);
  });
});

describe('buildMonthGrid', () => {
  // July 2026 (month index 6): the 1st is a Wednesday, July has 31 days.
  const grid = buildMonthGrid(2026, 6);

  test('is always six full weeks (42 cells)', () => {
    expect(grid).toHaveLength(42);
  });

  test('starts on the Sunday on/before the 1st and pads the tail with the next month', () => {
    // July 1 2026 is a Wednesday → three leading June days (Sun 28, Mon 29, Tue 30).
    expect(grid.slice(0, 3).map(c => c.inMonth)).toEqual([false, false, false]);
    expect(grid[0].key).toBe('2026-06-28');
    expect(grid[3]).toMatchObject({ key: '2026-07-01', day: 1, inMonth: true });
    // The month's last day is in-grid, and every trailing cell is next month.
    expect(grid.filter(c => c.inMonth)).toHaveLength(31);
    expect(grid[grid.length - 1].inMonth).toBe(false);
  });

  test('rolls the year over correctly for December', () => {
    const dec = buildMonthGrid(2026, 11);
    expect(dec.find(c => c.inMonth && c.day === 31)?.key).toBe('2026-12-31');
    // Trailing days belong to January of the next year.
    expect(dec[dec.length - 1].key.startsWith('2027-01')).toBe(true);
  });
});

describe('tasksByDueDate', () => {
  test('buckets dated tasks by day and drops undated ones', () => {
    const cards = [
      task({ id: 'a', date: '2026-07-22' }),
      task({ id: 'b', date: '2026-07-22T09:00:00Z' }),
      task({ id: 'c', date: '2026-07-23' }),
      task({ id: 'd' }), // no date → dropped
    ];
    const byDay = tasksByDueDate(cards);
    expect(byDay.get('2026-07-22')?.map(c => c.id)).toEqual(['a', 'b']);
    expect(byDay.get('2026-07-23')?.map(c => c.id)).toEqual(['c']);
    expect(byDay.size).toBe(2);
  });
});

describe('topPriority', () => {
  test('reports the highest-urgency priority present', () => {
    expect(topPriority([task({ priority: 'low' }), task({ priority: 'urgent' })])).toBe('urgent');
    expect(topPriority([task({ priority: 'low' }), task({ priority: 'high' })])).toBe('high');
  });
  test('defaults to normal for an empty set', () => {
    expect(topPriority([])).toBe('normal');
  });
});
