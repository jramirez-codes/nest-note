---
title: Remote access
description: Using the companion server off your home Wi-Fi, via Tailscale or port forwarding.
sidebar:
  order: 4
requiresServer: true
---

Nothing about **trust** changes when you leave the LAN. The client pins the
server's public key and authenticates with a bearer token, so a connection over
cellular is cryptographically identical to one at home.

The only real gaps are:

- **Reachability** — home NAT hides the laptop.
- **Addressing** — the pairing QR bakes in a fixed host.

Both are solved the same way: pair against a stable, remotely-reachable address
instead of a LAN IP, using `-advertise-host`.

## Recommended: Tailscale

An overlay VPN. Nothing is exposed to the public internet — only your own
devices can reach the server, so there's no open port to brute-force and no
CGNAT or port-forwarding hassle.

1. Install [Tailscale](https://tailscale.com/) on both the laptop and the
   phone, signed into the same tailnet.
2. Find the laptop's tailnet IP:

   ```bash
   tailscale ip -4      # a stable 100.x.y.z
   ```

3. Start the server advertising that address:

   ```bash
   go run . -advertise-host "$(tailscale ip -4 | head -n1)"
   ```

4. [Pair once](./pairing.md) by scanning the QR.

The phone now stores a `100.x.y.z` address reachable from anywhere on the
tailnet, home or away. Re-pair only if that IP changes.

The repo ships this as `yarn server:remote` — though note that script also
enables all three [capability flags](./security.md).

:::note[mDNS goes quiet off-LAN]
Discovery (`_ainotepad._tcp`) is LAN-only by design. Off-LAN the app falls back
to the stored pairing address — which is exactly the tailnet IP you paired
against.
:::

## Alternative: port forwarding + dynamic DNS

Same flag, a public address instead of a tailnet one:

```bash
go run . -advertise-host home.example.org
```

Plus a router rule forwarding `WAN:8443 → laptop-LAN-IP:8443`, and a DDNS
updater on the laptop.

:::caution[Two problems Tailscale avoids]
**CGNAT.** Many ISPs place customers behind carrier-grade NAT, where port
forwarding simply cannot work. Test by comparing `curl ifconfig.me` against
your router's WAN IP — if they differ, you're behind CGNAT.

**Public exposure.** This puts `/pair` and `/run` on the open internet. The
only remaining protection is the bearer token and the 10-minute pairing window.
:::

Prefer Tailscale unless you genuinely can't install it on both devices.
