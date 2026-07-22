---
title: Build from source
description: Build NestNote yourself and get it onto an Android or iOS device.
sidebar:
  order: 2
---

There is no app store listing. This page is the **developer path**: a working
React Native toolchain, a clone, and builds you produce yourself. It's what you
need for iOS, for an emulator, or to change any of the code.

If you just want to use NestNote, take the shorter route —
[download the prebuilt APK and server binary](./download.md) instead.

## Prerequisites

- **Node.js 22.11 or newer** (the repo declares `engines.node >= 22.11.0`)
- **Yarn** — the app uses `yarn.lock`
- A working React Native environment. If you haven't set one up, follow
  React Native's [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment)
  guide first and come back.
- **Go 1.26+**, only if you want the [companion server](../server/setup.md)

## Clone and install

```bash
git clone https://github.com/jramirez-codes/nest-note.git
cd nest-note
yarn install
```

`yarn install` runs `patch-package` via `postinstall`, applying the patches in
`patches/`. If you install with a different package manager that skips
lifecycle scripts, those patches won't be applied and the app will misbehave in
ways that are hard to trace.

## Run on a device

```bash
# Start Metro in one terminal
yarn start

# Build and install in another
yarn android     # or: yarn ios
```

The companion-server features need **native modules**, so they require a real
device build — a Metro reload will not pick them up. See
[native setup](../server/native-setup.md) for the details, including the
one-time Xcode step iOS still needs.

:::note[Physical device recommended]
Pairing uses the camera to scan a QR code, and the connection is to a host on
your network. Neither works well in a simulator.
:::

## Build a standalone APK

```bash
yarn apk           # debug build, then adb install
yarn apk:release   # release build, then adb install
```

These wrap Gradle and `adb`:

| Script               | What it runs                                      |
| -------------------- | ------------------------------------------------- |
| `apk:build`          | `cd android && ./gradlew assembleDebug`            |
| `apk:install`        | `adb install -r .../app-debug.apk`                 |
| `apk:build:release`  | `cd android && ./gradlew assembleRelease`          |
| `apk:install:release`| `adb install -r .../app-release.apk`               |

:::caution[Release builds are debug-signed]
The repo has no production signing config. `assembleRelease` currently produces
an APK signed with the debug keystore. Set up a real signing config before
distributing a build to anyone else.
:::

## FTS5 must be enabled at build time

Full-text search relies on SQLite's FTS5 module, which op-sqlite ships
**disabled by default**. The repo turns it on in `package.json`:

```json
"op-sqlite": { "fts5": true }
```

This is a **native compile flag**, baked into the SQLite build via the iOS
podspec and Android Gradle config. A Metro or JS reload will not pick up a
change to it. Without FTS5, schema creation throws `no such module: fts5` and
the app hangs on the loading spinner.

If you change that flag, force a native rebuild:

```bash
# iOS — re-reads the podspec
cd ios && pod install && cd ..
npx react-native run-ios

# Android — gradle reads package.json at configure time
cd android && ./gradlew clean && cd ..
npx react-native run-android
```

## Verify it works

Launch the app. You should land on a full-screen page with a seeded welcome
note. Swipe left to reach the blank sheet, type some markdown, and swipe away —
your text is persisted to SQLite immediately, no save button.

At this point the pad is fully functional offline. Everything from here on is
optional.

## Next

1. [Using the pad](./the-pad.md) — the paging model and the editor.
2. [Set up the companion server](../server/setup.md) — `cd server && go run .`,
   then [pair](../server/pairing.md).
3. [Rebuilding the editor](./editor-bundle.md) — if you touch `webview-editor/`.
4. [Development workflow](../contributing/workflow.md) — lint, tests, patches.
