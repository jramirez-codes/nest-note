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

The app's native code sits alongside `src/` in `android/` and `ios/`. Those two
are **not** mirror images — the recorder and wake-lock modules exist on Android
only, and iOS is a later build-out. See
[Android & iOS](../start/platforms.md) for what each platform has.

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

## Inside `server/`

The companion server is one Go module laid out in layers. **Imports only ever
point downward**, and that single rule is what keeps it navigable as it grows —
`build` may use `store`, `store` may never use `build`.

```
main.go        flags → config → start the TLS listener
routes.go      the route table: one line per endpoint
```

Start at `routes.go`. Every endpoint maps to the package that answers it, so
going from "what does `/build/revise` do" to the right file is one hop.

| Layer | Package | What it owns |
| --- | --- | --- |
| Features | `internal/build` | scheduled idea builds — the state machine and `/build/*` |
| | `internal/dashboard` | `/state`, `/notebook`, `/page`, `/action` |
| | `internal/agent` | `/code` agent sessions, `/projects` |
| | `internal/exec` | `/exec` shell channel |
| | `internal/run` | `/run` — one Claude turn against the MCP world |
| | `internal/search` | `/search` across notebook pages |
| | `internal/view` | `/viewstart` preview proxies |
| | `internal/update` | `/update` self-update |
| Services | `internal/session` | durable runs: process outlives the socket |
| | `internal/claude` | spawning the Claude CLI |
| | `internal/cron` | every mutation of the user's crontab |
| | `internal/scaffold` | laying out and building the MCP world |
| Data | `internal/store` | notebooks, pages, cards, reorgs — all on-disk state |
| Plumbing | `internal/httpx` | auth check and the two response shapes |
| | `internal/pairing` | TLS cert + SPKI pin, mDNS, pair code, token |
| | `internal/procio` | process groups, signals, bounded stderr |
| | `internal/project` | project name → `projects/<slug>` |

Two conventions worth knowing before you add code here:

**Cards live in `store`, not in `dashboard`.** The card type is the shared
currency between two features that must not import each other — the dashboard
renders cards, the build pipeline writes them. Putting the type at the bottom of
the stack is what lets both work with it.

**The build package is split by phase, not by size.** `state.go` → `project.go`
→ `plan.go` → `cards.go` → `prompts.go` → `engine.go` → `handlers.go` follows the
order a build actually moves through. `engine.go` holds the tick state machine
and is the file to read first.

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
