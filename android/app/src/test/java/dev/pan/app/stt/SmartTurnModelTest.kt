package dev.pan.app.stt

import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * End to end: the real model, through the real Kotlin class, on the desktop build
 * of onnxruntime (1.18.0 - pinned older than the phone's 1.30.0 for a Windows
 * msvcp140 reason explained in app/build.gradle.kts; same Java API).
 *
 * Expected outputs come from Pipecat's Python pipeline on the same fixtures, and
 * the fp32 model gave them to four decimals on onnxruntime 1.24 AND 1.30 - which is
 * why 0.01 is a fair tolerance here. (The int8 build is not stable enough across
 * runtimes to test this way; see SmartTurn.kt.) The model is 32 MB and NOT in the
 * repo, so this runs only when SMARTTURN_MODEL points at it:
 *
 *   SMARTTURN_MODEL=/path/smart-turn-v3.2-gpu.onnx ./gradlew :app:testDebugUnitTest
 */
class SmartTurnModelTest {

    private val expected = linkedMapOf(
        "complete_peru" to 0.9828f,
        "complete_weather" to 0.9847f,
        "incomplete_want" to 0.4347f,
        "incomplete_because" to 0.0061f,
        "long_ramble" to 0.0175f,
    )

    @Test
    fun matchesPipecatReference() {
        val path = System.getProperty("smartturn.model").orEmpty()
        assumeTrue(
            "SMARTTURN_MODEL not set - skipping the model test",
            path.isNotEmpty() && File(path).length() == SmartTurn.MODEL_BYTES,
        )
        SmartTurn(File(path)).use { model ->
            for ((clip, want) in expected) {
                val audio = WhisperLogMelTest.loadWav("$clip.wav")
                val t0 = System.nanoTime()
                val p = model.probability(audio)
                val ms = (System.nanoTime() - t0) / 1_000_000
                println("%-20s p=%.4f  want %.4f  %d ms".format(clip, p, want, ms))
                assertEquals("$clip probability", want, p, 0.01f)
                assertEquals("$clip decision", want > SmartTurn.THRESHOLD, p > SmartTurn.THRESHOLD)
            }
        }
    }
}
