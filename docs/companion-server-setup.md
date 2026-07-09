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

### ⚠️ Off-LAN caveat for the iOS module (verify when implementing)

`NSAllowsLocalNetworking` only covers *local* addresses. When the phone connects
to a non-local host — a Tailscale `100.x.y.z` or a DDNS name via
`-advertise-host` (see [Remote access](#remote-access--using-it-off-your-home-wi-fi))
— App Transport Security applies normally and would reject the self-signed cert.
The Android module already sidesteps this: its custom trust manager + OkHttp
factory handle server trust themselves, bypassing system validation. The iOS
`AiNotepadSecure` must do the equivalent — implement pinning in a
`URLSession`/`URLSessionDelegate` (or `NWConnection`) `didReceiveChallenge`
handler that validates the SPKI and returns `.useCredential`, which overrides
ATS for that connection. If that path proves fiddly, an
`NSExceptionDomains` entry (or, last resort, `NSAllowsArbitraryLoads`) is the
fallback — but the pin check, not ATS, is what secures it either way. Confirm a
real off-LAN `/ask` works on a physical device before relying on it.

## Remote access — using it off your home Wi-Fi

Nothing about **trust** changes when you leave the LAN. The client pins the
server's SPKI and authenticates with a bearer token, and the pinning trust
manager sets `hostnameVerifier { _, _ -> true }` (see
`AiNotepadSecureModule.kt`) — so a connection over cellular is cryptographically
identical to one on the LAN. The only gaps are **reachability** (home NAT hides
the laptop) and **addressing** (the pairing QR bakes in a fixed host). Both are
solved by pairing against a stable, remotely-reachable host instead of the LAN
IP, via the server's `-advertise-host` flag.

### Recommended: Tailscale (overlay VPN)

Nothing is exposed to the public internet — only your own devices can reach the
server, so there's no open port to brute-force and no CGNAT/port-forward hassle.

1. Install Tailscale on both the laptop and the phone, signed into the same
   tailnet.
2. Find the laptop's tailnet IP: `tailscale ip -4` → a stable `100.x.y.z`.
3. Start the server with that as the advertise host:
   ```
   go run . -advertise-host 100.x.y.z
   ```
   (With `-advertise-host` set and no `-addr`, the server binds `0.0.0.0` so it
   listens on the tailnet interface as well as the LAN one.)
4. Pair **once** by scanning the QR. The phone now stores the `100.x.y.z`
   address, which is reachable from anywhere on the tailnet — home or away — so
   `/ask` just works on the go. Re-pair only if that IP ever changes.

mDNS discovery (`_ainotepad._tcp`) stays LAN-only and goes quiet off-LAN; that's
fine — the app falls back to the stored pairing address, which is the tailnet IP.

### Alternative: port-forward + Dynamic DNS

Same flag, public address instead of a tailnet one:
`-advertise-host home.duckdns.org`, plus a router rule forwarding
`WAN:8443 → laptop-LAN-IP:8443` and a DDNS updater on the laptop. ⚠️ Two
caveats the Tailscale path avoids: many ISPs use **CGNAT** (test:
`curl ifconfig.me` vs. the router's WAN IP — if they differ, port forwarding
can't work), and this **exposes `/pair` and `/run` to the whole internet**
(auth is then only the bearer token + 10-min pairing code). Prefer Tailscale
unless you can't install it on both devices.

## Using it

In any note, on their own line:

- `/pair` + **Enter** — opens the camera; scan the QR the server prints.
- `/pair {"v":1,"host":…,"port":…,"pin":…,"code":…}` + **Enter** — paste the
  payload instead of scanning.
- `/ask <question>` + **Enter** — streams Claude's answer into a collapsible
  card, persisted in the note's markdown.
