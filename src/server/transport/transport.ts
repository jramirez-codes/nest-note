/**
 * The pinned-networking seam. The protocol client (./client) is written against
 * these two primitives; each platform supplies an implementation that pins TLS
 * to the server's self-signed SPKI:
 *
 *   - Node  (test harness): node:tls checkServerIdentity — see the local proof
 *     under the scratchpad / server test tooling.
 *   - RN    (the app): a small native trust module, because RN's stock fetch and
 *     WebSocket can neither trust a self-signed cert nor pin a runtime SPKI hash.
 *     This is the design's known weak spot; isolating it here keeps the rest of
 *     the client identical across platforms and independently testable.
 *
 * `pin` is always the base64 SHA-256 of the server's SubjectPublicKeyInfo, the
 * same value the server prints and encodes in the pairing QR.
 */

export interface SecureSocket {
  /** Send one text frame. */
  send(text: string): void;
  /** Close the socket; idempotent. */
  close(): void;
  /** Register the handler for inbound text frames. */
  onMessage(cb: (text: string) => void): void;
  /** Fires once when the socket closes (normally or otherwise). */
  onClose(cb: (info: { code: number; reason: string }) => void): void;
  /** Fires on a transport/pinning error; a closed-with-error also lands here. */
  onError(cb: (err: Error) => void): void;
}

export interface Transport {
  /**
   * POST to `url` over TLS pinned to `pin`. Resolves with the HTTP status and
   * body text (does not throw on non-2xx — the caller inspects status).
   */
  postPinned(
    url: string,
    pin: string,
    opts?: { headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; text: string }>;

  /**
   * Open a WebSocket to `url` over TLS pinned to `pin`, sending `headers`
   * (e.g. the bearer Authorization) on the upgrade request. Rejects if the
   * handshake or pin check fails.
   */
  openPinnedSocket(
    url: string,
    pin: string,
    headers: Record<string, string>,
  ): Promise<SecureSocket>;
}
