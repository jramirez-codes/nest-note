import { createMMKV } from 'react-native-mmkv';
import type { Transaction } from '@op-engineering/op-sqlite';
import type { Note } from '../types/note';
import { DEFAULT_NOTEBOOK_ID, getDb, tx } from './db';

/**
 * One-time migration of notes from the legacy react-native-mmkv store into
 * SQLite. Runs on every boot but does real work only once.
 *
 * IMPORTANT: this is the ONLY file that imports react-native-mmkv. It exists
 * purely for the transitional build where both libraries are installed. Once
 * the migration is verified on-device and MMKV is uninstalled, delete this file
 * and its call in `storage/index.ts` — the `done` flag in `key_value` means no
 * device will ever need it again.
 *
 * Guarantees:
 * - Idempotent: gated by a flag in `key_value`; a completed migration is skipped.
 * - Atomic: all inserts and the completion flag commit in a single transaction,
 *   so a crash mid-migration rolls everything back and the next launch retries.
 * - Verified: the number of rows inserted must equal the notes read from MMKV,
 *   or the transaction throws and rolls back.
 */

/** Matches the retired MmkvNotesRepository: instance id and per-note key prefix. */
const LEGACY_STORAGE_ID = 'ainotepad.notes';
const LEGACY_KEY_PREFIX = 'note.';

/** Bump the suffix if a future migration must re-run against MMKV. */
const MIGRATION_FLAG_KEY = 'migration:mmkv:v1';
const MIGRATION_DONE = 'done';

export interface MmkvMigrationResult {
  /** True if the migration ran this launch (vs. already-done / nothing to do). */
  ran: boolean;
  /** Number of notes copied into SQLite. */
  migrated: number;
  /** MMKV keys that were present but unparseable, and therefore skipped. */
  skipped: number;
}

/**
 * Migrate legacy MMKV notes into the `pages` table under the default notebook.
 * Must run after {@link ensureDefaultNotebook} (pages reference it) and before
 * any first-run seeding, so imported notes take precedence over seed content.
 */
export async function migrateFromMmkv(): Promise<MmkvMigrationResult> {
  if (await isDone()) {
    return { ran: false, migrated: 0, skipped: 0 };
  }

  const { notes, skipped } = readLegacyNotes();

  // Nothing to migrate (fresh install, or already-cleared MMKV): record the
  // flag so we never re-scan, and let first-run seeding take over.
  if (notes.length === 0) {
    await markDone();
    return { ran: true, migrated: 0, skipped };
  }

  await tx(async t => {
    const before = await countPagesTx(t);
    for (const note of notes) {
      await t.execute(
        `INSERT INTO pages (id, notebook_id, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [note.id, DEFAULT_NOTEBOOK_ID, note.content, note.createdAt, note.updatedAt],
      );
    }
    const after = await countPagesTx(t);

    if (after - before !== notes.length) {
      // Rolls the whole transaction back — no partial import, flag stays unset,
      // next launch retries. Loud so it surfaces in logs.
      throw new Error(
        `MMKV migration row-count mismatch: expected ${notes.length}, ` +
          `inserted ${after - before}. Rolled back; will retry next launch.`,
      );
    }

    // Same transaction as the inserts: if this commits the flag is set, so a
    // successful import can never look un-migrated on the next launch.
    await t.execute(
      `INSERT INTO key_value (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [MIGRATION_FLAG_KEY, MIGRATION_DONE],
    );
  });

  return { ran: true, migrated: notes.length, skipped };
}

/** Read and parse every `note.*` entry out of the legacy MMKV instance. */
function readLegacyNotes(): { notes: Note[]; skipped: number } {
  const storage = createMMKV({ id: LEGACY_STORAGE_ID });
  const notes: Note[] = [];
  let skipped = 0;

  for (const key of storage.getAllKeys()) {
    if (!key.startsWith(LEGACY_KEY_PREFIX)) {
      continue;
    }
    const note = parseNote(storage.getString(key));
    if (note) {
      notes.push(note);
    } else {
      skipped += 1;
    }
  }
  return { notes, skipped };
}

/**
 * Parse a stored MMKV value into a Note, tolerating corrupt entries. Timestamps
 * fall back to now when a legacy record predates them. Mirrors the validation
 * the old repository used so we accept exactly what it would have loaded.
 */
function parseNote(raw: string | undefined): Note | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<Note>;
    if (typeof value.id !== 'string' || typeof value.content !== 'string') {
      return null;
    }
    const created =
      typeof value.createdAt === 'number' ? value.createdAt : Date.now();
    const updated =
      typeof value.updatedAt === 'number' ? value.updatedAt : created;
    return {
      id: value.id,
      content: value.content,
      createdAt: created,
      updatedAt: updated,
    };
  } catch {
    return null;
  }
}

async function isDone(): Promise<boolean> {
  const result = await getDb().execute(
    'SELECT value FROM key_value WHERE key = ?',
    [MIGRATION_FLAG_KEY],
  );
  return result.rows?.[0]?.value === MIGRATION_DONE;
}

async function markDone(): Promise<void> {
  await getDb().execute(
    `INSERT INTO key_value (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [MIGRATION_FLAG_KEY, MIGRATION_DONE],
  );
}

async function countPagesTx(t: Transaction): Promise<number> {
  const result = await t.execute('SELECT COUNT(*) AS n FROM pages');
  return Number(result.rows?.[0]?.n ?? 0);
}
