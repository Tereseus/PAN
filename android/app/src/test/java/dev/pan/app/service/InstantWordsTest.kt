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

    @Test fun aBatteryQuestionIsTheWholeLine() {
        for (line in listOf("what's my battery", "What is the battery level?", "battery level", "how much battery do I have left",
            "pan, how much battery", "hey pan what's the battery at", "how's my battery", "my battery percentage"))
            assertTrue(line, InstantWords.battery(line))
        for (line in listOf("the battery is at 2000 mAh and two small capacitors have to be tuned to the coil",
            "what battery should we buy for the medallion", "how much does the battery cost", "battery", "what level are we on", ""))
            assertFalse(line, InstantWords.battery(line))
    }

    @Test fun onlyARealLevelIsSaid() {
        assertTrue(InstantWords.batteryLevel(57) == 57)
        assertTrue(InstantWords.batteryLevel(Int.MIN_VALUE) == null)
        assertTrue(InstantWords.batteryLevel(211) == null)
    }
}
