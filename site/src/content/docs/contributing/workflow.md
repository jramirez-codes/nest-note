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
yarn server:build   # -> server/nestnote-server
cd server && go run .
```

Remember that `yarn server:start` enables all three capability flags. See
[the security model](../server/security.md).

## The docs site

```bash
cd site
npm install
npm run dev         # http://localhost:4321/nest-note/
npm run build && npm run preview
```

Details in [working on the docs](./docs.md).

## Branches

Work happens on feature branches merged via pull request into `main`. Pushing
to `main` with changes under `site/` triggers the GitHub Pages deploy.

## Cutting a release

`.github/workflows/release.yml` runs on any tag matching `v*` and attaches the
build artifacts to that tag's GitHub release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

It produces `nestnote-<tag>.apk` (Gradle `assembleRelease`, phone ABIs only —
`arm64-v8a` and `armeabi-v7a`), a `nestnote-server_<tag>_<os>_<arch>.tar.gz`
for macOS and Linux on amd64 and arm64, and `SHA256SUMS.txt`. `go test ./...`
gates the server binaries. The release is created with generated notes if it
doesn't exist yet, and assets are uploaded with `--clobber`, so re-running the
workflow on a tag replaces them cleanly.

Running the workflow via **Run workflow** (`workflow_dispatch`) builds the same
artifacts and publishes nothing — they're attached to the run instead. That's
the way to test a change to the workflow without spending a tag.

Two things worth remembering before you tag:

- The APK is signed with the **debug keystore** (`android/app/debug.keystore`),
  because `buildTypes.release` has no other signing config. Releases are
  therefore not upgradeable in place by any future properly-signed build.
- `android/app/build.gradle` holds `versionCode` / `versionName` by hand. The
  tag does not update them — bump them in the same PR as the release.
