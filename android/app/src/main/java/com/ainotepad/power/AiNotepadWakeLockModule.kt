package com.ainotepad.power

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS-facing handle on the shared partial wake lock ([WakeLockManager]). Features
 * driven from JS — speech-to-text dictation today — call [acquire] when they start
 * needing the CPU awake and [release] when they stop. Native-only features (the
 * recorder foreground service) talk to WakeLockManager directly; both share one
 * reference-counted OS lock.
 *
 * The module tracks how many shares JS currently holds through it so a bridge
 * teardown (a Metro reload, a crash, the app being killed) can hand them all back
 * in [invalidate]. Without that a reload mid-dictation would strand the OS lock
 * held forever — a silent battery drain — since the JS that would have released it
 * is gone.
 */
class AiNotepadWakeLockModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val guard = Any()
  private var held = 0

  override fun getName() = "AiNotepadWakeLock"

  @ReactMethod
  fun acquire(promise: Promise) {
    synchronized(guard) {
      held++
      WakeLockManager.acquire(reactContext)
    }
    promise.resolve(null)
  }

  @ReactMethod
  fun release(promise: Promise) {
    synchronized(guard) {
      if (held > 0) {
        held--
        WakeLockManager.release()
      }
    }
    promise.resolve(null)
  }

  /** Bridge is going away — return every share JS still holds so nothing leaks. */
  override fun invalidate() {
    synchronized(guard) {
      while (held > 0) {
        held--
        WakeLockManager.release()
      }
    }
    super.invalidate()
  }
}
