package com.ainotepad.power

import android.content.Context
import android.os.PowerManager

/**
 * One process-wide partial wake lock shared by every feature that needs the CPU to
 * keep running while the screen is free to sleep — audio recording, speech-to-text
 * dictation, and anything added later.
 *
 * Callers pair [acquire]/[release]; the manager reference-counts them, taking the
 * single OS wake lock on the first acquire and dropping it only on the last
 * matching release. Reference counting is what makes this scale: several features
 * can hold wakefulness at once without fighting over (or leaking) separate locks,
 * and wake-lock handling lives in exactly one place instead of being re-derived by
 * each feature. Thread-safe: acquire/release can come from the JS thread, a
 * service, or callbacks concurrently.
 */
object WakeLockManager {
  private const val TAG = "ainotepad:wakelock"

  private val guard = Any()
  private var wakeLock: PowerManager.WakeLock? = null
  private var refCount = 0

  /** Take a share of the wake lock, acquiring the OS lock on the 0 -> 1 edge. */
  fun acquire(context: Context) {
    synchronized(guard) {
      refCount++
      if (refCount == 1) {
        val wl = wakeLock ?: createLock(context).also { wakeLock = it }
        if (!wl.isHeld) wl.acquire()
      }
    }
  }

  /**
   * Give back a share, releasing the OS lock on the 1 -> 0 edge. Releases beyond
   * what was acquired are ignored, so an over-release can never underflow the count
   * or throw.
   */
  fun release() {
    synchronized(guard) {
      if (refCount == 0) return
      refCount--
      if (refCount == 0) {
        wakeLock?.let { if (it.isHeld) runCatching { it.release() } }
      }
    }
  }

  private fun createLock(context: Context): PowerManager.WakeLock {
    val pm = context.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
    // We own the ref counting; the OS lock is a plain on/off held by refCount.
    return pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG).apply { setReferenceCounted(false) }
  }
}
