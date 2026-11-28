package dev.pan.app.tts

import dev.pan.app.tts.VoiceTiming.Line
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceTimingTest {
    @Test fun audioLengthFromSamples() {
        assertEquals(1000L, VoiceTiming.audioMs(44100, 44100))
        assertEquals(500L, VoiceTiming.audioMs(22050, 44100))
        assertEquals(0L, VoiceTiming.audioMs(100, 0))
        assertEquals(0L, VoiceTiming.audioMs(0, 44100))
    }

    @Test fun medianOddAndEven() {
        assertEquals(0L, VoiceTiming.median(emptyList()))
        assertEquals(3L, VoiceTiming.median(listOf(5, 1, 3)))
        assertEquals(4L, VoiceTiming.median(listOf(2, 6, 3, 5)))
    }

    @Test fun keepsOnlyTheLastFiftyAndNoSilentLines() {
        var lines = emptyList<Line>()
        for (i in 1..60) lines = VoiceTiming.add(lines, Line(i.toLong(), 1000))
        assertEquals(VoiceTiming.KEEP, lines.size)
        assertEquals(11L, lines.first().buildMs)
        assertEquals(60L, lines.last().buildMs)
        assertEquals(lines, VoiceTiming.add(lines, Line(5, 0)))
    }

    @Test fun ratioIsBuildMsPerSecondOfSound() {
        // 500 ms for 2 s of sound = 250 a second; 900 for 1 s = 900; 300 for 3 s = 100.
        val s = VoiceTiming.stats(listOf(Line(500, 2000), Line(900, 1000), Line(300, 3000)))
        assertEquals(3, s.count)
        assertEquals(500L, s.medianBuildMs)
        assertEquals(250L, s.ratio)
    }

    @Test fun nothingMeasured() {
        assertTrue(VoiceTiming.stats(emptyList()).empty)
    }

    @Test fun savedTextRoundTripsAndSkipsJunk() {
        val lines = listOf(Line(420, 1800), Line(0, 300))
        assertEquals(lines, VoiceTiming.decode(VoiceTiming.encode(lines)))
        assertEquals(listOf(Line(1, 2)), VoiceTiming.decode("x:3,1:2,5,4:0,:,"))
        assertEquals(emptyList<Line>(), VoiceTiming.decode(null))
    }

    @Test fun slowBuilderNeedsEnoughLinesAndAHighRatio() {
        assertTrue(!VoiceTiming.slowBuilder(VoiceTiming.Stats(4, 900, 900)))
        assertTrue(!VoiceTiming.slowBuilder(VoiceTiming.Stats(20, 300, 250)))
        assertTrue(VoiceTiming.slowBuilder(VoiceTiming.Stats(20, 1800, 700)))
    }
}
