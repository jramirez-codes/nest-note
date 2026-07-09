import Foundation
import CryptoKit
import React

/**
 * iOS counterpart of the Android AiNotepadSecure module: pinned networking for
 * the companion server. React Native's stock fetch/WebSocket can't trust the
 * server's self-signed cert nor pin a runtime SPKI, so this pins both the /pair
 * POST and the /run WebSocket to the base64 SHA-256 of the server's
 * SubjectPublicKeyInfo — exactly what the Go server prints and the JS client was
 * proven against.
 *
 * Two files make this a native module: this Swift class plus AiNotepadSecure.m
 * (the RCT_EXTERN bridge). They must be added to the Xcode target once; there's
 * no package-list step on iOS (RCT_EXTERN_MODULE self-registers).
 */
@objc(AiNotepadSecure)
class AiNotepadSecure: RCTEventEmitter {

  private var sockets = [Int: URLSessionWebSocketTask]()
  private var delegates = [Int: PinningDelegate]()
  private var openRejecters = [Int: RCTPromiseRejectBlock]()
  private var finished = Set<Int>()
  private let lock = NSLock()

  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! { ["AiNotepadSecure:socket"] }

  // MARK: - Pinning

  // The 26-byte ASN.1 prefix of a P-256 SubjectPublicKeyInfo. SecKey gives us
  // only the raw EC point (0x04‖X‖Y); prepending this reconstructs the exact DER
  // the server hashes. Valid because the server always generates an ECDSA P-256
  // key (see server/tlscert.go) — revisit if that ever changes.
  private static let p256SpkiHeader: [UInt8] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
    0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ]

  fileprivate static func leafCertificate(_ trust: SecTrust) -> SecCertificate? {
    if #available(iOS 15.0, *) {
      guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] else { return nil }
      return chain.first
    } else {
      return SecTrustGetCertificateAtIndex(trust, 0)
    }
  }

  fileprivate static func spkiPin(_ trust: SecTrust) -> String? {
    guard let cert = leafCertificate(trust),
          let key = SecCertificateCopyKey(cert),
          let raw = SecKeyCopyExternalRepresentation(key, nil) as Data? else { return nil }
    var spki = Data(p256SpkiHeader)
    spki.append(raw)
    let digest = SHA256.hash(data: spki)
    return Data(digest).base64EncodedString()
  }

  private func applyHeaders(_ req: inout URLRequest, _ headersJson: String?) {
    guard let json = headersJson, let data = json.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    for (k, v) in obj {
      if let s = v as? String { req.setValue(s, forHTTPHeaderField: k) }
    }
  }

  // MARK: - POST (pairing)

  @objc(postPinned:pin:headersJson:body:resolver:rejecter:)
  func postPinned(_ url: String, pin: String, headersJson: String?, body: String?,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let u = URL(string: url) else { reject("bad_url", "invalid url", nil); return }
    var req = URLRequest(url: u)
    req.httpMethod = "POST"
    req.httpBody = (body ?? "").data(using: .utf8)
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    applyHeaders(&req, headersJson)

    let delegate = PinningDelegate(pin: pin)
    let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
    let task = session.dataTask(with: req) { data, response, error in
      defer { session.finishTasksAndInvalidate() }
      if let error = error { reject("post_failed", error.localizedDescription, error); return }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      resolve(["status": status, "body": text])
    }
    task.resume()
  }

  // MARK: - WebSocket (run)

  @objc(openSocket:url:pin:headersJson:resolver:rejecter:)
  func openSocket(_ id: Double, url: String, pin: String, headersJson: String?,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    let sid = Int(id)
    guard let u = URL(string: url) else { reject("bad_url", "invalid url", nil); return }
    var req = URLRequest(url: u)
    applyHeaders(&req, headersJson)

    let delegate = PinningDelegate(pin: pin)
    delegate.onOpen = { [weak self] in
      self?.settleOpen(sid) { resolve(nil) }
    }
    delegate.onClose = { [weak self] code, reason in
      self?.terminate(sid, type: "close", extra: ["code": code, "reason": reason])
    }

    let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
    let task = session.webSocketTask(with: req)

    lock.lock()
    sockets[sid] = task
    delegates[sid] = delegate
    openRejecters[sid] = reject
    lock.unlock()

    task.resume()
    receive(sid: sid, task: task)
  }

  @objc(sendSocket:text:)
  func sendSocket(_ id: Double, text: String) {
    lock.lock(); let task = sockets[Int(id)]; lock.unlock()
    task?.send(.string(text)) { _ in }
  }

  @objc(closeSocket:)
  func closeSocket(_ id: Double) {
    let sid = Int(id)
    lock.lock(); let task = sockets[sid]; lock.unlock()
    task?.cancel(with: .goingAway, reason: nil)
    cleanup(sid)
  }

  private func receive(sid: Int, task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self = self else { return }
      switch result {
      case .success(let message):
        switch message {
        case .string(let text):
          self.emitSocket(sid, "message", ["text": text])
        case .data(let d):
          if let s = String(data: d, encoding: .utf8) { self.emitSocket(sid, "message", ["text": s]) }
        @unknown default:
          break
        }
        self.receive(sid: sid, task: task)
      case .failure(let error):
        // If the socket never opened, this is a pin/handshake failure → reject
        // the open promise. Otherwise it's a mid-stream error (unless a clean
        // close already fired), surfaced as an error event.
        if self.rejectOpenIfPending(sid, "ws_open_failed", error) { return }
        self.terminate(sid, type: "error", extra: ["message": error.localizedDescription])
      }
    }
  }

  // MARK: - terminal-state bookkeeping (each socket fires exactly one of
  // resolve-open / reject-open, then exactly one of close / error)

  private func settleOpen(_ sid: Int, _ run: () -> Void) {
    lock.lock()
    let pending = openRejecters[sid] != nil
    openRejecters[sid] = nil
    lock.unlock()
    if pending { run() }
  }

  private func rejectOpenIfPending(_ sid: Int, _ code: String, _ error: Error) -> Bool {
    lock.lock()
    let reject = openRejecters[sid]
    openRejecters[sid] = nil
    lock.unlock()
    guard let reject = reject else { return false }
    cleanup(sid)
    reject(code, error.localizedDescription, error)
    return true
  }

  private func terminate(_ sid: Int, type: String, extra: [String: Any]) {
    lock.lock()
    let already = finished.contains(sid)
    if !already { finished.insert(sid) }
    lock.unlock()
    if already { return }
    emitSocket(sid, type, extra)
    cleanup(sid)
  }

  private func cleanup(_ sid: Int) {
    lock.lock()
    sockets[sid] = nil
    delegates[sid] = nil
    lock.unlock()
  }

  private func emitSocket(_ id: Int, _ type: String, _ extra: [String: Any]) {
    var body: [String: Any] = ["id": id, "type": type]
    for (k, v) in extra { body[k] = v }
    sendEvent(withName: "AiNotepadSecure:socket", body: body)
  }
}

/**
 * URLSession delegate that trusts the peer only when its SPKI matches the pin,
 * and relays WebSocket open/close to the module. A fresh instance is used per
 * request/socket so its `pin` and callbacks are unambiguous.
 */
class PinningDelegate: NSObject, URLSessionDelegate, URLSessionWebSocketDelegate {
  private let pin: String
  var onOpen: (() -> Void)?
  var onClose: ((Int, String) -> Void)?

  init(pin: String) { self.pin = pin }

  func urlSession(_ session: URLSession,
                  didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    if AiNotepadSecure.spkiPin(trust) == pin {
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                  didOpenWithProtocol protocol: String?) {
    onOpen?()
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                  didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    onClose?(closeCode.rawValue, text)
  }
}
