---
title: Flags reference
description: Every command-line flag the companion server accepts, with defaults.
sidebar:
  order: 6
---

Source of truth: `server/main.go`. Run `go run . -h` for the same list.

## Network

| Flag               | Default              | Meaning                                                                 |
| ------------------ | -------------------- | ----------------------------------------------------------------------- |
| `-port`            | `8443`               | TLS port to listen on.                                                  |
| `-addr`            | auto-detected LAN IP | Bind address.                                                           |
| `-advertise-host`  | bind address         | Host to put in the pairing QR — e.g. a Tailscale IP or DDNS name for off-LAN access. |

:::note[`-advertise-host` changes the bind default]
With `-advertise-host` set and no explicit `-addr`, the server binds `0.0.0.0`
rather than just the LAN IP, so it also listens on the tailnet interface.
:::

## Paths

| Flag         | Default              | Meaning                                                                       |
| ------------ | -------------------- | ----------------------------------------------------------------------------- |
| `-dir`       | platform state dir   | Directory for the cert, key and token.                                        |
| `-workdir`   | current directory    | Directory Claude runs in. **Ignored when `-root` is set.**                     |
| `-root`      | *(disabled)*         | Scaffold `projects/`, `mcp/`, `orchestrator/` under this dir and enable MCP; Claude runs in `<root>/projects`. |
| `-repo-dir`  | `<root>/ai-notepad`  | The ai-notepad git checkout that `/update-server` pulls and rebuilds.          |

## Behavior

| Flag                  | Default | Meaning                                                                          |
| --------------------- | ------- | -------------------------------------------------------------------------------- |
| `-subject-threshold`  | `4`     | Mentions before the orchestrator proposes a dedicated server for a subject (with `-root`). |
| `-run-timeout`        | `8m`    | Max time for a single Claude run before it's killed and reported as failed.       |
| `-pair-ttl`           | `10m`   | How long a pairing code stays valid.                                             |

`/agg-tasks` sweeps a whole notebook and can legitimately need several minutes —
that's why `-run-timeout` defaults as high as it does.

## Capability gates

**All three are off by default. Each runs code as your user account over the
tunnel.** See [the security model](./security.md).

| Flag           | Default | Enables                                                                     |
| -------------- | ------- | --------------------------------------------------------------------------- |
| `-allow-exec`  | `false` | `/run` — the direct shell channel. Arbitrary commands as this user, gated only by the pinned tunnel and token. |
| `-allow-code`  | `false` | `/code` — a persistent Claude Code agent in `projects/<name>` with every tool auto-accepted (`bypassPermissions`). |
| `-allow-view`  | `false` | `/view` — on-demand plaintext LAN reverse-proxies mirroring your localhost dev servers. Cleartext HTTP to anyone on the LAN. |

## Examples

```bash
# Model-only: /ask, /clean, /search. No code execution.
go run .

# Scaffolded working directory, still no capability flags.
go run . -root ~/ainotepad-data

# Reachable over Tailscale.
go run . -root ~/ainotepad-data -advertise-host "$(tailscale ip -4 | head -n1)"

# Everything on — only for a laptop you fully trust.
go run . -root ~/ainotepad-data -allow-exec -allow-code -allow-view
```
