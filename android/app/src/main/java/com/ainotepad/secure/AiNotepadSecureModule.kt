package com.ainotepad.secure

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import android.util.Base64

/**
 * Pinned networking for the companion server. React Native's stock fetch and
 * WebSocket can't trust the server's self-signed cert nor pin a runtime SPKI, so
 * this module does both with OkHttp and a trust manager that trusts EXACTLY the
 * pinned public key handed over during pairing (base64 SHA-256 of the cert's
 * SubjectPublicKeyInfo — the same value the Go server prints and the JS client
 * was proven against). It exposes the two primitives src/server/nativeTransport.ts
 * expects: postPinned (for /pair) and a WebSocket (for /run, streamed as events).
 */
class AiNotepadSecureModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val sockets = ConcurrentHashMap<Int, WebSocket>()

  override fun getName() = "AiNotepadSecure"

  // --- pinned client ---------------------------------------------------------

  /** A trust manager that accepts the peer only if its SPKI matches `pin`. */
  private class PinningTrustManager(private val pin: String) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
      val leaf = chain?.firstOrNull()
        ?: throw CertificateException("no server certificate presented")
      // getPublicKey().getEncoded() is the DER SubjectPublicKeyInfo — exactly
      // what the server hashes, so the base64 SHA-256 digests line up.
      val digest = MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded)
      val got = Base64.encodeToString(digest, Base64.NO_WRAP)
      if (got != pin) {
        throw CertificateException("pin mismatch: server SPKI is not the pinned key")
      }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
  }

  private fun pinnedClient(pin: String): OkHttpClient {
    val tm = PinningTrustManager(pin)
    val ctx = SSLContext.getInstance("TLS")
    ctx.init(null, arrayOf<TrustManager>(tm), SecureRandom())
    return OkHttpClient.Builder()
      // The pin replaces both chain and hostname trust: a self-signed cert has
      // no CA chain and its CN is an IP, so hostname verification is moot — the
      // SPKI match in the trust manager is the whole of the security check.
      .sslSocketFactory(ctx.socketFactory, tm)
      .hostnameVerifier { _, _ -> true }
      .build()
  }

  private fun applyHeaders(builder: Request.Builder, headersJson: String?) {
    if (headersJson.isNullOrEmpty()) return
    try {
      val obj = JSONObject(headersJson)
      val keys = obj.keys()
      while (keys.hasNext()) {
        val k = keys.next()
        builder.addHeader(k, obj.getString(k))
      }
    } catch (_: Exception) {
      // Malformed header JSON just means no extra headers; not fatal.
    }
  }

  // --- POST (pairing) --------------------------------------------------------

  @ReactMethod
  fun postPinned(url: String, pin: String, headersJson: String?, body: String?, promise: Promise) {
    try {
      val reqBody = (body ?: "").toRequestBody("application/json".toMediaTypeOrNull())
      val builder = Request.Builder().url(url).post(reqBody)
      applyHeaders(builder, headersJson)
      pinnedClient(pin).newCall(builder.build()).enqueue(object : Callback {
        override fun onFailure(call: okhttp3.Call, e: IOException) {
          promise.reject("post_failed", e.message, e)
        }

        override fun onResponse(call: okhttp3.Call, response: Response) {
          response.use {
            val map = Arguments.createMap()
            map.putInt("status", it.code)
            map.putString("body", it.body?.string() ?: "")
            promise.resolve(map)
          }
        }
      })
    } catch (e: Exception) {
      promise.reject("post_error", e.message, e)
    }
  }

  // --- WebSocket (run) -------------------------------------------------------

  @ReactMethod
  fun openSocket(id: Double, url: String, pin: String, headersJson: String?, promise: Promise) {
    val sid = id.toInt()
    try {
      val builder = Request.Builder().url(url)
      applyHeaders(builder, headersJson)
      // Resolve the open promise (or reject it) exactly once; later failures
      // become error events instead.
      val settled = AtomicBoolean(false)
      val ws = pinnedClient(pin).newWebSocket(
        builder.build(),
        object : WebSocketListener() {
          override fun onOpen(webSocket: WebSocket, response: Response) {
            if (settled.compareAndSet(false, true)) promise.resolve(null)
          }

          override fun onMessage(webSocket: WebSocket, text: String) {
            emitMessage(sid, text)
          }

          override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
          }

          override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            sockets.remove(sid)
            emitClose(sid, code, reason)
          }

          override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            sockets.remove(sid)
            if (settled.compareAndSet(false, true)) {
              promise.reject("ws_open_failed", t.message, t)
            } else {
              emitError(sid, t.message ?: "socket error")
            }
          }
        },
      )
      sockets[sid] = ws
    } catch (e: Exception) {
      promise.reject("ws_error", e.message, e)
    }
  }

  @ReactMethod
  fun sendSocket(id: Double, text: String) {
    sockets[id.toInt()]?.send(text)
  }

  @ReactMethod
  fun closeSocket(id: Double) {
    val sid = id.toInt()
    sockets.remove(sid)?.close(1000, "client closed")
  }

  // --- event bridge ----------------------------------------------------------

  private fun emit(map: WritableMap) {
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("AiNotepadSecure:socket", map)
  }

  private fun emitMessage(id: Int, text: String) {
    val map = Arguments.createMap()
    map.putInt("id", id)
    map.putString("type", "message")
    map.putString("text", text)
    emit(map)
  }

  private fun emitClose(id: Int, code: Int, reason: String) {
    val map = Arguments.createMap()
    map.putInt("id", id)
    map.putString("type", "close")
    map.putInt("code", code)
    map.putString("reason", reason)
    emit(map)
  }

  private fun emitError(id: Int, message: String) {
    val map = Arguments.createMap()
    map.putInt("id", id)
    map.putString("type", "error")
    map.putString("message", message)
    emit(map)
  }

  // NativeEventEmitter requires these to exist on the module (no-ops here).
  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Double) {}
}
