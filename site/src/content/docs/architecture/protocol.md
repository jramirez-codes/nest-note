---
title: Client & protocol
description: How the app talks to the companion server, and why runs outlive the pages that started them.
sidebar:
  order: 4
---

`src/server/` is the client for the companion server's pinned-TLS protocol. Its
defining constraint: **it is platform-free**. No React Native imports, no Node
imports — it only knows the shape of the bytes on the wire, so the exact same
code runs under Node in a proof harness and under React Native in the app.

The pinned networking is injected through a `Transport` interface, and only
`transport/nativeTransport.ts` is native.

## Layout

```
src/server/
  transport/
    protocol.ts        wire types, stream parsing — platform-free
    transport.ts       the injected Transport interface
    nativeTransport.ts the pinned socket (the only native part)
    client.ts          request/response over the tunnel
    connection.ts      connect / reconnect lifecycle
    agentClient.ts     the /code agent channel
    execClient.ts      the /run shell channel
    status.ts          connection status for useServerStatus
    store.ts           persisted pairing (pin + token)
  controllers/         one per feature: ai, agent, code, audio, view, update, dashboardApi, buildApi
  runRegistry.ts       long-lived ownership of in-flight runs
```

## Plain-HTTP endpoints

Not everything is a socket. `dashboardApi.ts` and `buildApi.ts` speak plain
request/response over the same pinned tunnel and bearer token, because the
server answers them straight from files without spinning up Claude:

| Endpoint | Client | Purpose |
| --- | --- | --- |
| `/state`, `/notebook`, `/page`, `/search` | `dashboardApi.ts` | Reads of the scaffold. |
| `/action` | `dashboardApi.ts` | Card verbs: complete, uncomplete, dismiss, restore; suggestion and reorg verbs. |
| `/build`, `/build/start`, `/build/schedule`, `/build/stop` | `buildApi.ts` | [Scheduled builds](../server/builds.mdx) — read state, start, move the start time of one that hasn't begun, stop. |
| `/build/tick` | *(none — cron)* | Poked by `<root>/bin/nestnote-tick`, never by the app. |

`/build/tick` is the odd one out: its caller is a shell script on the server's
own machine, not the phone. It is authed identically all the same — it starts an
unattended agent run, so localhost is a convention, not a trust boundary.

A scheduled build's run *is* a normal durable session, keyed
`build-<slug>-<feature>` (or `build-<slug>-plan`), emitting the same `cc` frames
a `/code` session does. That's deliberate: the phone watches a 3am build with the
transcript UI it already has, by connecting to `/code` with `resumeOnly` and that
id.

## The pairing payload

The QR is the out-of-band trust transfer. `PairPayload` mirrors `pairPayload`
in `server/main.go`:

```ts
interface PairPayload {
  v: number;
  host: string;
  port: number;
  pin: string;   // base64 SHA-256 of the server's SPKI
  code: string;  // one-time code, redeemed for a token
}
```

`isPairPayload()` does minimal validation before anything trusts a scanned
payload.

## Streaming

The server runs `claude --output-format stream-json` and relays its output
**verbatim** — it is deliberately a dumb pipe. Parsing lives on the client, in
`parseStreamLine()`, which returns an array because a single wire line can
carry several content blocks.

Events are typed (`StreamEvent`): system messages, completed assistant turns,
tool calls, results. Keeping the parse client-side means the server needs no
knowledge of what the model is saying.

## The run registry

This is the least obvious piece, and it exists to fix a specific bug.

Runs used to be owned by the per-page `NoteEditorWebView` and cancelled on
unmount. But `PaperPager` unmounts a page the moment you swipe away from it,
and swapping notebooks tears down the whole editor — so navigating away killed
the run, and the socket close killed the laptop-side process with it.

`runRegistry.ts` hoists that ownership to a single long-lived singleton:

- A run is keyed by its **card id** — the same id the RN ↔ WebView bridge
  already correlates on.
- It keeps streaming into an in-memory buffer whether or not any WebView is
  watching.
- A component **attaches** a sink while mounted and **detaches** on unmount
  *without cancelling*.
- A freshly mounted page re-attaches by id, is repainted from the buffer, then
  rides the live stream to completion.

Only an explicit user Stop (or a terminal result) ends a run.

The practical consequence: you can fire off a `/code` task, swipe away to write
something else, come back, and the transcript is intact and still moving.
