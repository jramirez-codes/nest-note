---
title: Pairing
description: Pair a phone with the companion server by scanning a QR code, or by pasting the payload.
sidebar:
  order: 2
requiresServer: true
---

Pairing happens **once per device**. After that the app reconnects silently.

## Scan the QR

Start the server. It prints a QR code to the terminal. Then, in any note, on
its own line:

```text
/pair
```

Press **Enter**. The camera opens; point it at the terminal.

## Paste instead of scanning

If the camera isn't an option, the server also prints the payload as JSON. Pass
it directly:

```text
/pair {"v":1,"host":"192.168.1.20","port":8443,"pin":"…","code":"…"}
```

## What the QR actually transfers

| Field  | Meaning                                                          |
| ------ | ---------------------------------------------------------------- |
| `host` | Where to connect. This is baked in at pair time — see below.      |
| `port` | TLS port, 8443 by default.                                       |
| `pin`  | SHA-256 of the server's SubjectPublicKeyInfo — the certificate pin. |
| `code` | A one-time pairing code, valid for 10 minutes by default.         |

The phone exchanges the one-time code for a long-lived bearer token, then
stores the token and the pin. From then on it validates the server's public key
against the stored pin on every connection.

:::note[The host is fixed at pair time]
The QR bakes in whichever address the server advertised. If you pair against a
LAN IP and that IP changes — or you leave the network — the stored address
stops resolving. Pair against a stable address instead; see
[remote access](./remote-access.md).
:::

## Discovery

On the LAN the server advertises itself over mDNS as `_nestnote._tcp`, so the
app can find it without knowing the address. Off-LAN, mDNS goes quiet and the
app falls back to the stored pairing address — which is the behavior you want,
provided you paired against something reachable.

## Re-pairing

Re-pair when:

- the server's advertised host changes (new LAN IP, switched to Tailscale),
- you regenerate the server's certificate (the pin changes),
- or you're setting up an additional device.

Re-pairing is just `/pair` again.

## Confirming it worked

In any note:

```text
/ask what day is it
```

The answer streams into a collapsible card, persisted in the note's markdown.
If nothing happens, the device isn't paired or the server isn't reachable.
