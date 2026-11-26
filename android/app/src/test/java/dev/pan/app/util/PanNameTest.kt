package dev.pan.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PanNameTest {
    @Test fun cleans() {
        assertEquals("Jamie", PanName.clean("  Jamie "))
        assertEquals("Mii-chan", PanName.clean("Mii-chan"))
        assertEquals("", PanName.clean("Pan"))
        assertEquals("", PanName.clean("ΠAN"))
        assertEquals("", PanName.clean("one two three four"))
    }

    @Test fun mutePatternUsesTheOwnName() {
        val n = PanName.namePattern("jamie")
        val mute = Regex("^(?:(?:hey |ok |okay )?$n[,.]?\\s+)?(?:please\\s+)?(?:mute(?: yourself)?|be quiet)(?:[,]?\\s+$n)?[.!]?$")
        assertTrue(mute.matches("jamie, be quiet"))
        assertTrue(mute.matches("mute"))
        assertFalse(mute.matches("pan, be quiet"))
        val none = PanName.namePattern("")
        assertTrue(Regex("^$none, mute$").matches("pan, mute"))
    }

    @Test fun twoWordName() {
        val n = PanName.namePattern("mii chan")
        assertTrue(Regex("^$n, mute$").matches("mii chan, mute"))
    }
}
