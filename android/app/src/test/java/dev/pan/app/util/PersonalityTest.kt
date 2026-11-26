package dev.pan.app.util

import org.junit.Assert.assertEquals
import org.junit.Test

/** The personality field every voice turn carries (PanServerClient.askPanStream, QueryRequest). */
class PersonalityTest {
    @Test fun turnedOffSendsAnEmptyStringNotNothing() {
        assertEquals("", Personality.forTurn(null))
        assertEquals("", Personality.forTurn(""))
        assertEquals("", Personality.forTurn("   \n "))
    }

    @Test fun theDevicesOwnTextGoesAsIsTrimmed() =
        assertEquals("Dry and short, like a ship's computer", Personality.forTurn("  Dry and short, like a ship's computer \n"))

    @Test fun aVeryLongTextIsCut() =
        assertEquals(Personality.MAX_CHARS, Personality.forTurn("a".repeat(Personality.MAX_CHARS + 500)).length)

    @Test fun theDefaultIsWhatThisDeviceSaved() =
        // Nothing saved in a test run: the turn says "turned off", never the hub's global text.
        assertEquals("", Personality.forTurn())
}
