import { createId } from '../utils/id';
import type { Note } from '../types/note';
import { DEFAULT_NOTEBOOK_ID, getDb } from './db';
import { ensureDefaultNotebook } from './notebooks';
import { countPages, createPage } from './pages';

/**
 * Public storage surface. The rest of the app imports from here and never
 * touches op-sqlite or raw SQL directly.
 */
export { DEFAULT_NOTEBOOK_ID } from './db';
export {
  getPage,
  listPages,
  createPage,
  updatePage,
  updatePageTitle,
  deletePage,
  searchPages,
} from './pages';
export { getValue, setValue, deleteValue } from './kv';
export {
  listNotebooks,
  createNotebook,
  renameNotebook,
  deleteNotebook,
} from './notebooks';

/** A little content so the pad isn't empty on first launch (written once). */
function seedNotes(now: number): Note[] {
  return [
    {
      id: createId(),
      content:
        '# Welcome to your pad\n\n' +
        'Swipe left and right to flip through pages.\n\n' +
        'This editor speaks **markdown**:\n' +
        '- *italic* and **bold**\n' +
        '- `inline code`\n' +
        '- > blockquotes\n\n' +
        'Tap the last page to start a fresh note.',
      title: '',
      createdAt: now,
      updatedAt: now,
    },
  ];
}

let initPromise: Promise<void> | null = null;

/**
 * Prepare storage for use. Opens/migrates the database, guarantees the default
 * notebook exists, then seeds first-run content if (and only if) there are still
 * no pages. Safe to call repeatedly — the work happens once per process.
 */
export function initStorage(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const now = Date.now();
      getDb(); // open + run schema migrations up front
      await ensureDefaultNotebook(now);

      if ((await countPages()) === 0) {
        for (const note of seedNotes(now)) {
          await createPage(note, DEFAULT_NOTEBOOK_ID);
        }
      }
    })().catch(error => {
      // Don't cache a failed init — clear it so a later call (e.g. a retry from
      // the UI) can attempt again rather than being stuck on the rejection.
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}
