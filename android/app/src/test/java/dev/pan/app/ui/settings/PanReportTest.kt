package dev.pan.app.ui.settings

import dev.pan.app.tts.VoiceTiming
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PanReportTest {
    private val facts = PanReport.Facts("0.5.46", 175, "Google", "Pixel 10 Pro", "Google Tensor G5", "16", 36,
        12L * 1_073_741_824, VoiceTiming.Stats(50, 610, 420), "Auto, speed 1.20, 4 steps", null)

    @Test fun onlyTheListedLines() {
        val lines = PanReport.text(facts).lines().filter { it.isNotBlank() }
        assertEquals(listOf(
            "ΠAN report",
            "App: 0.5.46 (175)",
            "Phone: Google Pixel 10 Pro",
            "Chip: Google Tensor G5",
            "Android: 16 (API 36)",
            "Memory: 12.0 GB",
            "Voice speed: Auto, speed 1.20, 4 steps",
            "Voice timing: 420 ms to build each second of speech, 610 ms a line, over 50 lines",
            "Last crash: none kept",
        ), lines)
    }

    @Test fun crashAndNoTiming() {
        val t = PanReport.text(facts.copy(timing = VoiceTiming.NONE, crash = "2026-11-21 10:00:00 UTC, app 0.5.46\njava.lang.Error\n\tat a.b(C.kt:1)\n"))
        assertTrue(t.contains("Voice timing: no lines measured yet"))
        assertTrue(t.contains("Last crash:\n2026-11-21"))
    }
}
