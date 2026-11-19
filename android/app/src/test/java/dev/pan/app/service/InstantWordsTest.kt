package dev.pan.app.service

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InstantWordsTest {
    @Test fun theCommandItselfTurnsTheLight() {
        for (line in listOf("flashlight", "Flashlight on.", "torch off", "turn on the flashlight", "turn the flashlight off",
            "switch off my torch", "pan, turn on the flashlight", "hey pan flashlight on", "please turn on the flash light", "toggle the flashlight"))
            assertTrue(line, InstantWords.flashlight(line))
    }

    @Test fun aSentenceThatOnlyHoldsTheWordDoesNot() {
        for (line in listOf("where did I leave the torch", "the torch is on the table", "I bought a flashlight yesterday",
            "do you think a flashlight would help", "tell her to turn on the flashlight when she gets there", "the olympic torch", ""))
            assertFalse(line, InstantWords.flashlight(line))
    }
}
