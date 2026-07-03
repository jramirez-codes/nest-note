import { getDb } from './db';

/**
 * String key/value store, the SQLite replacement for the miscellaneous state
 * MMKV used to hold (last-opened page, editor draft/autosave, UI preferences,
 * recently-viewed ids, migration flags — anything that isn't a note).
 *
 * Values are opaque strings; callers serialize/parse their own shapes (e.g.
 * `JSON.stringify`) so this stays a dumb, general store.
 */

/** Return the stored value for `key`, or `null` if it has never been set. */
export async function getValue(key: string): Promise<string | null> {
  const result = await getDb().execute(
    'SELECT value FROM key_value WHERE key = ?',
    [key],
  );
  const row = result.rows?.[0];
  return row ? String(row.value) : null;
}

/** Insert or overwrite the value for `key`. */
export async function setValue(key: string, value: string): Promise<void> {
  await getDb().execute(
    `INSERT INTO key_value (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/** Remove a key. No-op if it does not exist. */
export async function deleteValue(key: string): Promise<void> {
  await getDb().execute('DELETE FROM key_value WHERE key = ?', [key]);
}
