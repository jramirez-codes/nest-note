/**
 * Wire protocol for the NestNote companion server (see `server/` — a Go process
 * that streams the Claude Code CLI to this app over pinned TLS).
 *
 * This module is deliberately platform-free: no React Native, no Node imports.
 * It only knows the shape of the bytes on the wire, so the exact same code runs
 * under Node (the local proof harness) and under RN (the real app). The actual
 * pinned networking is injected via the Transport interface (./transport).
 */

/**
 * PairPayload is the JSON encoded in the pairing QR the server prints. Scanning
 * it is the out-of-band trust transfer: `pin` is the base64 SHA-256 of the
 * server's SPKI, `code` is the one-time pairing code redeemed for a token.
 * Mirrors `pairPayload` in server/main.go.
 */
export interface PairPayload {
  v: number;
  host: string;
  port: number;
  pin: string;
  code: string;
}

/** Minimal validation of a scanned/parsed QR payload before we trust it. */
export function isPairPayload(x: unknown): x is PairPayload {
  const p = x as PairPayload;
  return (
    !!p &&
    typeof p.host === 'string' &&
    typeof p.port === 'number' &&
    typeof p.pin === 'string' &&
    typeof p.code === 'string'
  );
}

/**
 * A typed view of one `claude --output-format stream-json` line. The server
 * relays these verbatim (it's a dumb pipe), so parsing lives here. One wire
 * line can carry several content blocks, so parseStreamLine returns an array.
 */
export type StreamEvent =
  | { kind: 'system'; subtype?: string; raw: unknown }
  // A completed assistant turn — the full text arrives in one event.
  | { kind: 'assistant-text'; text: string; raw: unknown }
  // An incremental token as the assistant turn is generated (only emitted when
  // the CLI runs with --include-partial-messages). The consumer concatenates
  // these to type the answer out live; the closing assistant-text is the
  // authoritative full turn.
  | { kind: 'assistant-delta'; text: string; raw: unknown }
  // A user turn the client sent, echoed back by the server so it lands in the
  // transcript and replays on reconnect. Synthesized by the /code client from the
  // server's `userprompt` frame (not a Claude stream line), so it has no `raw`.
  | { kind: 'user-prompt'; text: string }
  | { kind: 'tool-use'; name: string; input: unknown; raw: unknown }
  // The output of a tool call, echoed back in a `user` frame. `isError` marks a
  // failed tool. Consumers (e.g. the /code agent card) render it under its call.
  | { kind: 'tool-result'; text: string; isError: boolean; raw: unknown }
  | { kind: 'result'; text: string; isError: boolean; raw: unknown }
  | { kind: 'other'; type: string; raw: unknown };

interface RawContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  // tool_result blocks carry their output here — a bare string, or an array of
  // {type:'text', text} parts, plus an error flag.
  content?: unknown;
  is_error?: boolean;
}

// A tool_result's `content` is either a plain string or an array of text parts;
// flatten both to a single string for display.
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        const p = part as { text?: string };
        return typeof p?.text === 'string' ? p.text : '';
      })
      .join('');
  }
  return '';
}

// One partial-message envelope: {type:'stream_event', event:{...}}. We only care
// about content_block_delta lines carrying a text_delta; the rest (message_start,
// content_block_start/stop, message_delta/stop) are structural and ignored.
interface RawStreamEvent {
  type?: string;
  delta?: { type?: string; text?: string };
}

interface RawStreamLine {
  type?: string;
  subtype?: string;
  message?: { content?: RawContentBlock[] };
  event?: RawStreamEvent;
  result?: string;
  is_error?: boolean;
}

/**
 * Parse a single newline-delimited stream-json line into zero or more typed
 * events. Never throws: an unparseable line becomes a single 'other' event so
 * the UI can still show something rather than tearing down the stream.
 */
export function parseStreamLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let msg: RawStreamLine;
  try {
    msg = JSON.parse(trimmed) as RawStreamLine;
  } catch {
    return [{ kind: 'other', type: 'unparseable', raw: trimmed }];
  }

  switch (msg.type) {
    case 'system':
      return [{ kind: 'system', subtype: msg.subtype, raw: msg }];

    case 'assistant': {
      const blocks = msg.message?.content ?? [];
      const events: StreamEvent[] = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          events.push({ kind: 'assistant-text', text: b.text, raw: msg });
        } else if (b.type === 'tool_use') {
          events.push({ kind: 'tool-use', name: b.name ?? '', input: b.input, raw: msg });
        }
      }
      // An assistant turn with no renderable blocks still deserves a marker.
      return events.length ? events : [{ kind: 'other', type: 'assistant', raw: msg }];
    }

    case 'user': {
      // The CLI reports tool output as a `user` frame whose content holds
      // tool_result blocks. Everything else in a user frame is our own echoed
      // prompt, which the UI already shows, so it needs no event.
      const blocks = msg.message?.content ?? [];
      const events: StreamEvent[] = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          events.push({
            kind: 'tool-result',
            text: toolResultText(b.content),
            isError: !!b.is_error,
            raw: msg,
          });
        }
      }
      return events.length ? events : [{ kind: 'other', type: 'user', raw: msg }];
    }

    case 'stream_event': {
      const ev = msg.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        return [{ kind: 'assistant-delta', text: ev.delta.text, raw: msg }];
      }
      // Structural partial-message frames (message/content_block start & stop,
      // tool-input deltas) don't render — surface them as a generic marker.
      return [{ kind: 'other', type: 'stream_event', raw: msg }];
    }

    case 'result':
      return [
        { kind: 'result', text: msg.result ?? '', isError: !!msg.is_error, raw: msg },
      ];

    default:
      return [{ kind: 'other', type: msg.type ?? 'unknown', raw: msg }];
  }
}
