---
title: Flags reference
description: Every command-line flag the companion server accepts, with defaults.
sidebar:
  order: 7
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
| `-dir`       | `~/.nestnote-server` | Directory for the cert, key and token.                                        |
| `-workdir`   | current directory    | Directory Claude runs in. **Ignored when `-root` is set.**                     |
| `-root`      | *(disabled)*         | Scaffold `projects/`, `mcp/`, `orchestrator/` under this dir and enable MCP; Claude runs in `<root>/projects`. |
| `-repo-dir`  | `<root>/nest-note`  | The nest-note git checkout that `/update server` fetches, checks out and rebuilds. |

### Pre-rebrand installs keep working

The project used to be called ai-notepad, and both defaults above were renamed
with it. A server installed before the rename keeps running untouched — the
defaults fall back to the old names when those are the ones on disk:

- `-dir` falls back to `~/.ainotepad-server` when `~/.nestnote-server` doesn't
  exist. This matters: the cert and token live there, so silently starting in a
  fresh directory would regenerate both and break the phone's pinned
  certificate *and* its saved token at once. Recovering from that needs a QR
  re-pair at the machine.
- `-repo-dir` falls back to `<root>/ai-notepad` when `<root>/nest-note` doesn't
  exist, so [`/update server`](../commands/admin.mdx) still finds the checkout.

When both names exist the current one wins. Pass either flag explicitly to
override the search entirely.

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

### `-allow-code` **and** `-allow-exec` together also authorize scheduled builds

Set both, and [scheduled builds](./builds.md) unlock: an idea card can become a
project that an agent builds **on a timer, with nobody watching**, one feature at
a time.

There is no third flag for this, and that's the point — a build step is exactly
these two capabilities run unattended (`/code`'s agent-in-a-project plus `/exec`'s
arbitrary shell), so a flag of its own would gate nothing new. But it does widen
what each flag means when they're set together, and that is worth knowing before
you set them:

- **Alone**, either flag runs code only when *you* ask it to, while you watch.
- **Together**, they additionally let the server install a crontab entry that
  starts an agent run every 30 minutes without you present.

The gate on that is behavioural rather than a flag: nothing proceeds past a
feature until you approve it on the dashboard, so at most one feature ever runs
unwatched. Missing either flag returns 403, the same as `/code` and `/run` do.

Builds also need `-root` (the gate cards live in the scaffold); without it the
build endpoints report `mcp disabled`.

## Examples

```bash
# Model-only: /ask, /clean, /search. No code execution.
go run .

# Scaffolded working directory, still no capability flags.
go run . -root ~/nestnote-data

# Reachable over Tailscale.
go run . -root ~/nestnote-data -advertise-host "$(tailscale ip -4 | head -n1)"

# Everything on — only for a laptop you fully trust.
go run . -root ~/nestnote-data -allow-exec -allow-code -allow-view
```
