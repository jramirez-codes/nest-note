---
title: Rebuilding the editor
description: How the CodeMirror 6 editor is bundled into the app, and when you need to rebuild it.
sidebar:
  order: 4
---

The editor is a small, isolated web app under `webview-editor/`. It is bundled
into **one self-contained HTML string** and loaded into a
`react-native-webview`. You only need this page if you're changing the editor
itself.

## Why it's a separate sub-project

`webview-editor/` carries its own `node_modules` and its own lockfile, and uses
**npm** rather than the app's Yarn. It is not part of the React Native
dependency graph — Metro is explicitly configured to ignore the directory in
`metro.config.js`, because the app imports only the generated output, never the
CodeMirror source.

## Rebuild after any change

```bash
cd webview-editor
npm install    # first time only
npm run build
```

That runs `build.mjs`, which uses esbuild to bundle `src/index.js` as a
minified IIFE targeting `safari15` / `chrome100`, inlines it into a single HTML
document, and writes the result to:

```
src/webview/editorHtml.ts
```

:::caution[Generated file — do not hand-edit]
`src/webview/editorHtml.ts` is build output. Edit `webview-editor/src/` and
rebuild. The generated file **is committed**, so the app builds without ever
installing the editor sub-project's dependencies.
:::

## Source layout

`webview-editor/src/` is split by concern:

| Path         | Responsibility                                      |
| ------------ | --------------------------------------------------- |
| `markdown/`  | Live-preview decorations and custom widgets         |
| `ai/`        | The inline command cards (and `commands.js`)        |
| `theme/`     | Editor colors                                       |
| `ui/`        | Editor chrome                                       |
| `bridge.js`  | The React Native handshake                          |
| `index.js`   | Entry point                                         |

`webview-editor/src/ai/commands.js` is the **source of truth for the slash
command list** — the labels and descriptions in the
[command reference](../commands/index.mdx) come from it.

## The RN ↔ web bridge

Communication is JSON messages over the WebView bridge:

1. The editor signals ready.
2. The app injects the page's markdown.
3. Edits post markdown back out.

Because the payload is the page's full markdown on every keystroke, bulky AI
card bodies are deliberately kept **out** of `pages.content` and stored in a
separate `card_payloads` table instead — see
[storage](../architecture/storage.md).
