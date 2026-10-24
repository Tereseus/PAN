package dev.pan.app.stt

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Whisper log-mel features, computed exactly the way Smart Turn was trained on them.
 *
 * Smart Turn is a Whisper-tiny encoder with a classifier head, so it only works if
 * it is fed the same spectrogram Whisper's feature extractor makes. A model given
 * slightly different features does not fail loudly - it just returns confident
 * wrong answers. So every step here mirrors Pipecat's inference.py plus
 * transformers' WhisperFeatureExtractor, and WhisperLogMelTest checks the output
 * against that reference on real speech (max |diff| was 2e-5 in float64).
 *
 * The steps, in order - each one is load-bearing:
 *  1. Keep the LAST 8 s. Shorter audio is padded with zeros at the START, so the
 *     pause he just made always sits at the end of the window
 *     (smart-turn audio_utils.truncate_audio_to_last_n_seconds).
 *  2. Zero-mean / unit-variance over all 128,000 samples, padding INCLUDED. The
 *     padding happens before the feature extractor sees the audio, so its
 *     attention mask covers everything and the zeros take part in the mean. The
 *     padded region therefore ends up at -mean/std, not at zero.
 *  3. STFT: n_fft 400, hop 160, periodic Hann, reflect padding of 200 at both
 *     ends (torch.stft center=True). 801 frames; the last is dropped -> 800.
 *  4. Power spectrum -> 80 Slaney mel bands (0-8 kHz, Slaney area normalisation).
 *  5. log10(max(x, 1e-10)), floored at (global max - 8), then (x + 4) / 4.
 *
 * Pure Kotlin, no Android imports, so the unit test runs it on the desktop JVM.
 */
object WhisperLogMel {
    const val SAMPLE_RATE = 16000
    const val SAMPLES = 8 * SAMPLE_RATE          // 128,000
    const val N_FFT = 400
    const val HOP = 160
    const val N_FREQ = N_FFT / 2 + 1             // 201
    const val N_MELS = 80
    const val FRAMES = SAMPLES / HOP             // 800
    private const val PAD = N_FFT / 2            // 200

    private val window = FloatArray(N_FFT) { (0.5 - 0.5 * cos(2.0 * PI * it / N_FFT)).toFloat() }

    // DFT basis, [k][n]. N=400 is not a power of two; a direct DFT over the frames
    // that actually contain audio is cheap enough, and exact.
    private val dftCos = FloatArray(N_FREQ * N_FFT)
    private val dftSin = FloatArray(N_FREQ * N_FFT)

    // Slaney mel filterbank, [mel][freq].
    private val melFb = FloatArray(N_MELS * N_FREQ)

    init {
        for (k in 0 until N_FREQ) for (n in 0 until N_FFT) {
            // (k*n) mod N keeps the angle small, so float error does not grow with k*n.
            val a = 2.0 * PI * ((k * n) % N_FFT) / N_FFT
            dftCos[k * N_FFT + n] = cos(a).toFloat()
            dftSin[k * N_FFT + n] = sin(a).toFloat()
        }
        buildMelFilterbank()
    }

    private fun hzToMel(f: Double): Double =
        if (f >= 1000.0) 15.0 + ln(f / 1000.0) * (27.0 / ln(6.4)) else 3.0 * f / 200.0

    private fun melToHz(m: Double): Double =
        if (m >= 15.0) 1000.0 * exp(ln(6.4) / 27.0 * (m - 15.0)) else 200.0 * m / 3.0

    private fun buildMelFilterbank() {
        val fftFreqs = DoubleArray(N_FREQ) { it * (SAMPLE_RATE / 2.0) / (N_FREQ - 1) }
        val melMin = hzToMel(0.0)
        val melMax = hzToMel(SAMPLE_RATE / 2.0)
        val filtFreqs = DoubleArray(N_MELS + 2) {
            melToHz(melMin + (melMax - melMin) * it / (N_MELS + 1))
        }
        for (m in 0 until N_MELS) {
            val enorm = 2.0 / (filtFreqs[m + 2] - filtFreqs[m])
            val dLo = filtFreqs[m + 1] - filtFreqs[m]
            val dHi = filtFreqs[m + 2] - filtFreqs[m + 1]
            for (f in 0 until N_FREQ) {
                val down = (fftFreqs[f] - filtFreqs[m]) / dLo
                val up = (filtFreqs[m + 2] - fftFreqs[f]) / dHi
                melFb[m * N_FREQ + f] = (max(0.0, min(down, up)) * enorm).toFloat()
            }
        }
    }

    /**
     * Features for the most recent [length] samples of [audio] (16 kHz mono,
     * -1..1). Returns [N_MELS * FRAMES] floats laid out [mel][frame], which is
     * the model's [1, 80, 800] input with the batch dimension dropped.
     */
    fun compute(audio: FloatArray, length: Int = audio.size): FloatArray {
        // 1. last 8 s, zero-padded at the start
        val n = min(length, SAMPLES)
        val dst = SAMPLES - n
        val src = length - n
        val x = DoubleArray(SAMPLES)
        for (i in 0 until n) x[dst + i] = audio[src + i].toDouble()

        // 2. normalise over all 128,000 samples, padding included
        var sum = 0.0
        for (v in x) sum += v
        val mean = sum / SAMPLES
        var sq = 0.0
        for (v in x) { val d = v - mean; sq += d * d }
        val inv = 1.0 / sqrt(sq / SAMPLES + 1e-7)

        // 3. reflect padding (numpy/torch "reflect": the edge sample is not repeated)
        val p = FloatArray(SAMPLES + 2 * PAD)
        for (i in 0 until SAMPLES) p[PAD + i] = ((x[i] - mean) * inv).toFloat()
        for (i in 0 until PAD) {
            p[PAD - 1 - i] = p[PAD + 1 + i]
            p[PAD + SAMPLES + i] = p[PAD + SAMPLES - 2 - i]
        }

        // 4. power spectrum -> mel -> log10
        //
        // Every frame that lies wholly inside the constant padding has the same
        // spectrum, so it is computed once and reused. For a 2 s utterance that is
        // ~600 of the 800 frames - the difference between ~30 ms and ~120 ms on a
        // phone, paid on every pause.
        val out = FloatArray(N_MELS * FRAMES)
        val frame = FloatArray(N_FFT)
        val power = FloatArray(N_FREQ)
        var constVal = Float.NaN
        var constMel: FloatArray? = null
        for (t in 0 until FRAMES) {
            val off = t * HOP
            val first = p[off]
            var constant = true
            for (i in 1 until N_FFT) if (p[off + i] != first) { constant = false; break }

            val mel = if (constant && constMel != null && first == constVal) constMel!! else {
                for (i in 0 until N_FFT) frame[i] = p[off + i] * window[i]
                for (k in 0 until N_FREQ) {
                    var re = 0f
                    var im = 0f
                    val base = k * N_FFT
                    for (i in 0 until N_FFT) {
                        val v = frame[i]
                        re += v * dftCos[base + i]
                        im += v * dftSin[base + i]
                    }
                    power[k] = re * re + im * im
                }
                val m = FloatArray(N_MELS)
                for (mm in 0 until N_MELS) {
                    var s = 0f
                    val base = mm * N_FREQ
                    for (k in 0 until N_FREQ) s += melFb[base + k] * power[k]
                    m[mm] = s
                }
                if (constant) { constVal = first; constMel = m }
                m
            }
            for (mm in 0 until N_MELS) out[mm * FRAMES + t] = log10(max(mel[mm], 1e-10f))
        }

        // 5. floor at (max - 8), then scale
        var mx = Float.NEGATIVE_INFINITY
        for (v in out) if (v > mx) mx = v
        val floor = mx - 8f
        for (i in out.indices) out[i] = (max(out[i], floor) + 4f) / 4f
        return out
    }
}
