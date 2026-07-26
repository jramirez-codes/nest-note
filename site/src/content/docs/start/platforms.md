---
title: Android & iOS
description: What works on each platform, the Android-only device features, and what iOS still needs before it reaches parity.
sidebar:
  order: 3
---

NestNote is a React Native app, so the **pad itself is the same on both
platforms** — same editor, same storage, same slash commands. What differs is
everything that touches the device: recording, dictation, wake locks, and how
the app is distributed.

**Android is the primary target.** It's the platform the app is developed and
tested on, the only one with a prebuilt release artifact, and the only one where
every device-level feature is implemented. **iOS is a later build-out**: it
builds and runs today, but the native modules below were written for Android
first and their iOS counterparts are still outstanding. Nothing about the design
is Android-specific — the work simply hasn't been done yet.

## Support matrix

| Capability | Android | iOS |
| --- | --- | --- |
| Pad, paging, live-preview editor | ✅ | ✅ |
| SQLite storage + FTS5 search | ✅ | ✅ (`pod install` bakes in the FTS5 flag) |
| Slash commands, cards, dashboard | ✅ | ✅ |
| Prebuilt artifact | ✅ `nest-note-<tag>.apk` | ❌ [build from source](./install.md) — an unsigned IPA isn't installable |
| Pairing QR scan (vision-camera) | ✅ autolinked | ✅ after `pod install` |
| Certificate pinning on the LAN | ✅ | ⚠️ module written, [not yet in the Xcode target](../server/native-setup.md) |
| Pinning **off**-LAN (Tailscale / DDNS) | ✅ custom trust manager | ❌ [not implemented](../server/native-setup.md) — ATS rejects the self-signed cert |
| Dictation (footer mic) | ✅ | ⚠️ needs two `Info.plist` keys added first |
| [`/record`](../commands/capture.mdx) background audio | ✅ | ❌ no native recorder module |
| Exporting a clip to the device's audio library | ✅ MediaStore | ❌ no equivalent yet |
| Wake lock / keep-screen-on during dictation | ✅ | ❌ no-ops |

A ⚠️ means the feature is one contained step away; an ❌ means the native code
doesn't exist yet.

## Where the native code lives

Two of the three Android modules have no iOS counterpart at all:

| Module | Android | iOS |
| --- | --- | --- |
| `AiNotepadSecure` — cert pinning | `android/app/src/main/java/com/ainotepad/secure/` | `ios/ainotepad/AiNotepadSecure.{swift,m}` |
| `AiNotepadRecorder` — `/record` | `android/app/src/main/java/com/ainotepad/recorder/` | — |
| `AiNotepadWakeLock` — CPU / screen | `android/app/src/main/java/com/ainotepad/power/` | — |

Every JS seam degrades rather than crashes when its module is missing: the wake
lock silently no-ops, recording cleanup resolves, and `/record` surfaces *"The
audio recorder module isn't in this build."* So an iOS build is usable — it just
can't record.

## Android specifics

**Permissions** (`android/app/src/main/AndroidManifest.xml`):

| Permission | Why |
| --- | --- |
| `CAMERA` | scanning the pairing QR |
| `RECORD_AUDIO` | the runtime consent gate for `/record` and dictation |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MICROPHONE` | capture continues when you leave the app (microphone type, API 34+) |
| `POST_NOTIFICATIONS` | the ongoing-recording notice (API 33+) |
| `WAKE_LOCK` | keeps the CPU alive through Doze so the encoder isn't starved |
| `WRITE_EXTERNAL_STORAGE` (`maxSdkVersion=28`) | legacy export only; API 29+ goes through MediaStore |

A `<queries>` entry for `android.speech.RecognitionService` is also required —
Android 11+ package visibility hides the recognizer otherwise, and dictation
fails even with `RECORD_AUDIO` granted.

**Recording runs in a microphone-typed foreground service**, which is why it
survives backgrounding and a locked screen — and why a persistent notification
appears while it runs. That notice is both an OS requirement and the visible
signal to everyone present that recording is happening.

**Exported clips land in the shared audio library** (`Music/ainotepad` via
MediaStore on API 29+), where a voice-recorder or file app can pick them up.

:::caution[Call audio is not capturable]
Android restricts a call's remote party to system apps holding
`CAPTURE_AUDIO_OUTPUT`. `/record` captures **this device's microphone only** —
your own side of a call, plus whatever the mic picks up on speakerphone. There
is no supported path to both sides from an app like this, on any platform.
:::

**Release APKs are debug-signed** — see [download & run](./download.mdx).

## iOS specifics

What already works: the pad, storage and search, and — after `pod install` and
the one-time Xcode step in [native setup](../server/native-setup.md) — camera
pairing and LAN pinning.

`NSCameraUsageDescription` is set, and `NSAllowsLocalNetworking` is `true`, so
the self-signed LAN connection is allowed. The pin check is what actually
secures it.

### What's outstanding

In roughly the order it makes sense to tackle:

1. **Add `AiNotepadSecure` to the Xcode target.** App-local native files aren't
   autolinked, and `project.pbxproj` was deliberately left unedited. Steps are
   in [native setup](../server/native-setup.md).
2. **Off-LAN pinning.** `NSAllowsLocalNetworking` only covers local addresses,
   so a Tailscale `100.x.y.z` or a DDNS name via
   [`-advertise-host`](../server/remote-access.md) hits normal App Transport
   Security and is rejected. The fix is a `URLSessionDelegate`
   `didReceiveChallenge` handler that validates the SPKI and returns
   `.useCredential`.
3. **Dictation permission keys.** `ios/ainotepad/Info.plist` currently declares
   only the camera. Speech recognition needs both
   `NSSpeechRecognitionUsageDescription` and `NSMicrophoneUsageDescription`
   before the footer mic can work — without them the OS terminates the app on
   first use.
4. **Port the recorder.** An `AVAudioRecorder` module registered as
   `AiNotepadRecorder`, with the `audio` background mode for capture that
   survives backgrounding (iOS's equivalent of Android's foreground service),
   plus an export path — a share sheet or the Files app, since there's no
   MediaStore.
5. **Port the wake lock.** iOS has no partial wake lock; the equivalents are
   `UIApplication.isIdleTimerDisabled` for keep-screen-on and the background
   audio mode for continued capture.
6. **Signing and distribution.** There is no production signing config in the
   repo and no release IPA, so iOS stays a from-source, own-developer-account
   path.

Confirm a real off-LAN `/ask` on a physical device before relying on step 2 —
the Simulator can't do camera pairing or LAN connections anyway.

## Building for each

```bash
yarn start           # Metro, in one terminal

yarn android         # build + install on a connected Android device
yarn ios             # build + install on iOS
```

The `apk:*` scripts (`yarn apk`, `yarn apk:release`) are Android-only wrappers
around Gradle and `adb`. Full toolchain details are on
[build from source](./install.md).
