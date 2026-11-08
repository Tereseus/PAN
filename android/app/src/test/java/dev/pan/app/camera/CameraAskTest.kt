package dev.pan.app.camera

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraAskTest {
    // What the phone's recogniser wrote on 2026-11-08, while the owner pointed the camera.
    @Test fun droppedGStillLooks() = assertTrue(CameraAsk.matches("what am i lookin at"))
    @Test fun tellMeWhatImLookingAt() = assertTrue(CameraAsk.matches("a gay so then tell me what i'm looking at"))
    @Test fun lookThroughTheCamera() = assertTrue(CameraAsk.matches("Alright, look through the camera of my phone and tell me what I'm looking at."))
    @Test fun garbledButStillAsking() = assertTrue(CameraAsk.matches("i looked at the camera of my phone and told me what i'm looking at"))
    @Test fun useThePhonesCamera() = assertTrue(CameraAsk.matches("use the phone's camera"))
    @Test fun curlyApostrophe() = assertTrue(CameraAsk.matches("tell me what I’m looking at"))

    @Test fun oldPhrasesStillWork() {
        for (s in listOf("What am I looking at?", "take a picture", "what do you see", "what is this", "what's that thing over there", "describe this please")) {
            assertTrue(s, CameraAsk.matches(s))
        }
    }

    @Test fun complaintsAndOtherCamerasDont() {
        for (s in listOf(
            "That's not what I was pointing at with the camera.",
            "that was definitely wrong",
            "so you're not actually looking at the camera through the phone",
            "look at the garage camera",
            "what is that movie called, the one with the dreams",
            "I'm looking forward to it",
        )) {
            assertFalse(s, CameraAsk.matches(s))
        }
    }

    @Test fun normalizeKeepsWholeWords() {
        assertEquals("what am i looking at", CameraAsk.normalize("What am I lookin at"))
        assertEquals("seeing it", CameraAsk.normalize("seein' it"))
        assertEquals("looking good", CameraAsk.normalize("looking good"))
        assertEquals("lookout", CameraAsk.normalize("lookout"))
    }
}
