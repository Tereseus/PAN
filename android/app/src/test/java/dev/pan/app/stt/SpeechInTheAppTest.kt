package dev.pan.app.stt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The models that hear are part of the app (app/build.gradle.kts fetchSpeech puts them in the
 * assets). A build without them would go back to a 107 MB download on the first tap of the mic.
 * This fails that build, and a file of the wrong size: the app accepts a model file by its size.
 */
class SpeechInTheAppTest {
    // Unit tests run with the app module as the working folder.
    private val dir = File("src/main/assets/asr")

    @Test fun everyFileTheMicNeedsIsInTheAppAtItsExactSize() {
        val need = mapOf(
            "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx" to 71_083_163L,
            "decoder-epoch-99-avg-1-chunk-16-left-128.onnx" to 2_092_621L,
            "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx" to 259_335L,
            "tokens.txt" to 5_048L,
            "silero_vad.onnx" to 1_807_522L,
            SmartTurn.MODEL_FILE to SmartTurn.MODEL_BYTES,
        )
        for ((name, size) in need) {
            val f = File(dir, name)
            assertTrue("$name is missing from the app's assets (${f.absolutePath})", f.exists())
            assertEquals("$name has the wrong size", size, f.length())
        }
    }
}
