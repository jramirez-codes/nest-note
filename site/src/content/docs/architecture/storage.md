---
title: Storage
description: The SQLite layer — schema, modules, migrations, and the FTS5 build flag.
sidebar:
  order: 2
---

All app state lives in a single SQLite database (`nestnote.sqlite`) via
[op-sqlite](https://github.com/OP-Engineering/op-sqlite). SQLite is the only
source of truth: notes, notebooks, full-text search, the key/value store, and
bulky AI-card bodies all live in one file. The rest of the app imports only
from `src/storage/` and never touches SQL directly.

## Modules

```
src/storage/
  db.ts             connection singleton, schema + migrations, tx()
  notebooks.ts      notebooks table (one default notebook today; multi-notebook ready)
  pages.ts          getPage / listPages / createPage / updatePage / deletePage / searchPages
  kv.ts             getValue / setValue / deleteValue  (misc app state, e.g. the server pairing)
  cardPayloads.ts   large AI-card bodies, kept out of page markdown (see below)
  recordings.ts     metadata for /record clips
  index.ts          initStorage() + the public surface the app imports
```

## Key behaviors

**`initStorage()`** runs once on boot, before any screen renders (gated in
`App.tsx`): open and migrate the schema → ensure the default notebook exists →
seed the welcome note if the pad is empty. It's idempotent and safe to call
repeatedly.

**Every page belongs to a notebook** (`DEFAULT_NOTEBOOK_ID` for now). Multiple
notebooks later means a picker and passing a real id — no schema change needed.

**`pages_fts`** is an FTS5 external-content index kept in sync by triggers.
`searchPages` ranks with `bm25(title 10×, content 1×)`, so a title match counts
for ten times more than a body match.

**Placeholder columns.** `title`, `folder_id` and `tags` are empty-string
placeholders today — title is set by `/clean`; folders and tags aren't built
yet. They ride along in every row so adding those features needs no migration.

**`card_payloads`** holds bulky AI-card bodies (a `/code` transcript, `/run`
output, a `/clean` backup) keyed by the card's marker id, so large transcripts
don't bloat `pages.content` — which is serialized over the WebView bridge on
every keystroke. An `ON DELETE CASCADE` reclaims a page's card bodies with it.

## Schema migrations

`db.ts` records how far a device has migrated in `PRAGMA user_version`. The
base schema is fully idempotent — every statement is `IF NOT EXISTS` — and
re-run on every launch, so a partially-created database self-heals.

To evolve the schema: bump `SCHEMA_VERSION` and add a version-gated branch in
`migrate()`.

## FTS5 must be enabled at build time

op-sqlite ships with FTS5 **disabled by default**. Full-text search
(`pages_fts`, `searchPages`) requires it, so `package.json` sets:

```json
"op-sqlite": { "fts5": true }
```

This is a native compile flag, baked into the SQLite build via the iOS podspec
and Android Gradle config. Changing it requires a native rebuild — a Metro or
JS reload will **not** pick it up. Without it, schema creation throws
`no such module: fts5` and the app hangs on the loading spinner.

After changing it:

```bash
# iOS
cd ios && pod install && cd ..     # re-reads the podspec → enables FTS5
npx react-native run-ios

# Android (gradle reads package.json at configure time; clean to be safe)
cd android && ./gradlew clean && cd ..
npx react-native run-android
```

## History

Storage was originally `react-native-mmkv` and was migrated to op-sqlite with a
one-time in-app import. That migration is **complete**: MMKV and the import
shim (`migrateFromMmkv.ts`) have been removed, and SQLite is the sole store.
