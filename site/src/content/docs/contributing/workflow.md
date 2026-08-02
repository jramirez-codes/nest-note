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

Releases are built and uploaded **by hand** — there is no release CI. Tag the
commit, build the artifacts locally, then attach them to the GitHub release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Build the APK (phone ABIs only — `arm64-v8a` and `armeabi-v7a`, since x86 is
an emulator target):

```bash
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a
# -> android/app/build/outputs/apk/release/app-release.apk
```

Build the server for whichever platform you're publishing. `CGO_ENABLED=0`
keeps it static, and the server has no cgo dependencies, so cross-compiling is
just a matter of setting `GOOS`/`GOARCH`:

```bash
cd server
go test ./...
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 \
  go build -trimpath -ldflags '-s -w' -o nestnote-server .
```

There is no Windows build: `internal/procio` and `internal/update` use POSIX
process groups, which have no Windows equivalent.

Then create the release and upload both files. Name them so it's obvious what
they are and which tag they came from — the docs refer to them as
`nestnote-<tag>.apk` and `nestnote-server_<tag>_<os>_<arch>`.

Two things worth remembering before you tag:

- The APK is signed with the **debug keystore** (`android/app/debug.keystore`),
  because `buildTypes.release` has no other signing config. Releases are
  therefore not upgradeable in place by any future properly-signed build.
- `android/app/build.gradle` holds `versionCode` / `versionName` by hand. The
  tag does not update them — bump them in the same PR as the release.
