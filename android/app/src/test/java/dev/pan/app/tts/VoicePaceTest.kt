package dev.pan.app.tts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoicePaceTest {
    private val v3 = PiperTtsEngine.VOICES.getValue(VoiceChoice.MAIN)
    private val slow = VoiceTiming.Stats(50, 2400, 1500)

    @Test fun autoIsExactlyTheVoicesOwnPaceWhateverTheTiming() {
        for (t in listOf(VoiceTiming.NONE, slow, VoiceTiming.Stats(50, 200, 90))) {
            val p = VoicePace.choose(null, null, v3.speed, v3.steps, t)
            assertTrue(p.auto)
            assertEquals(v3.speed, p.speed)
            assertEquals(v3.steps, p.steps)
        }
    }

    @Test fun aSpeedByHandWins() {
        val p = VoicePace.choose(1.3f, null, v3.speed, v3.steps, slow)
        assertFalse(p.auto)
        assertEquals(1.3f, p.speed)
        assertEquals(v3.steps, p.steps)
    }

    @Test fun stepsByHandApplyInAutoAndManual() {
        assertEquals(6, VoicePace.choose(null, 6, v3.speed, v3.steps, slow).steps)
        assertEquals(3, VoicePace.choose(1.1f, 3, v3.speed, v3.steps, slow).steps)
        assertEquals(v3.steps, VoicePace.choose(null, 0, v3.speed, v3.steps, slow).steps)
    }

    @Test fun zeroMeansAuto() {
        assertTrue(VoicePace.choose(0f, null, v3.speed, v3.steps, slow).auto)
    }

    @Test fun handSpeedSitsOnTheGridInRange() {
        assertEquals(0.9f, VoicePace.snap(0.5f))
        assertEquals(1.6f, VoicePace.snap(2.4f))
        assertEquals(1.25f, VoicePace.snap(1.26f))
        assertEquals(1.2f, VoicePace.snap(1.2f))
        assertEquals(1.6f, VoicePace.choose(9f, null, v3.speed, v3.steps, slow).speed)
    }

    @Test fun describeReadsPlainly() {
        assertEquals("Auto, speed 1.20, 4 steps", VoicePace.describe(VoicePace.Pick(1.2f, 4, true)))
        assertEquals("Manual, speed 1.35, 5 steps", VoicePace.describe(VoicePace.Pick(1.35f, 5, false)))
    }
}
