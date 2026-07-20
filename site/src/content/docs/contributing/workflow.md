---
title: Development workflow
description: Linting, tests, patches, and the commands you'll actually run.
sidebar:
  order: 2
---

## Everyday commands

```bash
yarn start          # Metro
yarn android        # build + install on a device
yarn lint           # eslint .
yarn test           # jest
```

## Patches

`postinstall` runs `patch-package`, applying everything in `patches/`. If you
install dependencies in a way that skips lifecycle scripts, those patches are
silently not applied and the app misbehaves in ways that are hard to trace.

When you need to patch a dependency:

```bash
# edit node_modules/<pkg>/…
npx patch-package <pkg>
```

Commit the generated file in `patches/`.

## The editor sub-project

```bash
cd webview-editor
npm install
npm run build       # regenerates ../src/webview/editorHtml.ts
```

Rebuild after **any** change under `webview-editor/src/`, and commit the
regenerated `src/webview/editorHtml.ts` — the app build depends on it being
current.

## The server

```bash
yarn server:build   # -> server/ainotepad-server
cd server && go run .
```

Remember that `yarn server:start` enables all three capability flags. See
[the security model](../server/security.md).

## The docs site

```bash
cd site
npm install
npm run dev         # http://localhost:4321/ai-notepad/
npm run build && npm run preview
```

Details in [working on the docs](./docs.md).

## Branches

Work happens on feature branches merged via pull request into `main`. Pushing
to `main` with changes under `site/` triggers the GitHub Pages deploy.
