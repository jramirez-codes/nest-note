package com.ainotepad.power

import android.view.WindowManager
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
 *
 * [setKeepScreenOn] is a separate concern layered on top: the partial lock keeps the
 * CPU running but deliberately lets the *display* sleep, so dictation also asks to
 * hold the screen on via the activity window's FLAG_KEEP_SCREEN_ON — the recommended
 * way to keep the display awake (no PowerManager lock, no extra permission). The flag
 * only applies while our window is foreground, which is exactly right: keep the
 * screen lit while the user is looking at the note, and fall back to the CPU lock if
 * the app gets backgrounded.
 */
class AiNotepadWakeLockModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val guard = Any()
  private var held = 0
  private var keepScreenOn = false

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

  /**
   * Hold (or drop) the display awake by toggling FLAG_KEEP_SCREEN_ON on the current
   * activity's window. Must touch the window on the UI thread. A no-op with no
   * activity (nothing to keep lit); the flag is naturally lost if that activity is
   * later recreated, which is fine — a live dictation re-asserts it on its next take.
   */
  @ReactMethod
  fun setKeepScreenOn(enabled: Boolean, promise: Promise) {
    synchronized(guard) { keepScreenOn = enabled }
    applyKeepScreenOn(enabled)
    promise.resolve(null)
  }

  private fun applyKeepScreenOn(enabled: Boolean) {
    val activity = reactContext.currentActivity ?: return
    activity.runOnUiThread {
      if (enabled) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
    }
  }

  /** Bridge is going away — return every share JS still holds, and let the screen
   *  sleep again, so nothing leaks. */
  override fun invalidate() {
    synchronized(guard) {
      while (held > 0) {
        held--
        WakeLockManager.release()
      }
      if (keepScreenOn) {
        keepScreenOn = false
        applyKeepScreenOn(false)
      }
    }
    super.invalidate()
  }
}
