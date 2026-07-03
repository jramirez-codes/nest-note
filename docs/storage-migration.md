# Storage migration: MMKV → op-sqlite

The app's storage moved from `react-native-mmkv` to a single SQLite database via
`@op-engineering/op-sqlite`. SQLite is now the only source of truth: notes,
notebooks, full-text search, and the key/value store all live in one file.

## Architecture

```
src/storage/
  db.ts               connection singleton, schema, PRAGMA user_version migrations, tx()
  notebooks.ts        notebooks table (one default notebook today; multi-notebook ready)
  pages.ts            getPage / listPages / createPage / updatePage / deletePage / searchPages
  kv.ts               getValue / setValue / deleteValue  (replaces MMKV misc state)
  migrateFromMmkv.ts  one-time MMKV import (ONLY file importing react-native-mmkv)
  index.ts            initStorage() + public surface the app imports
```

- Every page belongs to a notebook (`DEFAULT_NOTEBOOK_ID` for now). Multiple
  notebooks later = a picker + passing a real id; no schema change.
- `pages_fts` is an FTS5 external-content index kept in sync by triggers.
  `searchPages` ranks with `bm25(title 10×, content 1×)`.
- `title`, `folder_id`, `tags` are empty-string placeholders today (title will be
  AI-generated later; folders/tags not built yet).
- `initStorage()` runs on boot before any screen renders (gated in `App.tsx`):
  open + migrate schema → ensure default notebook → import MMKV → seed if empty.

## This is the transitional build

`react-native-mmkv` is **still installed on purpose**. The migration can only
read old MMKV data while MMKV is present. Do not uninstall it until the checklist
below passes on a real build.

### FTS5 must be enabled at build time

op-sqlite ships with FTS5 **disabled by default**. Full-text search (`pages_fts`,
`searchPages`) requires it, so `package.json` sets:

```json
"op-sqlite": { "fts5": true }
```

This is a native compile flag (baked into the SQLite build via the iOS podspec /
Android gradle). Changing it requires a native rebuild — a Metro/JS reload will
NOT pick it up. Without it, schema creation throws `no such module: fts5` and the
app hangs on the loading spinner.

Because op-sqlite is a native module, you must rebuild native code:

```bash
# iOS
cd ios && pod install && cd ..     # re-reads the podspec → enables FTS5
npx react-native run-ios

# Android (gradle reads package.json at configure time; clean to be safe)
cd android && ./gradlew clean && cd ..
npx react-native run-android
```

## Test checklist

Run these on a device/simulator (the storage layer needs the native module; it
cannot be exercised from Node/Jest). Local gates that DO pass: `npx tsc --noEmit`
and `npx eslint`.

### A. Migration correctness (upgrade path)
- [ ] Install the **pre-migration** build (MMKV), create several notes with
      distinct content, force-quit.
- [ ] Install this build over it. On launch, notes appear unchanged (same
      content, same created/updated order).
- [ ] Logs show `[storage] migrated N note(s) from MMKV` with N = the count you
      created.
- [ ] Relaunch: no re-migration log (idempotent — the `migration:mmkv:v1` flag in
      `key_value` is set), notes still present exactly once (no duplicates).
- [ ] Edit/add/delete a note, relaunch: changes persisted by SQLite, not MMKV.
- [ ] (Rollback) Simulate failure by temporarily throwing inside the migration
      transaction → DB is untouched, flag stays unset, next clean launch retries.

### B. Create / update / delete
- [ ] Tap the trailing sheet → new blank page 0 appears and persists across relaunch.
- [ ] Type into a page; relaunch → content is saved.
- [ ] Editing a page does **not** reorder the list while typing.
- [ ] Delete a page → gone after relaunch.

### C. Search (FTS5)
- [ ] `searchPages(DEFAULT_NOTEBOOK_ID, 'word')` returns pages containing the word,
      most relevant first.
- [ ] Partial/prefix query (e.g. `mark` matches `markdown`) works.
- [ ] Deleting/editing a page updates results (triggers keep the index in sync).
- [ ] Empty or punctuation-only query returns `[]` (no crash).
- [ ] Special characters in the query (`"`, `*`, `(`) do not throw.

### D. Key/value store
- [ ] `setValue('k','v')` then `getValue('k')` → `'v'`.
- [ ] Overwrite the same key → latest value wins.
- [ ] `getValue` on an unset key → `null`. `deleteValue` removes it.

### E. Fresh install (no legacy data)
- [ ] Delete the app, install this build. First launch seeds the welcome note.
- [ ] Migration logs nothing migrated (0 notes), no crash, flag still recorded.
- [ ] Create/edit/search all work.

## Finalizing: remove MMKV (only after the checklist passes)

Once verified on-device:

1. Delete `src/storage/migrateFromMmkv.ts`.
2. In `src/storage/index.ts`, remove the `migrateFromMmkv` import and its call in
   `initStorage()` (the seed-if-empty block stays).
3. Uninstall the package:
   ```bash
   npm uninstall react-native-mmkv --legacy-peer-deps
   cd ios && pod install && cd ..     # drops the MMKV/Nitro pod
   ```
4. `react-native-nitro-modules` is an MMKV peer dep — keep it only if another
   library uses it; otherwise remove it the same way.
5. Rebuild both platforms and re-run checklist section **E** (fresh install) to
   confirm the app is healthy with no MMKV dependency present at all.

No Podfile/Gradle edits are needed either way: MMKV v4 and op-sqlite both
autolink; the only native reference to MMKV is generated build output.
