/**
 * Unit tests for buildBadge — the pure mapping from the build stamp a card carries
 * to the state badge its dashboard row wears. This is the whole of what the Ideas
 * and build-step rows know about a build (the list never fetches /build), so the
 * cases below are the states a row can actually be found in.
 */
// buildApi is the /build client as well as these pure helpers, so importing it
// otherwise drags the native transport (and react-native itself) into a test that
// makes no request. Stubbed like ideaUndo stubs its controller.
jest.mock('../src/server/transport/connection', () => ({
  getTransport: () => null,
  currentServer: () => Promise.resolve(null),
  serverOrigin: () => '',
  NO_MODULE: 'no transport in tests',
}));

import { buildBadge, startLabel } from '../src/server/controllers/buildApi';
import type { DashboardCard } from '../src/server/controllers/dashboardApi';

// A card carrying the stamp the server writes onto both the idea a build came from
// and every step card it files.
const carded = (build?: Record<string, unknown>): DashboardCard => ({
  id: 'c1',
  kind: build ? 'build-step' : 'idea',
  priority: 'normal',
  title: 'Sensor rig',
  ...(build ? { payload: { build } } : {}),
});

// An ISO instant `minutes` from now — how a start time reaches the card.
const inMinutes = (minutes: number): string =>
  new Date(Date.now() + minutes * 60000).toISOString();

describe('buildBadge', () => {
  test('a card no build has touched wears no badge', () => {
    expect(buildBadge(carded())).toBeNull();
    // A stamp with no slug isn't a build the app can act on, so it isn't one it
    // reports either.
    expect(buildBadge(carded({ status: 'building' }))).toBeNull();
  });

  test('a scheduled build says so, and says when', () => {
    const at = inMinutes(90);
    const badge = buildBadge(carded({ slug: 'sensor-rig', status: 'scheduled', start_at: at }));
    expect(badge).toEqual({
      tone: 'scheduled',
      label: 'Scheduled',
      detail: startLabel(new Date(at)),
    });
  });

  test('a run in flight reads as running, whichever run it is', () => {
    expect(buildBadge(carded({ slug: 's', status: 'planning' }))).toEqual({
      tone: 'running',
      label: 'Planning',
    });
    expect(buildBadge(carded({ slug: 's', status: 'building', feature: 2 }))).toEqual({
      tone: 'running',
      label: 'Building',
    });
  });

  test('a step with the next feature placed is scheduled, like any placed run', () => {
    const at = inMinutes(24 * 60);
    const badge = buildBadge(
      carded({ slug: 's', status: 'awaiting-validation', feature: 2, start_at: at }),
    );
    expect(badge).toEqual({
      tone: 'scheduled',
      label: 'Scheduled',
      detail: startLabel(new Date(at)),
    });
  });

  test('a step with nothing placed is waiting on the user', () => {
    expect(buildBadge(carded({ slug: 's', status: 'awaiting-validation', feature: 2 }))).toEqual({
      tone: 'waiting',
      label: 'Waiting on you',
    });
  });

  test('a stopped build carries why it stopped', () => {
    expect(
      buildBadge(carded({ slug: 's', status: 'halted', note: 'feature 2 was rejected' })),
    ).toEqual({
      tone: 'stopped',
      label: 'Stopped',
      detail: 'feature 2 was rejected',
    });
    // Stopped by a build old enough to have no note on it: still a badge, because
    // "Stopped" is the fact and the reason is the elaboration.
    expect(buildBadge(carded({ slug: 's', status: 'halted' }))).toEqual({
      tone: 'stopped',
      label: 'Stopped',
    });
  });

  test('a finished build reads as done', () => {
    expect(buildBadge(carded({ slug: 's', status: 'done' }))).toEqual({
      tone: 'done',
      label: 'Done',
    });
  });

  test('a status this app does not know renders itself rather than nothing', () => {
    expect(buildBadge(carded({ slug: 's', status: 'deploying' }))).toEqual({
      tone: 'waiting',
      label: 'deploying',
    });
    expect(buildBadge(carded({ slug: 's', status: '' }))).toBeNull();
  });
});
