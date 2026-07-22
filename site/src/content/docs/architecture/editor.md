---
title: Editor
description: Why the editor is a WebView, how it's bundled, and how it talks to React Native.
sidebar:
  order: 3
---

Notes are edited with [CodeMirror 6](https://codemirror.net/) running inside a
`react-native-webview`. This gives Obsidian-style live preview — markdown
syntax marks hide to render clean text and reveal again on the line being
edited — while keeping **markdown as the stored format**.

## Why a WebView

There is no React Native markdown editor with live-preview behavior of this
quality. CodeMirror 6 has it, and it's a web library.

The trade is a bridge boundary in exchange for a genuinely good editing
experience, plus the fact that the editor reads and writes plain markdown — so
existing notes just work, and there's no data migration when the editor
changes.

## Bundling

`webview-editor/` is an isolated sub-project with its own `node_modules` and
its own package manager (npm, not the app's Yarn). esbuild bundles
`src/index.js` as a minified IIFE and inlines it into a **single
self-contained HTML string** at `src/webview/editorHtml.ts`.

That generated file is committed, so the app builds without ever installing the
editor's dependencies. Metro is configured to block-list `webview-editor/`
precisely because the app imports the generated output and never the source.

Practical guide: [rebuilding the editor](../start/editor-bundle.md).

## Source layout

`webview-editor/src/`, split by concern:

| Path        | Responsibility                                     |
| ----------- | -------------------------------------------------- |
| `markdown/` | Live-preview decorations and custom widgets        |
| `ai/`       | Inline command cards; `commands.js` defines the 15 slash commands |
| `theme/`    | Editor colors                                      |
| `ui/`       | Editor chrome                                      |
| `bridge.js` | The React Native handshake                         |
| `index.js`  | Entry point                                        |

## The bridge

JSON messages both ways:

1. The editor signals ready.
2. The app injects the page's markdown.
3. Edits post markdown back out.

**The payload is the page's full markdown on every keystroke.** That single
fact drives a design decision elsewhere: bulky AI card bodies are deliberately
kept out of `pages.content` and stored in `card_payloads` instead, so a long
`/code` transcript doesn't get serialized across the bridge every time you type
a character. See [storage](./storage.md).

Cards are correlated by **card id** — the same id the
[run registry](./protocol.md) keys on, which is what lets a run survive the
page being unmounted.
