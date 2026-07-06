/**
 * Regression test for the durable-run reconnect path.
 *
 * The native side emits EXACTLY ONE terminal event per socket — a `close` OR an
 * `error`, never both. A mid-session failure (network drop while the app is
 * backgrounded) surfaces as `error`. The SecureSocket contract says onClose fires
 * whenever the socket closes "normally or otherwise", and all three clients drive
 * their reconnect off onClose (onError is a no-op). So the transport must fire the
 * close handlers on an `error` event too — otherwise a failed socket strands the
 * session and later sends (e.g. a /code follow-up) silently vanish.
 */

type SocketEvent =
  | { id: number; type: 'message'; text: string }
  | { id: number; type: 'close'; code: number; reason: string }
  | { id: number; type: 'error'; message: string };

let emitEvent: (e: SocketEvent) => void = () => {};
const removed = jest.fn();

jest.mock('react-native', () => ({
  NativeModules: {
    AiNotepadSecure: {
      openSocket: jest.fn().mockResolvedValue(undefined),
      sendSocket: jest.fn(),
      closeSocket: jest.fn(),
      postPinned: jest.fn(),
    },
  },
  NativeEventEmitter: class {
    addListener(_name: string, cb: (e: SocketEvent) => void) {
      emitEvent = cb;
      return { remove: removed };
    }
  },
}));

import { createNativeTransport } from '../src/server/nativeTransport';

test('an error event fires both onError and onClose (contract: onClose always fires when the socket ends)', async () => {
  const t = createNativeTransport();
  const sock = await t.openPinnedSocket('wss://host:1/code', 'pin', {});

  const onError = jest.fn();
  const onClose = jest.fn();
  sock.onError(onError);
  sock.onClose(onClose);

  emitEvent({ id: 1, type: 'error', message: 'network dropped' });

  expect(onError).toHaveBeenCalledTimes(1);
  // The crux: without this the client never reconnects and follow-ups vanish.
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(removed).toHaveBeenCalled();
});
