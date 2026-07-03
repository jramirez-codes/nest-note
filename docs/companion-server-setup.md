# Companion server — native setup notes

The in-note assistant (`/ask`, `/pair`) talks to the Go companion server under
`server/` over a pinned-TLS WebSocket. The JS/TS client core in `src/server/` is
platform-agnostic and proven against the live server, but two capabilities need
**native** code and therefore a **device build** (a JS-only reload will not pick
them up):

1. **`AiNotepadSecure`** — pins the server's self-signed cert (RN's stock
   fetch/WebSocket can't).
2. **`react-native-vision-camera`** — scans the pairing QR (bare `/pair`).

Android is wired up end-to-end. iOS needs a one-time Xcode step (below).

## Android — nothing extra

- `AiNotepadSecure` module: `android/app/src/main/java/com/ainotepad/secure/`,
  registered in `MainApplication.kt`.
- `react-native-vision-camera` autolinks; `CAMERA` permission is declared in
  `AndroidManifest.xml`.

Just rebuild the app (`yarn android`) after pulling these changes.

## iOS — one-time Xcode step ⚠️

The `AiNotepadSecure` native module is written but its files are **not yet part
of the Xcode target** (app-local native files aren't autolinked, and the
`project.pbxproj` wasn't edited automatically to avoid corrupting the build):

1. Open `ios/ainotepad.xcworkspace` in Xcode.
2. Right-click the **ainotepad** group → *Add Files to "ainotepad"…* and add
   both `ios/ainotepad/AiNotepadSecure.swift` and `ios/ainotepad/AiNotepadSecure.m`,
   with **Target membership → ainotepad** checked.
   - No package-list edit is needed: `RCT_EXTERN_MODULE` self-registers the
     module. If prompted to create a bridging header, the app already has one via
     `AppDelegate.swift`, so it usually isn't required.
3. Install pods for vision-camera: `cd ios && pod install`.
4. Build to a **physical device** (the camera and LAN pairing don't work in the
   Simulator), then pair and ask.

### Why the fixed ASN.1 header in `AiNotepadSecure.swift`

iOS's `SecKeyCopyExternalRepresentation` returns only the raw EC point, not the
full `SubjectPublicKeyInfo` the server hashes for the pin. The module prepends a
fixed 26-byte P-256 SPKI header to reconstruct it. This is correct **only because
the server always generates an ECDSA P-256 key** (`server/tlscert.go`). If that
key type ever changes, update the header (or the pins won't match).

### Permissions

`NSCameraUsageDescription` is set in `ios/ainotepad/Info.plist`, and
`NSAllowsLocalNetworking` is already `true` (so the self-signed LAN connection is
allowed; the pin check in `AiNotepadSecure` is what actually secures it).

## Using it

In any note, on their own line:

- `/pair` + **Enter** — opens the camera; scan the QR the server prints.
- `/pair {"v":1,"host":…,"port":…,"pin":…,"code":…}` + **Enter** — paste the
  payload instead of scanning.
- `/ask <question>` + **Enter** — streams Claude's answer into a collapsible
  card, persisted in the note's markdown.
