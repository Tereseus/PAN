package dev.pan.app.tts

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * ΠAN's voice is part of the app (the owner, 2026-11-19): the build puts its files in the assets
 * (app/build.gradle.kts fetchVoice). A build without them would fall back to a download on first
 * start, which is how the car unit came to speak in the Android voice. This fails that build.
 */
class VoiceInTheAppTest {
    // Unit tests run with the app module as the working folder.
    private val dir = File("src/main/assets/voices/${VoiceChoice.MAIN}")

    @Test fun everyFileTheVoiceNeedsIsInTheApp() {
        val need = mapOf(
            "text_encoder.int8.onnx" to 30_000_000L, "duration_predictor.int8.onnx" to 3_000_000L,
            "vector_estimator.int8.onnx" to 70_000_000L, "vocoder.int8.onnx" to 20_000_000L,
            "voice.bin" to 400_000L, "tts.json" to 1_000L, "unicode_indexer.bin" to 100_000L)
        for ((name, least) in need) {
            val f = File(dir, name)
            assertTrue("$name is missing from the app's assets (${f.absolutePath})", f.exists())
            assertTrue("$name is ${f.length()} bytes, too small to be whole", f.length() >= least)
        }
    }
}
