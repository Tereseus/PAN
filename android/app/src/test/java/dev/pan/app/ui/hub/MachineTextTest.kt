package dev.pan.app.ui.hub

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneId

class MachineTextTest {
    private val et = ZoneId.of("America/New_York")

    @Test fun speed() {
        assertEquals("72 tokens a second on pan-phi-r1, tested Nov 22, 6:08 AM",
            MachineText.speed(72.2, "pan-phi-r1:latest", "2026-11-22T11:08:02.798Z", et))
        assertEquals("8.5 tokens a second", MachineText.speed(8.5, "", "", et))
        assertEquals("Not tested yet", MachineText.speed(0.0, "x", "", et))
    }

    @Test fun loaded() {
        assertEquals("pan-phi-r1 3.1 GB, all on the card", MachineText.loaded(LoadedModel("pan-phi-r1:latest", 3.1, 100)))
        assertEquals("gemma4:e4b 6.6 GB, on the processor", MachineText.loaded(LoadedModel("gemma4:e4b", 6.6, 0)))
        assertEquals("qwen 5.3 GB, 72% on the card", MachineText.loaded(LoadedModel("qwen", 5.3, 72)))
    }

    @Test fun run() {
        assertEquals("Answer model: pan-phi-r1. The hub takes over if the-box is off.",
            MachineText.run(MachineRun("Answer model", "ollama:pan-phi-r1:latest", "the hub takes over if the-box is off")))
        assertEquals("Voice reader: syrinx-lfm-r15", MachineText.run(MachineRun("Voice reader", "reader:syrinx-lfm-r15:latest", "")))
    }
}
