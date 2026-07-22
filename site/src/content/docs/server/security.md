---
title: Security model
description: What the pinned-TLS tunnel actually protects, and what the three capability flags give away.
sidebar:
  order: 3
---

Read this before enabling any `-allow-*` flag. The short version: the transport
is solid, and the capability flags are genuinely dangerous by design.

## What secures the connection

Two independent mechanisms:

**Certificate pinning.** The server generates a self-signed ECDSA P-256
certificate. The pairing QR carries a SHA-256 hash of its SubjectPublicKeyInfo,
and the app validates the server's key against that pin on every connection. A
self-signed cert isn't a weakness here — pinning is strictly stronger than the
public CA system for this use case, because there is no CA that could be
tricked into issuing for your laptop.

**Bearer token.** The one-time pairing code (valid 10 minutes by default) is
exchanged for a long-lived token. Every subsequent request carries it.

Because trust comes from the pin and the token rather than from the network,
**a connection over cellular is cryptographically identical to one on your
LAN.** Leaving the house changes reachability, not trust.

## What the capability flags give away

All three default to **off**. Each one, when enabled, lets anything that can
authenticate to the tunnel run code as your user account.

| Flag           | Grants                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| `-allow-exec`  | `/run` — arbitrary shell commands as your user                          |
| `-allow-code`  | `/code` — a Claude Code agent with **every tool auto-accepted** (`bypassPermissions`) |
| `-allow-view`  | `/view` — reverse-proxies your localhost dev servers over **cleartext HTTP to anyone on the LAN** |

Two things worth stating plainly:

- `-allow-code` runs the agent in `bypassPermissions` mode. There is no
  per-tool confirmation. That is the point of the feature, and it is also the
  entire risk of it.
- `-allow-view` is the only one that exposes anything **unauthenticated**. The
  proxy it opens is plain HTTP on your local network, outside the pinned
  tunnel. Anyone on the same Wi-Fi can reach a previewed dev server.

## The threat model this assumes

The design assumes your laptop is trusted, your phone is trusted, and the
pairing QR is scanned somewhere private. Under those assumptions the tunnel is
sound.

It does **not** defend against:

- someone who obtains the bearer token,
- someone with access to your unlocked, paired phone,
- other devices on your LAN reaching a `-allow-view` proxy.

## Practical guidance

1. **Start with no flags.** `/ask`, `/clean`, `/search` and the dashboard
   commands need none of them.
2. **Add one flag at a time**, when you actually want that feature.
3. **Prefer Tailscale over port forwarding.** Port forwarding exposes `/pair`
   and `/run` to the entire internet, where the only remaining protection is
   the bearer token. See [remote access](./remote-access.md).
4. **Be aware the repo's own `server:start` script enables all three.** It's a
   convenience for a single trusted machine, not a recommended default.

## Reporting a problem

Security issues are best raised privately through the repository's GitHub
issue tracker rather than in a public note.
