---
title: Overview
description: How the app is layered, and the design choices that keep it extensible.
sidebar:
  order: 1
---

The code is organized into small, single-responsibility layers so features can
be added without churn.

```
src/
  types/       Domain model (Note) and pure helpers (deriveTitle)
  storage/     SQLite persistence — the single source of truth
  hooks/       useNotes / useNotebookPages / useServerStatus — state + actions
  theme/       Semantic color tokens (Catppuccin Mocha)
  components/  UI pieces: NoteEditorWebView, PaperPager, DashboardPage, headers…
  screens/     NotebookScreen — composes the paged pad
  server/      Client for the companion server's pinned-TLS protocol
  webview/     editorHtml.ts — the generated editor bundle (do not edit by hand)
  native/      wakeLock and other platform shims
  utils/       Framework-agnostic helpers (id, date, async)
```

## Design choices that keep it scalable

**SQLite is the single source of truth.** Notes, notebooks, full-text search
and a key/value store all live in one `nestnote.sqlite` file. The app imports
only from `src/storage/` and never touches SQL directly. `initStorage()` —
called once in `App.tsx` — opens and migrates the database before any screen
renders. See [storage](./storage.md).

**Derived data isn't stored.** Previews come from `deriveTitle(content)`, so
there's nothing to keep in sync and nothing to go stale. The one deliberate
exception is the AI-generated page title set by `/clean`.

**Pages are memoized and self-scoped.** Editing one page doesn't re-render its
neighbors, and each editor owns its text, so the caret never jumps.

**The server client is platform-agnostic.** `src/server/` knows only the shape
of the bytes on the wire. The same code runs under Node in a proof harness and
under React Native in the app; only the pinned-socket transport
(`nativeTransport.ts`) is native. See [the protocol](./protocol.md).

**Unattended work is triggered from outside, but never *runs* outside.**
[Scheduled builds](../server/builds.mdx) (`server/internal/build/`, `server/internal/cron/`)
put real entries in the user's crontab, and those entries do nothing but `POST
/build/tick` on the local server. The agent run itself happens in the server
process, so it inherits the same environment every other run gets — cron's
stripped-down environment could never reproduce it. The Go server also owns every
crontab mutation; the agent never touches it.

## Where new features slot in

The seams are deliberate:

| Feature                | Where it goes                                                        |
| ---------------------- | -------------------------------------------------------------------- |
| Search / sort          | `useNotes`                                                           |
| Tags, folders          | The `Note` type — the columns already exist as placeholders          |
| Multiple notebooks     | A picker plus a real id; the schema has been notebook-scoped from day one |

Today there is a single `DEFAULT_NOTEBOOK_ID`. Nothing about the schema assumes
that stays true.
