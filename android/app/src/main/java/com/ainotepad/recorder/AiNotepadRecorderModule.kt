package com.ainotepad.recorder

import android.content.ContentValues
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import android.provider.MediaStore
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File

/**
 * Microphone recording for the editor's /record card. Owns a single MediaRecorder
 * (one capture at a time) writing AAC/m4a into the app cache, anchored by
 * RecorderService so it survives backgrounding. `export` copies a finished clip
 * into the shared Recordings/Music collection so a Voice Recorder app or file
 * browser can see it.
 *
 * Only the device microphone is captured. Android does not let a third-party app
 * record a phone call's remote party (that needs the privileged
 * CAPTURE_AUDIO_OUTPUT permission), so a call recorded here holds your own side
 * plus whatever the mic picks up on speakerphone — never a clean two-way capture.
 */
class AiNotepadRecorderModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private var recorder: MediaRecorder? = null
  private var currentPath: String? = null
  private var startedElapsed: Long = 0L

  // Playback is separate from recording: one MediaPlayer for the /record card's
  // play/pause button. `playingPath` lets play() resume a paused clip vs. start a
  // new one, and lets file deletion tear down a player over that same file.
  private var player: MediaPlayer? = null
  private var playingPath: String? = null

  override fun getName() = "AiNotepadRecorder"

  @ReactMethod
  fun start(label: String?, promise: Promise) {
    if (recorder != null) {
      promise.reject("busy", "A recording is already in progress.")
      return
    }
    val file = File(reactContext.cacheDir, "rec_${System.currentTimeMillis()}.m4a")
    // Bring the foreground service up first: without it, mic access is denied the
    // moment the app is backgrounded.
    RecorderService.start(reactContext)
    val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      MediaRecorder(reactContext)
    } else {
      @Suppress("DEPRECATION")
      MediaRecorder()
    }
    try {
      rec.setAudioSource(MediaRecorder.AudioSource.MIC)
      rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      rec.setAudioEncodingBitRate(128_000)
      rec.setAudioSamplingRate(44_100)
      rec.setOutputFile(file.absolutePath)
      rec.prepare()
      rec.start()
    } catch (e: Exception) {
      runCatching { rec.release() }
      RecorderService.stop(reactContext)
      promise.reject("start_failed", e.message, e)
      return
    }
    recorder = rec
    currentPath = file.absolutePath
    startedElapsed = SystemClock.elapsedRealtime()

    val map = Arguments.createMap()
    map.putString("file", file.absolutePath)
    map.putDouble("startedAt", System.currentTimeMillis().toDouble())
    promise.resolve(map)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    val rec = recorder
    if (rec == null) {
      promise.reject("not_recording", "No active recording.")
      return
    }
    // Duration from the monotonic clock, not wall time (immune to clock changes).
    val ms = SystemClock.elapsedRealtime() - startedElapsed
    val path = currentPath
    recorder = null
    currentPath = null
    var failure: Exception? = null
    try {
      rec.stop()
    } catch (e: Exception) {
      // stop() throws if no valid data was captured (e.g. stopped instantly);
      // the file is unusable, so report it as a failure below.
      failure = e
    } finally {
      runCatching { rec.release() }
      RecorderService.stop(reactContext)
    }
    if (failure != null) {
      path?.let { runCatching { File(it).delete() } }
      promise.reject("stop_failed", failure.message, failure)
      return
    }
    val map = Arguments.createMap()
    map.putString("file", path)
    map.putDouble("ms", ms.toDouble())
    promise.resolve(map)
  }

  /**
   * Cancel the ACTIVE capture: stop/release the recorder, drop the service, and
   * delete the half-written file. For deleting the card that owns the current
   * recording (× while recording / starting / stopping). It never guesses by
   * path — there is only ever one active recording, and this is it.
   */
  @ReactMethod
  fun cancel(promise: Promise) {
    val path = currentPath
    recorder?.let { rec ->
      recorder = null
      currentPath = null
      runCatching { rec.stop() }
      runCatching { rec.release() }
      RecorderService.stop(reactContext)
    }
    path?.let { runCatching { File(it).takeIf(File::exists)?.delete() } }
    promise.resolve(null)
  }

  /**
   * Delete the given cache files outright — used when a page (or notebook) is
   * deleted, to reclaim recordings that would otherwise linger. Unlike `discard`,
   * this touches the active recorder ONLY if one of the paths IS the live capture
   * (deleting a page mid-recording), so cleaning up other pages never interrupts
   * an unrelated recording in progress.
   */
  @ReactMethod
  fun deleteFiles(paths: ReadableArray, promise: Promise) {
    for (i in 0 until paths.size()) {
      val path = paths.getString(i) ?: continue
      if (path == currentPath) {
        recorder?.let { rec ->
          recorder = null
          currentPath = null
          runCatching { rec.stop() }
          runCatching { rec.release() }
          RecorderService.stop(reactContext)
        }
      }
      // If we're currently playing this clip back, tear the player down too.
      if (path == playingPath) releasePlayer()
      runCatching { File(path).takeIf(File::exists)?.delete() }
    }
    promise.resolve(null)
  }

  /**
   * Copy the finished clip into the device's shared audio library so an external
   * Voice Recorder / file app can open it. On API 29+ this uses MediaStore with a
   * RELATIVE_PATH (no storage permission needed); older devices fall back to a
   * plain insert (requires the legacy WRITE_EXTERNAL_STORAGE, declared maxSdk 28).
   */
  @ReactMethod
  fun export(file: String, promise: Promise) {
    val src = File(file)
    if (!src.exists()) {
      promise.reject("no_file", "That recording no longer exists.")
      return
    }
    try {
      val name = src.name
      val resolver = reactContext.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.Audio.Media.DISPLAY_NAME, name)
        put(MediaStore.Audio.Media.MIME_TYPE, "audio/mp4")
        put(MediaStore.Audio.Media.IS_MUSIC, 0)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          put(MediaStore.Audio.Media.RELATIVE_PATH, "Music/ainotepad")
          put(MediaStore.Audio.Media.IS_PENDING, 1)
        }
      }
      val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      } else {
        MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
      }
      val uri = resolver.insert(collection, values)
        ?: throw IllegalStateException("Could not create a media entry.")
      resolver.openOutputStream(uri).use { out ->
        src.inputStream().use { it.copyTo(out!!) }
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        values.clear()
        values.put(MediaStore.Audio.Media.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
      }
      val map = Arguments.createMap()
      map.putString("savedAs", name)
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("export_failed", e.message, e)
    }
  }

  // --- playback (the /record card's play/pause button) -----------------------

  /**
   * Play `file`, or resume it if it's the clip we already have paused. Starting a
   * different clip replaces the current one (single player). On natural end the
   * player self-releases and a `playback:ended` event fires so the card's button
   * flips back to Play.
   */
  @ReactMethod
  fun play(file: String, promise: Promise) {
    try {
      val existing = player
      if (existing != null && playingPath == file) {
        existing.start()
        promise.resolve(null)
        return
      }
      releasePlayer()
      val mp = MediaPlayer()
      mp.setDataSource(file)
      mp.setOnCompletionListener {
        releasePlayer()
        emitPlayback("ended")
      }
      mp.setOnErrorListener { _, _, _ ->
        releasePlayer()
        emitPlayback("ended")
        true
      }
      // Local file — preparing synchronously is fine and keeps start() immediate.
      mp.prepare()
      mp.start()
      player = mp
      playingPath = file
      promise.resolve(null)
    } catch (e: Exception) {
      releasePlayer()
      promise.reject("play_failed", e.message, e)
    }
  }

  /** Pause the current clip in place (play() with the same file resumes it). */
  @ReactMethod
  fun pausePlayback(promise: Promise) {
    runCatching { player?.pause() }
    promise.resolve(null)
  }

  /** Fully stop and release playback (leaving the app, deleting the clip, etc.). */
  @ReactMethod
  fun stopPlayback(promise: Promise) {
    releasePlayer()
    promise.resolve(null)
  }

  private fun releasePlayer() {
    player?.let { runCatching { it.release() } }
    player = null
    playingPath = null
  }

  private fun emitPlayback(event: String) {
    val map = Arguments.createMap()
    map.putString("type", event)
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("AiNotepadRecorder:playback", map)
  }

  // NativeEventEmitter requires these to exist on the module (no-ops here).
  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Double) {}
}
