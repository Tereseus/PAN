package dev.pan.app.stt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.GZIPInputStream
import kotlin.math.abs
import kotlin.math.max

/**
 * Proves the Kotlin Whisper features are the ones Smart Turn was trained on.
 *
 * The reference fixtures come from Pipecat's own pipeline (smart-turn inference.py
 * + transformers WhisperFeatureExtractor, torch path) run on the same 16-bit WAVs,
 * so both sides start from bit-identical audio. The clips were built the way the
 * phone sees a candidate end-of-turn: speech, then 0.35 s of room-noise silence.
 * long_ramble is 11.7 s and exercises the keep-the-last-8-seconds path; the rest
 * are shorter and exercise the pad-at-the-start path.
 *
 * Why this test exists: a feature pipeline that is slightly wrong does not crash.
 * The model keeps answering, confidently, about audio it was never shown.
 */
class WhisperLogMelTest {

    companion object {
        val CLIPS = listOf("complete_peru", "complete_weather", "incomplete_want", "incomplete_because", "long_ramble")

        private fun bytes(name: String): ByteArray =
            (WhisperLogMelTest::class.java.getResourceAsStream("/smartturn/$name")
                ?: error("missing test fixture /smartturn/$name")).use { it.readBytes() }

        /** 16 kHz mono 16-bit PCM WAV -> floats in -1..1, the same scaling the phone uses. */
        fun loadWav(name: String): FloatArray {
            val b = ByteBuffer.wrap(bytes(name)).order(ByteOrder.LITTLE_ENDIAN)
            require(String(b.array(), 0, 4) == "RIFF" && String(b.array(), 8, 4) == "WAVE") { "$name is not a WAV" }
            var pos = 12
            while (pos + 8 <= b.limit()) {
                val id = String(b.array(), pos, 4)
                val size = b.getInt(pos + 4)
                if (id == "data") {
                    val n = size / 2
                    return FloatArray(n) { b.getShort(pos + 8 + it * 2) / 32768.0f }
                }
                pos += 8 + size + (size and 1)
            }
            error("$name has no data chunk")
        }

        fun loadFeatures(name: String): FloatArray {
            val raw = GZIPInputStream(bytes(name).inputStream()).use { it.readBytes() }
            val b = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
            return FloatArray(b.remaining()).also { b.get(it) }
        }
    }

    @Test
    fun shapeIsTheModelInput() {
        val f = WhisperLogMel.compute(FloatArray(16000))
        assertEquals(80 * 800, f.size)
    }

    @Test
    fun featuresMatchPipecatReference() {
        for (clip in CLIPS) {
            val audio = loadWav("$clip.wav")
            val ref = loadFeatures("$clip.features.f32.gz")
            val t0 = System.nanoTime()
            val mine = WhisperLogMel.compute(audio)
            val ms = (System.nanoTime() - t0) / 1_000_000
            assertEquals("$clip size", ref.size, mine.size)
            var maxErr = 0f
            for (i in ref.indices) maxErr = max(maxErr, abs(ref[i] - mine[i]))
            println("%-20s %5.2fs audio  max|diff| %.2e  %d ms".format(clip, audio.size / 16000f, maxErr, ms))
            // Reference is float32 torch; this is float32 accumulation. 1e-3 is two
            // orders of magnitude inside anything the model could notice.
            assertTrue("$clip: max|diff| $maxErr", maxErr < 1e-3f)
        }
    }
}
