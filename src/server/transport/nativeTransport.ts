/**
 * React Native implementation of the pinned Transport (./transport).
 *
 * RN's stock fetch and WebSocket can neither trust the server's self-signed cert
 * nor pin a runtime SPKI hash, so this delegates to a small native module,
 * `AiNotepadSecure` (Android: OkHttp + a pin-only TrustManager; iOS: URLSession
 * + a pinning delegate). See android/app/src/main/java/com/ainotepad/secure and
 * ios/ainotepad/Secure. The pin — base64 SHA-256 of the server SPKI — is the
 * only thing the native side trusts; a mismatch fails the connection outright.
 *
 * Everything above this seam (client.ts, protocol.ts) is platform-agnostic and
 * already proven against the live server via the Node harness; this file is the
 * one piece that needs the native module present in a device build.
 */

import { NativeEventEmitter, NativeModules } from 'react-native';
import type { SecureSocket, Transport } from './transport';

interface NativeSecureModule {
  /** POST over TLS pinned to `pin`; resolves {status, body}. Rejects on pin failure. */
  postPinned(
    url: string,
    pin: string,
    headersJson: string,
    body: string | null,
  ): Promise<{ status: number; body: string }>;

  /** Open a pinned WebSocket, resolving once connected. `id` keys later events/calls. */
  openSocket(id: number, url: string, pin: string, headersJson: string): Promise<void>;
  sendSocket(id: number, text: string): void;
  closeSocket(id: number): void;
}

const Native = NativeModules.AiNotepadSecure as NativeSecureModule | undefined;

function requireNative(): NativeSecureModule {
  if (!Native) {
    throw new Error(
      'AiNotepadSecure native module is not linked. Rebuild the app after adding ' +
        'the native pinning module (a JS-only reload will not pick it up).',
    );
  }
  return Native;
}

// Socket lifecycle is bridged as global events keyed by a monotonic id, since a
// native WebSocket can't hand back a JS object with live callbacks.
type SocketEvent =
  | { id: number; type: 'message'; text: string }
  | { id: number; type: 'close'; code: number; reason: string }
  | { id: number; type: 'error'; message: string };

export function createNativeTransport(): Transport {
  const native = requireNative();
  const emitter = new NativeEventEmitter(NativeModules.AiNotepadSecure);
  let nextId = 1;

  return {
    async postPinned(url, pin, opts = {}) {
      const res = await native.postPinned(
        url,
        pin,
        JSON.stringify(opts.headers ?? {}),
        opts.body ?? null,
      );
      return { status: res.status, text: res.body };
    },

    async openPinnedSocket(url, pin, headers): Promise<SecureSocket> {
      const id = nextId++;
      const handlers = {
        message: [] as Array<(t: string) => void>,
        close: [] as Array<(i: { code: number; reason: string }) => void>,
        error: [] as Array<(e: Error) => void>,
      };

      const sub = emitter.addListener('AiNotepadSecure:socket', (e: SocketEvent) => {
        if (e.id !== id) return;
        if (e.type === 'message') {
          handlers.message.forEach(cb => cb(e.text));
        } else if (e.type === 'close') {
          handlers.close.forEach(cb => cb({ code: e.code, reason: e.reason }));
          sub.remove();
        } else if (e.type === 'error') {
          // The native side emits EXACTLY ONE terminal event per socket — a
          // `close` OR an `error`, never both (Kotlin's `terminated` guard). A
          // mid-session failure (e.g. the network dropping while the app is
          // backgrounded → OkHttp's onFailure) surfaces here as `error`, not
          // `close`. But the SecureSocket contract says onClose fires whenever the
          // socket closes "normally or otherwise", and every consumer drives its
          // reconnect/teardown off onClose (onError is a no-op — "surfaced via
          // onClose"). So an error must ALSO fire the close handlers, or a failed
          // socket strands the session: no reconnect, and the dead socket silently
          // drops later sends (the /code follow-up that "does nothing" after a
          // background/foreground round-trip).
          const err = new Error(e.message);
          handlers.error.forEach(cb => cb(err));
          handlers.close.forEach(cb => cb({ code: -1, reason: e.message }));
          sub.remove();
        }
      });

      await native.openSocket(id, url, pin, JSON.stringify(headers));

      return {
        send: text => native.sendSocket(id, text),
        close: () => native.closeSocket(id),
        onMessage: cb => handlers.message.push(cb),
        onClose: cb => handlers.close.push(cb),
        onError: cb => handlers.error.push(cb),
      };
    },
  };
}

/** True when a device build actually has the native pinning module linked. */
export function isNativeTransportAvailable(): boolean {
  return !!Native;
}
