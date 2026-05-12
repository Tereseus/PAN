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
        // Calibration window — longer (800ms) lets AEC converge before we measure.
        // The hardware AEC on most phones (incl. Pixel 10) needs a few hundred ms
        // after activation before the cancellation reaches steady-state. Measuring
        // too early captures pre-convergence echo as "baseline" and underestimates it.
        private const val CALIBRATION_MS  = 800
        // Sustained signal requirement: 4 × 80ms = 320ms of continuous above-threshold
        // audio. A transient AEC residual spike from a hard consonant in TTS is
        // typically <100ms; a real human "hey wait" syllable is 200ms+. This cleanly
        // separates the two.
        private const val CONSECUTIVE     = 4
        // Threshold = peak_during_calibration × headroom, floored at MIN_THRESHOLD.
        // Headroom keeps us ABOVE the worst residual peak observed during TTS.
        private const val THRESHOLD_HEADROOM = 1.8
        // Higher floor — AEC is not perfect. 350 still detects normal speech (which
        // hits 1500-3000 RMS easily) but ignores residual TTS leak peaks that
        // empirically land in the 100-250 range on Pixel-class hardware.
        private const val MIN_THRESHOLD   = 350.0
        private const val MIN_THRESHOLD_NO_AEC = 1200.0  // fallback floor without AEC — also raised
        // Post-calibration grace period — ignore detections for this long after
        // calibration ends. Covers the moment when the next TTS sentence kicks in
        // with a fresh transient before AEC adapts.
        private const val POST_CALIB_GRACE_MS = 250L
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

            // Guard: coroutine may have been cancelled between openRecorder() and here
            // (e.g. stop() called while we were attaching AEC). Check both.
            if (!isActive || recorder.state != AudioRecord.STATE_INITIALIZED) {
                log("Cancelled before startRecording — aborting")
                return@launch
            }

            try {
                try {
                    recorder.startRecording()
                } catch (e: IllegalStateException) {
                    log("startRecording failed (released during init): ${e.message}")
                    return@launch
                }
                val minThreshold = if (aecActive) MIN_THRESHOLD else MIN_THRESHOLD_NO_AEC
                log("Barge-in active (AEC=$aecActive, minThreshold=$minThreshold)")

                val samplesPerWindow  = SAMPLE_RATE * WINDOW_MS / 1000
                val calibWindows      = CALIBRATION_MS / WINDOW_MS
                val buf               = ShortArray(samplesPerWindow)

                // Phase 1 — calibrate. With AEC on, TTS is cancelled so baseline ≈ ambient noise,
                // BUT residual echo bleeds through in transient peaks (hard consonants, sentence
                // boundaries). We track PEAK rms during calibration so the threshold sits
                // safely above the worst residual we observed while TTS was already playing.
                var baselineSum  = 0.0
                var baselinePeak = 0.0
                var baselineN    = 0
                repeat(calibWindows) {
                    if (!isActive) return@repeat
                    val n = recorder.read(buf, 0, samplesPerWindow)
                    if (n > 0) {
                        val r = rms(buf, n)
                        baselineSum += r
                        baselineN++
                        if (r > baselinePeak) baselinePeak = r
                    }
                }
                val baselineAvg = if (baselineN > 0) baselineSum / baselineN else 0.0
                // Threshold uses the peak residual × headroom, floored at minThreshold.
                // Average is logged for diagnostics only — peak is what causes false positives.
                val threshold = maxOf(baselinePeak * THRESHOLD_HEADROOM, minThreshold)
                log("Baseline avg=%.0f peak=%.0f threshold=%.0f".format(baselineAvg, baselinePeak, threshold))

                // Grace period: AEC sometimes still adapts for a moment after the
                // calibration window. Drop any "above threshold" reads for the first
                // POST_CALIB_GRACE_MS to avoid one-off false trigger right at start.
                val graceUntil = System.currentTimeMillis() + POST_CALIB_GRACE_MS

                // Phase 2 — watch for speech above threshold (CONSECUTIVE = sustained).
                var consecutive = 0
                while (isActive) {
                    val n = recorder.read(buf, 0, samplesPerWindow)
                    if (n <= 0) continue
                    val r = rms(buf, n)
                    val now = System.currentTimeMillis()
                    if (r > threshold) {
                        if (now < graceUntil) {
                            // Still in grace window — log once and skip
                            continue
                        }
                        consecutive++
                        if (consecutive >= CONSECUTIVE) {
                            log("Barge-in! (${consecutive} windows above threshold, rms=%.0f)".format(r))
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
        // VOICE_COMMUNICATION source is the telephony uplink mic — pairs with AEC when
        // AudioManager is in MODE_IN_COMMUNICATION (speakerphone mode). AEC gets the
        // telephony downlink as its reference signal, which is exactly what's playing
        // through the speaker during TTS in that mode. MIC is the fallback.
        for (source in listOf(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
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
