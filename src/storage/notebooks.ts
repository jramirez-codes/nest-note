import { createId } from '../utils/id';
import { DEFAULT_NOTEBOOK_ID, getDb } from './db';
import { cleanupRecordings } from './recordings';

/**
 * A notebook is the top-level container: every page belongs to exactly one.
 * Today the app runs against a single default notebook, but the table and this
 * module exist so "multiple notebooks" is later just a UI + picker addition.
 */
export interface Notebook {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

function mapRow(row: Record<string, unknown>): Notebook {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Guarantee the default notebook exists so page writes always have a valid
 * `notebook_id` to reference. Idempotent — safe to call on every launch.
 */
export async function ensureDefaultNotebook(now: number): Promise<void> {
  await getDb().execute(
    `INSERT INTO notebooks (id, title, created_at, updated_at)
     VALUES (?, '', ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [DEFAULT_NOTEBOOK_ID, now, now],
  );
}

/** All notebooks, newest first. */
export async function listNotebooks(): Promise<Notebook[]> {
  const result = await getDb().execute(
    'SELECT * FROM notebooks ORDER BY created_at DESC',
  );
  return (result.rows ?? []).map(mapRow);
}

/** Create a new notebook and return it. */
export async function createNotebook(
  title: string,
  now: number,
): Promise<Notebook> {
  const notebook: Notebook = {
    id: createId(),
    title,
    createdAt: now,
    updatedAt: now,
  };
  await getDb().execute(
    `INSERT INTO notebooks (id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    [notebook.id, notebook.title, notebook.createdAt, notebook.updatedAt],
  );
  return notebook;
}

/** Rename a notebook. */
export async function renameNotebook(
  id: string,
  title: string,
  now: number,
): Promise<void> {
  await getDb().execute(
    'UPDATE notebooks SET title = ?, updated_at = ? WHERE id = ?',
    [title, now, id],
  );
}

/**
 * Delete a notebook and, via `ON DELETE CASCADE`, all of its pages. No-op if
 * the notebook does not exist.
 */
export async function deleteNotebook(id: string): Promise<void> {
  // The pages vanish via ON DELETE CASCADE (never through deletePage), so reclaim
  // their /record clips here before the rows — and their file paths — are gone.
  const pages = await getDb().execute(
    'SELECT content FROM pages WHERE notebook_id = ?',
    [id],
  );
  for (const row of pages.rows ?? []) cleanupRecordings(String(row.content));
  await getDb().execute('DELETE FROM notebooks WHERE id = ?', [id]);
}
