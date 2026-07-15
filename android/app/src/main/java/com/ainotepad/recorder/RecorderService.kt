package com.ainotepad.recorder

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.ainotepad.power.WakeLockManager

/**
 * A minimal foreground service whose only job is to hold a microphone-typed
 * foreground notification while a recording runs. Since Android 9 an app can use
 * the mic in the background only while such a service is active (Android 14+
 * additionally requires the `microphone` foreground-service type), so the
 * MediaRecorder in AiNotepadRecorderModule keeps working after the app is
 * backgrounded as long as this is up. The persistent notification is also the
 * visible, OS-enforced signal to everyone present that recording is happening.
 */
class RecorderService : Service() {

  // Whether this service currently holds a share of the shared wake lock, so the
  // service contributes exactly one share no matter how many times onStartCommand
  // is (re)delivered, and hands it back once in onDestroy.
  private var holdingWakeLock = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(NOTIF_ID, notification)
    }
    // Keep the CPU awake (screen free to sleep) so a backgrounded recording keeps
    // encoding through Doze. The lock is shared/ref-counted (WakeLockManager); take
    // our one share here and release it in onDestroy.
    if (!holdingWakeLock) {
      WakeLockManager.acquire(this)
      holdingWakeLock = true
    }
    // If the process is killed mid-recording we don't want a zombie service
    // silently restarting the mic, so don't redeliver.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    if (holdingWakeLock) {
      WakeLockManager.release()
      holdingWakeLock = false
    }
    super.onDestroy()
  }

  private fun buildNotification(): Notification {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Audio recording",
        NotificationManager.IMPORTANCE_LOW,
      ).apply { description = "Shown while ainotepad is recording audio." }
      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    // Tapping the notification returns to the app.
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launch?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setContentTitle("Recording audio")
      .setContentText("ainotepad is recording — tap to return.")
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setOngoing(true)
      .setUsesChronometer(true)
      .apply { contentIntent?.let { setContentIntent(it) } }
      .build()
  }

  companion object {
    private const val CHANNEL_ID = "ainotepad_recording"
    private const val NOTIF_ID = 4711

    fun start(context: Context) {
      val intent = Intent(context, RecorderService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, RecorderService::class.java))
    }
  }
}
