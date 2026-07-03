import { open, type DB, type Transaction } from '@op-engineering/op-sqlite';

/**
 * The single SQLite database file that backs the whole app. One connection,
 * opened lazily and shared process-wide — every storage module talks to it.
 *
 * This replaces react-native-mmkv: notes, notebooks, full-text search and the
 * key/value store all live in this one file so there is a single source of
 * truth (see `storage/pages.ts`, `storage/notebooks.ts`, `storage/kv.ts`).
 */
const DB_NAME = 'ainotepad.sqlite';

/**
 * Current schema version. Bump this and add a branch in {@link migrate} when
 * the schema changes; `PRAGMA user_version` (stored inside the file) records
 * how far a given device has migrated, so upgrades are applied exactly once.
 */
const SCHEMA_VERSION = 1;

/**
 * The app is notebook-scoped from day one: every page belongs to a notebook.
 * Today there is exactly one — this id — so nothing in the UI has to choose a
 * notebook yet. When multiple notebooks land it becomes just another row and a
 * picker; no schema change or data backfill is required.
 */
export const DEFAULT_NOTEBOOK_ID = 'default';

let connection: DB | null = null;

/**
 * Return the shared database connection, opening and migrating it on first use.
 *
 * Schema setup runs synchronously here (via `executeSync`) so that by the time
 * any query runs the tables, triggers and indexes are guaranteed to exist.
 */
export function getDb(): DB {
  if (connection) {
    return connection;
  }

  const db = open({ name: DB_NAME });
  // WAL gives us concurrent reads during writes; foreign keys must be enabled
  // per-connection (SQLite defaults them off) for the ON DELETE CASCADE below.
  db.executeSync('PRAGMA journal_mode = WAL');
  db.executeSync('PRAGMA foreign_keys = ON');
  migrate(db);

  connection = db;
  return db;
}

/**
 * Run every {@link Transaction}-wrapped write through here so a thrown error
 * rolls the whole batch back rather than leaving a half-applied change. Used by
 * the migration and by multi-statement writes.
 */
export function tx(fn: (t: Transaction) => Promise<void>): Promise<void> {
  return getDb().transaction(fn);
}

/** Apply any schema migrations the open database has not seen yet. */
function migrate(db: DB): void {
  // The base schema is fully idempotent (every statement is IF NOT EXISTS), so
  // we run it on every launch rather than gating on user_version. This makes a
  // partially-created database self-heal — e.g. one left with only some tables
  // by an interrupted run — instead of being permanently stuck.
  //
  // op-sqlite's execute runs a SINGLE statement per call, so each DDL statement
  // is applied on its own; a multi-statement blob would silently run only the
  // first.
  for (const statement of SCHEMA_V1) {
    db.executeSync(statement);
  }

  // Reserved for future incremental migrations, which DO gate on the version:
  //   const current = readUserVersion(db);
  //   if (current < 2) { ...alter... }
  db.executeSync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * Initial schema.
 *
 * `pages_fts` is an FTS5 *external-content* index: it stores only the search
 * index, reading the actual text from `pages`. Because FTS rows are keyed by an
 * integer rowid but `pages.id` is a TEXT uuid, the triggers sync on `pages`'s
 * implicit integer `rowid`, and searches join `pages.rowid = pages_fts.rowid`.
 *
 * `title`, `folder_id` and `tags` are forward-looking placeholders defaulted to
 * empty string: titles will be AI-generated later; folders and tags are not
 * built yet. They ride along in every row so adding those features needs no
 * schema migration.
 */
const SCHEMA_V1 = [
  `CREATE TABLE IF NOT EXISTS notebooks (
    id         TEXT PRIMARY KEY NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS pages (
    id          TEXT PRIMARY KEY NOT NULL,
    notebook_id TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL DEFAULT '',
    folder_id   TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS idx_pages_notebook_updated
    ON pages(notebook_id, updated_at DESC)`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    title,
    content,
    content='pages',
    content_rowid='rowid'
  )`,

  `CREATE TRIGGER IF NOT EXISTS pages_fts_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts(rowid, title, content)
    VALUES (new.rowid, new.title, new.content);
  END`,

  `CREATE TRIGGER IF NOT EXISTS pages_fts_ad AFTER DELETE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.title, old.content);
  END`,

  `CREATE TRIGGER IF NOT EXISTS pages_fts_au AFTER UPDATE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.title, old.content);
    INSERT INTO pages_fts(rowid, title, content)
    VALUES (new.rowid, new.title, new.content);
  END`,

  `CREATE TABLE IF NOT EXISTS key_value (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )`,
];

/** Close and forget the connection. Test-only — production keeps it open. */
export function _closeDbForTests(): void {
  connection?.close();
  connection = null;
}
