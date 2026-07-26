---
title: Native setup
description: The native modules the companion server needs, the one-time iOS Xcode step, and the ASN.1 header caveat.
sidebar:
  order: 5
---

This page covers only the two modules the **companion server** needs. For the
whole picture of what each platform can do — including the Android-only recorder
and wake-lock modules, and the rest of the iOS build-out — see
[Android & iOS](../start/platforms.md).

Two capabilities need **native** code, and therefore a **device build** — a
JS-only reload will not pick them up:

1. **`AiNotepadSecure`** — pins the server's self-signed certificate. React
   Native's stock `fetch`/WebSocket can't do this.
2. **`react-native-vision-camera`** — scans the pairing QR.

## Android — nothing extra

- `AiNotepadSecure` lives in
  `android/app/src/main/java/com/ainotepad/secure/`, registered in
  `MainApplication.kt`.
- `react-native-vision-camera` autolinks; the `CAMERA` permission is declared
  in `AndroidManifest.xml`.

Rebuild the app and you're done:

```bash
yarn android
```

## iOS — one-time Xcode step

The `AiNotepadSecure` native module is written, but its files are **not yet
part of the Xcode target**. App-local native files aren't autolinked, and
`project.pbxproj` was deliberately not edited automatically to avoid corrupting
the build.

1. Open `ios/ainotepad.xcworkspace` in Xcode.
2. Right-click the **ainotepad** group → *Add Files to "ainotepad"…* and add
   both `ios/ainotepad/AiNotepadSecure.swift` and
   `ios/ainotepad/AiNotepadSecure.m`, with **Target membership → ainotepad**
   checked.
   - No package-list edit is needed — `RCT_EXTERN_MODULE` self-registers the
     module. If prompted to create a bridging header, the app already has one
     via `AppDelegate.swift`, so it usually isn't required.
3. Install pods for vision-camera:

   ```bash
   cd ios && pod install
   ```

4. Build to a **physical device** — the camera and LAN pairing don't work in
   the Simulator.

## Why the fixed ASN.1 header

iOS's `SecKeyCopyExternalRepresentation` returns only the raw EC point, not the
full `SubjectPublicKeyInfo` that the server hashes for the pin. The module
prepends a fixed 26-byte P-256 SPKI header to reconstruct it.

:::caution[This is correct only for P-256]
It works because the server always generates an ECDSA P-256 key
(`server/tlscert.go`). If that key type ever changes, this header must change
too — otherwise the pins silently stop matching.
:::

## Permissions

`NSCameraUsageDescription` is set in `ios/ainotepad/Info.plist`, and
`NSAllowsLocalNetworking` is already `true`, so the self-signed LAN connection
is allowed. The pin check in `AiNotepadSecure` is what actually secures it.

## Off-LAN caveat on iOS

:::caution[Verify this when implementing]
`NSAllowsLocalNetworking` only covers *local* addresses. When the phone
connects to a non-local host — a Tailscale `100.x.y.z`, or a DDNS name via
[`-advertise-host`](./remote-access.md) — App Transport Security applies
normally and would reject the self-signed certificate.

Android already sidesteps this: its custom trust manager and OkHttp factory
handle server trust themselves, bypassing system validation.

The iOS module must do the equivalent — implement pinning in a
`URLSession`/`URLSessionDelegate` (or `NWConnection`) `didReceiveChallenge`
handler that validates the SPKI and returns `.useCredential`, which overrides
ATS for that connection. If that proves fiddly, an `NSExceptionDomains` entry
(or, last resort, `NSAllowsArbitraryLoads`) is the fallback — but the pin
check, not ATS, is what secures it either way.

Confirm a real off-LAN `/ask` works on a physical device before relying on it.
:::
