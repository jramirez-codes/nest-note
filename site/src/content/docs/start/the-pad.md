---
title: Using the pad
description: The paging model, the live-preview markdown editor, and how notes are titled and stored.
sidebar:
  order: 3
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

## Dictation

Tap the **mic** in the footer strip to dictate into the page you're on. Speech
streams into the note at the caret as you talk — partial results update in place,
final ones commit — and the soft keyboard stays suppressed so it never covers the
page. The caret remains visible and tappable, so you can steer where the next
words land. Tap the mic again to stop.

The mic is disabled where there's nothing to dictate into: on the dashboard, and
on subject-notebook pages (which are read-only pulls from the server). Walking
onto one of those with the mic live stops it.

### Footer controls while recording

Reaching for the keyboard mid-sentence defeats the point of dictating, so while
the mic is live the footer's two navigation controls — the page scrubber and the
**Dashboard** bubble — are replaced by two editing controls:

| Control | Effect |
|---|---|
| **Delete** | One `Backspace` press per tap — removes a single character. **Hold it** to repeat, like holding Backspace on a keyboard |
| **New line** | One `Enter` press |

Both act on the note being dictated into without interrupting the recognizer, so
you can drop a misheard character or start a fresh line and keep talking. The mic
keeps its own slot in both modes, and the two navigation controls come back as
soon as you stop.

Holding **Delete** repeats at a constant rate after a short pause — the same
key-repeat a keyboard's Backspace gives you, so clearing a badly misheard phrase
doesn't take one tap per character. It deletes characters for as long as you hold;
it never escalates to deleting whole words, and lifting your finger stops it.

`New line` goes through the editor's normal `Enter` handling rather than blindly
inserting a newline — so on a list or quote line it continues the markup, on a
slash-command line it *fires the command*, and inside a card composer it submits
the box. Saying **"system new line"** as its own phrase does the same thing
hands-free.

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
