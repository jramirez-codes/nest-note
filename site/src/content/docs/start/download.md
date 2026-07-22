---
title: Download & run
description: Install NestNote from the prebuilt APK and server binary — no toolchain required.
sidebar:
  order: 1
---

This is the short path: download two files from
[GitHub Releases](https://github.com/jramirez-codes/nest-note/releases), install
one on your phone and run the other on your laptop. No Node, no Go, no React
Native toolchain.

If you'd rather build it yourself — or you're on iOS, or you want to change the
code — go to [build from source](./install.md) instead.

## What a release carries

| Asset                                 | What it is                               |
| ------------------------------------- | ---------------------------------------- |
| `nest-note-<tag>.apk`                 | Android app, `arm64-v8a` + `armeabi-v7a` |
| `nestnote-server_<tag>_<os>_<arch>`   | Companion server binary                  |

Release artifacts are built and uploaded **by hand**, so which platforms a given
release covers varies — check that release's own asset list. If the server build
you need isn't there, [build from source](./install.md); it's a short path for
the server specifically.

## 1. Install the app

Download the `.apk` onto the phone and open it, or push it from a laptop with
`adb`:

```bash
adb install -r nest-note-<tag>.apk
```

Android will warn you about installing from an unknown source — that's expected
for a sideloaded app.

:::caution[Release APKs are debug-signed]
The repo has no production signing config, so the released APK is signed with
the checked-in debug keystore. Android warns on install, and a build signed with
a different key cannot upgrade it in place — you'd have to uninstall first,
which takes your notes with it.
:::

The APK carries no x86 ABIs, so it will **not** install on a typical emulator.
There is no prebuilt iOS artifact either: unsigned IPAs aren't installable, so
iOS is [source-only](./install.md).

Launch it. You land on a full-screen page with a seeded welcome note — swipe
left to reach the blank sheet and start typing.

**You can stop here.** Without a server the pad is a fully functional offline
markdown notepad; that's the intended fallback, not a degraded mode. See
[using the pad](./the-pad.md). Everything below adds the AI layer.

## 2. Install the Claude Code CLI

The server doesn't talk to any hosted API of its own — it shells out to the
[Claude Code CLI](https://claude.com/claude-code) on your laptop, using your
credentials. Install and sign in to it first; if `claude` doesn't run in your
terminal, none of the AI commands will work.

## 3. Download and run the server

Grab the binary matching your laptop's OS and architecture, make it executable
and run it:

```bash
mv nestnote-server_<tag>_linux_amd64 nestnote-server
chmod +x nestnote-server
./nestnote-server -root ~/nestnote-data
```

`-root` scaffolds a working directory (`projects/`, `mcp/`, `orchestrator/`) and
turns on MCP. Without it, Claude runs in the current directory and MCP is off.

The server listens on port 8443, auto-detects your LAN IP, generates a
self-signed certificate on first run, and prints a **pairing QR code** to the
terminal. Leave it running.

With no other flags, **none of the capability features are enabled** — you get
`/ask`, `/clean` and the other model-only commands. Shell execution, the coding
agent and dev-server exposure each need an explicit `-allow-*` flag; read
[the security model](../server/security.md) before turning any of them on.

:::caution[macOS quarantines unsigned downloads]
The binaries are statically linked (`CGO_ENABLED=0`) and unsigned. On macOS the
first run needs `xattr -d com.apple.quarantine ./nestnote-server`, or an
*Open anyway* in System Settings → Privacy & Security.
:::

There is no Windows build: the server manages Claude and `/run` subprocesses
through POSIX process groups, which have no Windows equivalent. Use WSL.

## 4. Pair the phone

Keep the phone and laptop on the same Wi-Fi. In any note, on its own line, type
`/pair` and press **Enter** — the camera opens, point it at the QR code in your
terminal. That's once per device; after that the app reconnects silently.

Full details, including pasting the payload instead of scanning:
[pairing](../server/pairing.md).

## 5. Check it worked

In any note:

```text
/ask what day is it
```

The answer streams into a collapsible card saved in the note's markdown. If
nothing happens, the device isn't paired or the server isn't reachable.

## What the prebuilt path can't do

| You want to…                          | Then…                                    |
| ------------------------------------- | ---------------------------------------- |
| Run on iOS                            | [Build from source](./install.md)        |
| Run on an emulator                    | [Build from source](./install.md)        |
| Use [`/update-server`](../commands/admin.mdx) | Run the server from a git checkout, or point the binary at one with `-repo-dir` |
| Change the app or editor              | [Build from source](./install.md)        |

## Next

1. [Using the pad](./the-pad.md) — the paging model and the editor.
2. [Slash commands](../commands/index.mdx) — what you can actually run.
3. [Security model](../server/security.md) — before enabling any `-allow-*` flag.
4. [Remote access](../server/remote-access.md) — using it off your home Wi-Fi.
