---
title: Setup
description: Build and run the Go companion server that backs the in-note AI commands.
sidebar:
  order: 1
---

The companion server is a small Go program you run **on your own laptop**. It
streams the Claude Code CLI and a few laptop capabilities to the phone over a
pinned-TLS tunnel. Nothing is hosted; there is no third party in the path.

If you skip this page entirely, the pad still works — it's just offline.

## Prerequisites

- **Go 1.26 or newer**
- The **Claude Code CLI**, installed and authenticated on the laptop. The
  server shells out to it; the AI commands run against your own CLI and your
  own credentials.
- The phone and laptop able to reach each other — same Wi-Fi to start with. See
  [remote access](./remote-access.md) for off-LAN.

## Run it

The simplest possible start, from the repo root:

```bash
cd server
go run .
```

That listens on port 8443, auto-detects your LAN IP, generates a self-signed
ECDSA P-256 certificate on first run, and prints a pairing QR code to the
terminal. With no flags, **none of the capability features are enabled** — you
get `/ask`, `/clean` and the other model-only commands.

To build a binary instead:

```bash
yarn server:build      # -> server/ainotepad-server
```

## The `-root` layout

Most real use passes `-root`, which scaffolds a working directory and turns on
MCP:

```bash
go run . -root ~/ainotepad-data
```

That creates and manages:

```
~/ainotepad-data/
  projects/       Claude runs here; /code <name> gets projects/<name>
  mcp/            MCP servers, built on startup
  orchestrator/   subject notes maintained by /talk and /agg-tasks
```

Without `-root`, Claude runs in `-workdir` (defaulting to the current
directory) and MCP is disabled.

## The convenience script

The repo ships a `server:start` script:

```bash
yarn server:start
```

:::caution[This script enables everything]
`server:start` passes `-allow-exec -allow-code -allow-view` — all three
capability gates, which are off by default for good reason. It is a
single-developer convenience for a trusted laptop, **not** a recommended
default.

Read [the security model](./security.md) before using it, and prefer starting
with no flags and adding only what you need.
:::

The script also hard-codes the repo author's data directory. Point `-root`
somewhere that makes sense for you rather than copying it verbatim.

## Next

1. [Pair your phone](./pairing.md) — scan the QR once.
2. [Understand the security model](./security.md) — especially before enabling
   any `-allow-*` flag.
3. [Full flag reference](./flags.md).
