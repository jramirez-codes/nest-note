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
  // The notebook/page bucket of the active capture, so stop() can migrate the
  // finished clip into that notebook's persistent media folder (see start/stop).
  private var currentNb: String = FALLBACK_SEG
  private var currentPage: String = FALLBACK_SEG

  // Playback is separate from recording: one MediaPlayer for the /record card's
  // play/pause button. `playingPath` lets play() resume a paused clip vs. start a
  // new one, and lets file deletion tear down a player over that same file.
  private var player: MediaPlayer? = null
  private var playingPath: String? = null

  override fun getName() = "AiNotepadRecorder"

  @ReactMethod
  fun start(label: String?, notebookId: String?, pageId: String?, promise: Promise) {
    if (recorder != null) {
      promise.reject("busy", "A recording is already in progress.")
      return
    }
    // Capture into a per-notebook/per-page bucket under the (evictable) cache while
    // recording; stop() migrates the finished clip into the matching persistent
    // filesDir/media bucket. Bucketing keeps a notebook's clips together and lets
    // page/notebook cleanup reason about them by path.
    val nb = safeSeg(notebookId)
    val page = safeSeg(pageId)
    val dir = File(File(reactContext.cacheDir, MEDIA_DIR), "$nb/$page")
    dir.mkdirs()
    val file = File(dir, "rec_${System.currentTimeMillis()}.m4a")
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
    currentNb = nb
    currentPage = page
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
    val nb = currentNb
    val page = currentPage
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
    // Move the completed clip out of the evictable cache into the notebook's
    // persistent media folder so it survives OS cache pressure. Best-effort: on any
    // migration hiccup keep the (still playable) cache path rather than losing it.
    val finalPath = migrateToMedia(path, nb, page) ?: path
    val map = Arguments.createMap()
    map.putString("file", finalPath)
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
    // Parent buckets of every clip we remove, so once the whole page's media is
    // gone we can drop the now-empty <notebook>/<page> folder(s) too.
    val buckets = mutableSetOf<File>()
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
      val file = File(path)
      file.parentFile?.let { buckets.add(it) }
      runCatching { file.takeIf(File::exists)?.delete() }
    }
    // A deleted page may hold several clips in one bucket; now that they're gone,
    // prune the empty page folder (and its notebook folder if it too emptied out).
    for (bucket in buckets) pruneEmptyBuckets(bucket)
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

  // --- media bucketing -------------------------------------------------------

  /**
   * Move a finished cache clip into filesDir/media/<notebook>/<page>/, returning
   * the new absolute path, or null on any failure (caller keeps the cache path).
   * Prefers an atomic rename; falls back to copy+delete when the two live on
   * different mounts (cacheDir and filesDir usually don't, but be safe).
   */
  private fun migrateToMedia(cachePath: String?, nb: String, page: String): String? {
    if (cachePath == null) return null
    val src = File(cachePath)
    if (!src.exists()) return null
    val destDir = File(File(reactContext.filesDir, MEDIA_DIR), "$nb/$page")
    if (!destDir.isDirectory && !destDir.mkdirs()) return null
    val dest = File(destDir, src.name)
    return try {
      if (src.renameTo(dest)) {
        dest.absolutePath
      } else {
        src.inputStream().use { input -> dest.outputStream().use { input.copyTo(it) } }
        src.delete()
        dest.absolutePath
      }
    } catch (e: Exception) {
      runCatching { if (dest.exists() && dest != src) dest.delete() }
      null
    }
  }

  /**
   * Walk up from a just-emptied bucket, deleting each folder that is now empty,
   * stopping at the first non-empty one or at a media root (which is never
   * removed). This turns filesDir/media/<nb>/<page>/ into nothing once a page's
   * clips are all deleted, and also drops the <nb> folder if that was the
   * notebook's last page with media. Confined to our media trees so it can never
   * touch anything outside filesDir/media or cacheDir/media.
   */
  private fun pruneEmptyBuckets(bucket: File) {
    val roots = listOf(
      File(reactContext.filesDir, MEDIA_DIR),
      File(reactContext.cacheDir, MEDIA_DIR),
    )
    var dir: File = bucket
    // Only prune strict descendants of a media root (so a root itself, and
    // anything outside the media trees, ends the walk immediately).
    while (roots.any { isStrictlyUnder(it, dir) }) {
      val entries = dir.list() ?: break
      if (entries.isNotEmpty()) break
      if (!dir.delete()) break
      dir = dir.parentFile ?: break
    }
  }

  companion object {
    // Sub-folder (under both cacheDir and filesDir) that holds recording buckets.
    private const val MEDIA_DIR = "media"
    // Used when a notebook/page id is missing or sanitizes to empty, so a clip is
    // never dropped at the media root without a bucket.
    private const val FALLBACK_SEG = "_"

    /**
     * Reduce a notebook/page id to a single safe path segment. Ids are app-generated
     * uuids/slugs, but sanitize defensively so nothing can traverse out of the media
     * tree (no '/', '\', '..') or break the filesystem.
     */
    private fun safeSeg(raw: String?): String {
      val cleaned = (raw ?: "").replace(Regex("[^A-Za-z0-9_-]"), "_")
      return if (cleaned.isEmpty()) FALLBACK_SEG else cleaned
    }

    /**
     * True when `dir` sits strictly inside `root` (a real descendant, not `root`
     * itself). Uses canonical paths so a `..` or symlink can't smuggle the prune
     * walk outside the media tree; a resolution failure is treated as "not under".
     */
    private fun isStrictlyUnder(root: File, dir: File): Boolean {
      val r = runCatching { root.canonicalPath }.getOrNull() ?: return false
      val d = runCatching { dir.canonicalPath }.getOrNull() ?: return false
      return d.length > r.length && d.startsWith(r + File.separator)
    }
  }
}
