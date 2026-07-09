import type { Note } from '../types/note';
import { getDb } from './db';
import { cleanupRecordings } from './recordings';

/**
 * Page persistence — the notebook's pages, backed by SQLite with FTS5 search.
 *
 * Every function is scoped by a `notebookId` (except the by-id lookups) so the
 * app is already multi-notebook internally; today the UI passes a single
 * default notebook. The rest of the app calls these functions and never writes
 * SQL directly.
 *
 * The UI only cares about a page's `id`, `content` and timestamps — that is the
 * {@link Note} shape returned here. The extra stored columns (`notebook_id`,
 * `title`, `folder_id`, `tags`) are managed by the storage layer: `title` is
 * left untouched by content edits so a future AI-generated title is never
 * clobbered by typing.
 */

/** Map a `pages` row down to the {@link Note} the UI consumes. */
function mapRow(row: Record<string, unknown>): Note {
  return {
    id: String(row.id),
    content: String(row.content),
    title: String(row.title ?? ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Fetch a single page by id, or `null` if it does not exist. */
export async function getPage(id: string): Promise<Note | null> {
  const result = await getDb().execute(
    'SELECT id, content, title, created_at, updated_at FROM pages WHERE id = ?',
    [id],
  );
  const row = result.rows?.[0];
  return row ? mapRow(row) : null;
}

/** All pages in a notebook, most recently updated first. */
export async function listPages(notebookId: string): Promise<Note[]> {
  const result = await getDb().execute(
    `SELECT id, content, title, created_at, updated_at
     FROM pages WHERE notebook_id = ?
     ORDER BY updated_at DESC`,
    [notebookId],
  );
  return (result.rows ?? []).map(mapRow);
}

/**
 * Insert a new page in `notebookId`. The caller supplies the `Note` (id and
 * timestamps included) so the UI can render optimistically before the write
 * resolves. `title`/`folder_id`/`tags` start blank (see module doc).
 */
export async function createPage(
  note: Note,
  notebookId: string,
): Promise<Note> {
  await getDb().execute(
    `INSERT INTO pages (id, notebook_id, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [note.id, notebookId, note.content, note.createdAt, note.updatedAt],
  );
  return note;
}

/**
 * Update a page's content and `updated_at`. Deliberately does not touch
 * `title` — content edits must not overwrite an AI-generated title.
 */
export async function updatePage(note: Note): Promise<void> {
  await getDb().execute(
    'UPDATE pages SET content = ?, updated_at = ? WHERE id = ?',
    [note.content, note.updatedAt, note.id],
  );
}

/**
 * Set a page's AI-generated `title` (from `/clean`). Kept separate from
 * {@link updatePage} so it doesn't touch `content`; `updated_at` is left alone
 * so re-titling a page never reorders it out from under the user.
 */
export async function updatePageTitle(id: string, title: string): Promise<void> {
  await getDb().execute('UPDATE pages SET title = ? WHERE id = ?', [title, id]);
}

/** Delete a page by id. No-op if it does not exist. */
export async function deletePage(id: string): Promise<void> {
  // Reclaim any /record clips this page held before the markdown is gone.
  const page = await getPage(id);
  if (page) cleanupRecordings(page.content);
  await getDb().execute('DELETE FROM pages WHERE id = ?', [id]);
}

/** Total number of pages across all notebooks (used to decide first-run seed). */
export async function countPages(): Promise<number> {
  const result = await getDb().execute('SELECT COUNT(*) AS n FROM pages');
  return Number(result.rows?.[0]?.n ?? 0);
}

/**
 * Full-text search within a notebook, ranked by bm25 (title weighted 10× over
 * content, so an AI title match outranks a body match). Returns most-relevant
 * first. An empty or all-punctuation query returns no results.
 */
export async function searchPages(
  notebookId: string,
  rawQuery: string,
  limit = 50,
): Promise<Note[]> {
  const match = toMatchQuery(rawQuery);
  if (!match) {
    return [];
  }
  const result = await getDb().execute(
    `SELECT p.id, p.content, p.created_at, p.updated_at
     FROM pages_fts
     JOIN pages p ON p.rowid = pages_fts.rowid
     WHERE pages_fts MATCH ? AND p.notebook_id = ?
     ORDER BY bm25(pages_fts, 10.0, 1.0)
     LIMIT ?`,
    [match, notebookId, limit],
  );
  return (result.rows ?? []).map(mapRow);
}

/**
 * Turn raw user input into a safe FTS5 MATCH string. Each word is stripped of
 * FTS operator characters, wrapped as a quoted string literal (so any remaining
 * punctuation is treated literally, never as syntax) and given a `*` prefix so
 * search matches as the user types. Returns '' when nothing searchable remains.
 */
function toMatchQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/\s+/)
    .map(token => token.replace(/["*]/g, '').trim())
    .filter(Boolean);
  return tokens.map(token => `"${token}"*`).join(' ');
}
