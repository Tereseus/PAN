package dev.pan.app.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import kotlinx.coroutines.*
import kotlin.math.sqrt

/**
 * BargeInMonitor — detects user speech during TTS playback using the secondary mic.
 *
 * Android phones have two mics: primary (bottom/call mic) and secondary (top/camera mic).
 * While TTS plays through the speaker, we open the secondary mic via CAMCORDER source.
 * The camera mic is physically further from the speaker, so TTS bleed is lower.
 * When the user speaks, RMS spikes above the TTS-bleed baseline → barge-in fires.
 *
 * Algorithm:
 *  1. Calibrate baseline RMS during first 300ms (TTS bleed noise floor)
 *  2. Watch for CONSECUTIVE_WINDOWS consecutive 80ms windows above 3× baseline
 *  3. Fire onBargeIn() — caller stops TTS and resumes STT
 *
 * Fallback: if CAMCORDER fails (some devices), tries UNPROCESSED source.
 */
class BargeInMonitor {

    companion object {
        private const val TAG             = "BargeIn"
        private const val SAMPLE_RATE     = 16000
        private const val WINDOW_MS       = 80        // detection window size
        private const val CALIBRATION_MS  = 500       // baseline measurement period (during live TTS playback)
        private const val CONSECUTIVE     = 2         // windows above threshold to confirm barge-in
        private const val THRESHOLD_MULT  = 4.0       // multiplier above baseline
        private const val MIN_THRESHOLD   = 600.0     // floor — well above typical TTS bleed level
    }

    var onBargeIn: (() -> Unit)? = null
    var onLog:     ((String) -> Unit)? = null

    private var job:         Job?         = null
    private var audioRecord: AudioRecord? = null

    /** Start monitoring. Safe to call multiple times — only one monitor runs at a time. */
    @SuppressLint("MissingPermission")
    fun start(scope: CoroutineScope) {
        if (job?.isActive == true) return
        job = scope.launch(Dispatchers.IO) {
            val bufSize = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            ).coerceAtLeast(3200)

            val recorder = openRecorder(bufSize) ?: run {
                log("No secondary mic available — barge-in disabled")
                return@launch
            }

            audioRecord = recorder
            try {
                recorder.startRecording()
                log("Secondary mic open (barge-in active)")

                val samplesPerWindow  = SAMPLE_RATE * WINDOW_MS / 1000
                val calibWindows      = CALIBRATION_MS / WINDOW_MS
                val buf               = ShortArray(samplesPerWindow)

                // Phase 1 — calibrate noise floor (TTS bleed + ambient)
                var baselineSum = 0.0
                var baselineN   = 0
                repeat(calibWindows) {
                    if (!isActive) return@repeat
                    val n = recorder.read(buf, 0, samplesPerWindow)
                    if (n > 0) { baselineSum += rms(buf, n); baselineN++ }
                }
                val baseline  = if (baselineN > 0) baselineSum / baselineN else 0.0
                val threshold = maxOf(baseline * THRESHOLD_MULT, MIN_THRESHOLD)
                log("Baseline=%.0f threshold=%.0f".format(baseline, threshold))

                // Phase 2 — watch for speech above threshold
                var consecutive = 0
                while (isActive) {
                    val n = recorder.read(buf, 0, samplesPerWindow)
                    if (n <= 0) continue
                    if (rms(buf, n) > threshold) {
                        consecutive++
                        if (consecutive >= CONSECUTIVE) {
                            log("Barge-in! (${consecutive} windows above threshold)")
                            withContext(Dispatchers.Main) { onBargeIn?.invoke() }
                            break
                        }
                    } else {
                        consecutive = 0
                    }
                }
            } finally {
                releaseRecorder()
            }
        }
    }

    /** Stop monitoring — called when TTS finishes naturally (no barge-in needed). */
    fun stop() {
        job?.cancel()
        job = null
        releaseRecorder()
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    @SuppressLint("MissingPermission")
    private fun openRecorder(bufSize: Int): AudioRecord? {
        // Try secondary (camera) mic first — physically farthest from speaker
        for (source in listOf(
            MediaRecorder.AudioSource.CAMCORDER,
            MediaRecorder.AudioSource.UNPROCESSED,
            MediaRecorder.AudioSource.MIC
        )) {
            try {
                val r = AudioRecord(
                    source, SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufSize
                )
                if (r.state == AudioRecord.STATE_INITIALIZED) {
                    log("Opened source=$source")
                    return r
                }
                r.release()
            } catch (e: Exception) {
                log("Source $source failed: ${e.message}")
            }
        }
        return null
    }

    private fun releaseRecorder() {
        try { audioRecord?.stop()    } catch (_: Exception) {}
        try { audioRecord?.release() } catch (_: Exception) {}
        audioRecord = null
    }

    private fun rms(buf: ShortArray, len: Int): Double {
        if (len == 0) return 0.0
        var sum = 0.0
        for (i in 0 until len) { val s = buf[i].toDouble(); sum += s * s }
        return sqrt(sum / len)
    }

    private fun log(msg: String) {
        Log.i(TAG, msg)
        onLog?.invoke("[BargeIn] $msg")
    }
}
