---
title: Using the pad
description: The paging model, the live-preview markdown editor, and how notes are titled and stored.
sidebar:
  order: 2
---

The interface is deliberately small. There is no file browser, no note list, no
save button — there is a pad, and you flip through it.

## Pages, not files

Each note is a **full-screen page**. Swipe left or right to move between them.
The last page is always a blank sheet; tapping it starts a new note. That's the
entire navigation model.

Because a page is the unit of everything, there's no concept of "opening" or
"closing" a note. Edits persist to SQLite as you type.

## Live-preview markdown

Text is edited with [CodeMirror 6](https://codemirror.net/) running inside a
WebView, giving Obsidian-style live preview: markdown syntax marks hide to
render clean text, and reveal again on the line your cursor is on.

The important property is that **markdown is the stored format**. The editor
reads and writes plain markdown, so:

- existing notes from anywhere else just work,
- there is no data migration when the editor changes,
- and what you'd get out of the database is exactly what you typed.

## Titles are derived, not stored

Page previews come from `deriveTitle(content)` — a pure function over the note
body. Nothing derived is written to the database, so there is nothing to keep
in sync and nothing to get stale.

The one exception is the **AI-generated title** set by
[`/clean`](../commands/writing.md). That's a separate field, and it is
deliberately left untouched by subsequent content edits — otherwise a title you
asked for would silently disappear the next time you fixed a typo.

## Search

Search is backed by SQLite's FTS5 index, ranked with
`bm25(title 10×, content 1×)` — title matches count for ten times more than
body matches. Reach it with [`/search`](../commands/writing.md), which works
entirely offline; it's a local index, not a server feature.

## What's stored where

Everything lives in one `nestnote.sqlite` file on the device: notes,
notebooks, the full-text index, a key/value store, and the bodies of AI cards.
There are no accounts, no cloud sync, and no third-party service holding your
notes.

The [storage architecture](../architecture/storage.md) page covers the schema
and migration strategy if you want the details.
