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

- **Go 1.26 or newer** — unless you use a
  [prebuilt binary](#prebuilt-binaries)
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
yarn server:build      # -> server/nestnote-server
```

## Prebuilt binaries

Every tagged [release](https://github.com/jramirez-codes/nest-note/releases)
ships the server for macOS and Linux, amd64 and arm64 — no Go toolchain
needed:

```bash
tar -xzf nestnote-server_<tag>_darwin_arm64.tar.gz
./nestnote-server -root ~/nestnote-data
```

The binaries are statically linked (`CGO_ENABLED=0`) and unsigned. macOS
Gatekeeper quarantines an unsigned download, so the first run needs
`xattr -d com.apple.quarantine ./nestnote-server` or an *Open anyway* in
System Settings → Privacy & Security.

There is no Windows build: the server manages Claude and `/run` subprocesses
through POSIX process groups, which have no Windows equivalent. Use WSL.

A prebuilt binary is *not* self-updating the way a checkout is:
[`/update-server`](../commands/admin.mdx) does `git pull` + `go build` against a
real clone. If you want that command, run from a checkout — or keep one and
point the binary at it with `-repo-dir`.

## The `-root` layout

Most real use passes `-root`, which scaffolds a working directory and turns on
MCP:

```bash
go run . -root ~/nestnote-data
```

That creates and manages:

```
~/nestnote-data/
  projects/       Claude runs here; /code <name> gets projects/<name>
  mcp/            MCP servers, built on startup
  orchestrator/   subject notes maintained by /talk and /agg-tasks
```

Without `-root`, Claude runs in `-workdir` (defaulting to the current
directory) and MCP is disabled.

If that startup scaffold fails — a capability server under `mcp/` that doesn't
compile, say — the server logs the error and keeps running with MCP disabled
rather than exiting. Every `/run` re-scaffolds, so the fix is picked up on the
next message, and a server that stays up is one you can still reach with
[`/update-server`](../commands/admin.mdx).

Roots created before the rebrand are migrated in place on the next scaffold:
the generated `go.mod` files move to the `nestnote-*` module names, and stale
`ainotepad-*` imports in your own server code are rewritten to match. Only the
import path changes — the rest of your edits are left alone.

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
