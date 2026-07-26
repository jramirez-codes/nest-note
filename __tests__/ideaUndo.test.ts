/**
 * Unit tests for the idea page's undo bookkeeping in ../src/server/ideaChat.
 *
 * The store is what decides whether the page offers an Undo at all: it snapshots
 * the card when a turn is sent and keeps that snapshot only if the turn actually
 * rewrote the idea. Most turns are questions and answers that change nothing, and
 * offering to "undo" one of those would be a lie about what the button does.
 */
import type { DashboardCard } from '../src/server/controllers/dashboardApi';

interface Cb {
  onDelta: (a: string) => void;
  onDone: (a: string) => void;
  onError: (msg: string, partial: string) => void;
}
const mockTurns: Cb[] = [];
const mockRestore = jest.fn<Promise<void>, unknown[]>(() => Promise.resolve());

jest.mock('../src/server/controllers/aiController', () => ({
  runIdeaChat: (_idea: unknown, _q: string, cb: Cb) => {
    mockTurns.push(cb);
    return { cancel: jest.fn() };
  },
  restoreCard: (...args: unknown[]) => mockRestore(...args),
  cardContent: (c: Partial<DashboardCard> & { title: string }) => ({
    title: c.title,
    body: c.body ?? '',
    tags: c.tags ?? [],
    priority: c.priority ?? 'normal',
  }),
}));

import * as ideaChat from '../src/server/ideaChat';

const card = (over: Partial<DashboardCard> & { id: string }): DashboardCard => ({
  kind: 'idea',
  priority: 'normal',
  title: 'An idea',
  body: '## Problem\n\nAs filed.\n',
  source: 'storage',
  ...over,
});

beforeEach(() => {
  mockTurns.length = 0;
  mockRestore.mockClear();
  mockRestore.mockResolvedValue(undefined);
});

test('a turn that rewrites the idea leaves something to undo; one that only answers does not', () => {
  ideaChat.send(card({ id: 'a' }), 'split the plan in two');
  mockTurns[0].onDone('Done — split it.');
  // The page re-reads the card after every turn and sends the fresh copy into the
  // next one, so the snapshot is always the idea as it currently reads.
  const rewritten = card({ id: 'a', body: '## Problem\n\nRewritten.\n' });
  ideaChat.recordCard(rewritten);
  expect(ideaChat.canUndo('a')).toBe(true);

  // A second turn that changes nothing must not stack a no-op undo on top.
  ideaChat.send(rewritten, 'why did you split it?');
  mockTurns[1].onDone('Because…');
  ideaChat.recordCard(rewritten);
  expect(ideaChat.getThread('a').undo).toHaveLength(1);
});

test('a re-read taken mid-turn is ignored, so the edit that turn makes stays undoable', () => {
  ideaChat.send(card({ id: 'b' }), 'tighten the next steps');
  // The page reopened while the turn was still streaming and re-read the card.
  ideaChat.recordCard(card({ id: 'b' }));
  expect(ideaChat.getThread('b').pending).toBeDefined();

  mockTurns[0].onDone('Tightened.');
  ideaChat.recordCard(card({ id: 'b', body: '## Next steps\n\nTighter.\n' }));
  expect(ideaChat.canUndo('b')).toBe(true);
});

test('undoing writes the pre-edit snapshot back and steps back one edit at a time', async () => {
  const filed = card({ id: 'c', title: 'As filed', tags: ['storage'] });
  ideaChat.send(filed, 'first change');
  mockTurns[0].onDone('ok');
  const once = card({ id: 'c', title: 'Claude v1', body: 'v1', tags: ['storage'] });
  ideaChat.recordCard(once);

  ideaChat.send(once, 'second change');
  mockTurns[1].onDone('ok');
  const twice = card({ id: 'c', title: 'Claude v2', body: 'v2', tags: ['storage', 'v2'] });
  ideaChat.recordCard(twice);
  expect(ideaChat.getThread('c').undo).toHaveLength(2);

  await ideaChat.undoLast(twice);
  expect(mockRestore).toHaveBeenLastCalledWith(
    'c',
    { title: 'Claude v1', body: 'v1', tags: ['storage'], priority: 'normal' },
    'storage',
  );

  await ideaChat.undoLast(once);
  expect(mockRestore).toHaveBeenLastCalledWith(
    'c',
    { title: 'As filed', body: '## Problem\n\nAs filed.\n', tags: ['storage'], priority: 'normal' },
    'storage',
  );
  expect(ideaChat.canUndo('c')).toBe(false);
});

test('a failed undo keeps the snapshot, so the button is a retry rather than a lost revert', async () => {
  const filed = card({ id: 'd' });
  ideaChat.send(filed, 'change it');
  mockTurns[0].onDone('ok');
  const edited = card({ id: 'd', body: 'edited' });
  ideaChat.recordCard(edited);

  mockRestore.mockRejectedValueOnce(new Error('Action failed (HTTP 503).'));
  await expect(ideaChat.undoLast(edited)).rejects.toThrow('503');
  expect(ideaChat.canUndo('d')).toBe(true);

  await ideaChat.undoLast(edited);
  expect(ideaChat.canUndo('d')).toBe(false);
});

test('deleting the transcript keeps the undo history — the edits it reverts are still on the card', () => {
  const filed = card({ id: 'e' });
  ideaChat.send(filed, 'change it');
  mockTurns[0].onDone('ok');
  ideaChat.recordCard(card({ id: 'e', body: 'edited' }));

  ideaChat.clear('e');
  expect(ideaChat.getThread('e').turns).toHaveLength(0);
  expect(ideaChat.canUndo('e')).toBe(true);
});
