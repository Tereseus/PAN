package dev.pan.app.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.util.Log
import kotlinx.coroutines.*
import kotlin.math.sqrt

/**
 * BargeInMonitor — detects user speech during TTS playback.
 *
 * Core idea: attach Android's hardware AcousticEchoCanceler (AEC) to the AudioRecord
 * session. AEC is designed for phone calls — it removes the speaker signal from the mic
 * so you don't hear yourself echo. Same principle here: TTS plays through the speaker,
 * AEC subtracts it from the mic input at hardware level. Only the user's voice remains.
 * A simple RMS threshold then detects "someone spoke" reliably.
 *
 * We don't need voice identity — we just need to cancel the AI voice out.
 * AEC does that without any ML, at near-zero CPU cost.
 *
 * Algorithm:
 *  1. Open AudioRecord + attach AEC (+ NoiseSuppressor if available)
 *  2. Calibrate ambient RMS for 400ms (should be ~0 after AEC strips TTS)
 *  3. Watch for CONSECUTIVE windows above threshold → fire onBargeIn()
 *
 * Fallback: if AEC unavailable, falls back to raw mic with higher threshold.
 */
class BargeInMonitor {

    companion object {
        private const val TAG             = "BargeIn"
        private const val SAMPLE_RATE     = 16000
        private const val WINDOW_MS       = 80        // detection window size
        private const val CALIBRATION_MS  = 400       // baseline period (AEC-cleaned signal ≈ 0 during TTS)
        private const val CONSECUTIVE     = 2         // windows above threshold to confirm barge-in
        private const val THRESHOLD_MULT  = 4.0       // multiplier above AEC-cleaned baseline
        private const val MIN_THRESHOLD   = 120.0     // floor with AEC (much lower — TTS is removed)
        private const val MIN_THRESHOLD_NO_AEC = 800.0 // fallback floor without AEC
    }

    var onBargeIn: (() -> Unit)? = null
    var onLog:     ((String) -> Unit)? = null

    private var job:         Job?                   = null
    private var audioRecord: AudioRecord?           = null
    private var aec:         AcousticEchoCanceler?  = null
    private var ns:          NoiseSuppressor?       = null
    private var aecActive    = false

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

            // Attach AEC — removes TTS speaker signal from mic at hardware level
            aecActive = false
            if (AcousticEchoCanceler.isAvailable()) {
                try {
                    aec = AcousticEchoCanceler.create(recorder.audioSessionId)?.also {
                        it.enabled = true
                        aecActive = true
                        log("AEC attached (session=${recorder.audioSessionId})")
                    }
                } catch (e: Exception) { log("AEC create failed: ${e.message}") }
            } else {
                log("AEC not available on this device — using raw mic with high threshold")
            }
            // Noise suppressor removes residual background hiss
            if (NoiseSuppressor.isAvailable()) {
                try {
                    ns = NoiseSuppressor.create(recorder.audioSessionId)?.also { it.enabled = true }
                } catch (_: Exception) {}
            }

            try {
                recorder.startRecording()
                val minThreshold = if (aecActive) MIN_THRESHOLD else MIN_THRESHOLD_NO_AEC
                log("Barge-in active (AEC=$aecActive, minThreshold=$minThreshold)")

                val samplesPerWindow  = SAMPLE_RATE * WINDOW_MS / 1000
                val calibWindows      = CALIBRATION_MS / WINDOW_MS
                val buf               = ShortArray(samplesPerWindow)

                // Phase 1 — calibrate. With AEC on, TTS is cancelled so baseline ≈ ambient noise.
                // Without AEC, baseline captures TTS bleed — threshold needs to be much higher.
                var baselineSum = 0.0
                var baselineN   = 0
                repeat(calibWindows) {
                    if (!isActive) return@repeat
                    val n = recorder.read(buf, 0, samplesPerWindow)
                    if (n > 0) { baselineSum += rms(buf, n); baselineN++ }
                }
                val baseline  = if (baselineN > 0) baselineSum / baselineN else 0.0
                val threshold = maxOf(baseline * THRESHOLD_MULT, minThreshold)
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
        try { aec?.release() } catch (_: Exception) {}
        try { ns?.release()  } catch (_: Exception) {}
        aec = null; ns = null; aecActive = false
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
