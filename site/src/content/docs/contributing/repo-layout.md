---
title: Repo layout
description: What lives where, and which parts build independently.
sidebar:
  order: 1
---

The repository holds **four independently buildable parts**. None of them is a
workspace member — there is no monorepo tooling, and each carries its own
dependencies.

| Directory         | Stack                    | Package manager | Builds with            |
| ----------------- | ------------------------ | --------------- | ---------------------- |
| `src/` (+ root)   | React Native 0.86, TS    | Yarn            | `yarn android` / `ios` |
| `webview-editor/` | CodeMirror 6, esbuild    | npm             | `npm run build`        |
| `server/`         | Go 1.26                  | Go modules      | `go build`             |
| `site/`           | Astro 7 + Starlight      | npm             | `npm run build`        |

That independence is a property worth preserving. Two places enforce it:

**`metro.config.js`** block-lists `webview-editor/` and `site/` so Metro never
crawls their `node_modules`. Without this you get duplicate-package haste
collisions, and the error message doesn't name the offending directory.

**`tsconfig.json`** extends a *vendored* copy of the React Native preset
(`tsconfig.react-native.json`) by relative path rather than as a bare
specifier. A bare `extends` resolves from the repo root, which means it only
works when the root `node_modules` is installed — that made the docs site
unbuildable in CI, which installs only `site/`. See that file's header for the
full explanation and the re-sync procedure on React Native upgrades.

## Generated files that are committed

Two build outputs live in git on purpose, so downstream builds don't need the
producing sub-project installed:

| File                                     | Produced by                    |
| ---------------------------------------- | ------------------------------ |
| `src/webview/editorHtml.ts`              | `cd webview-editor && npm run build` |
| `site/src/styles/catppuccin.generated.css` | `cd site && npm run gen:theme` |

Neither should be hand-edited. The site's copy is checked in CI via
`npm run check:theme`, which regenerates and fails on any diff.

## Color

`src/theme/catppuccin.js` is the single source of truth for color across the
whole repo. It exports:

- `mocha` — the raw dark palette the app ships
- `latte` — the official light flavor; still generated into the site's CSS,
  but unreachable since the docs site went dark-only
- `makeSemantic(flavor)` — the role mapping (background, text, accent, …)
- `semantic` — `makeSemantic(mocha)`, what the app consumes

`tailwind.config.js` consumes it for NativeWind classes, and
`site/scripts/gen-theme-css.mjs` reads it to generate the site's CSS custom
properties. Re-theming is a change in that one file.
