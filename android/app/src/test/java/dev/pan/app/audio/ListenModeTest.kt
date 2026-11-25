package dev.pan.app.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ListenModeTest {
    private fun inMode(m: ListenMode.Mode, block: () -> Unit) {
        val was = ListenMode.mode.value
        ListenMode.mode.value = m
        try { block() } finally { ListenMode.mode.value = was }
    }

    @Test fun modeCommandsAreWholeLines() {
        assertEquals(ListenMode.Mode.LISTEN, ListenMode.commandIn("just listen"))
        assertEquals(ListenMode.Mode.LISTEN, ListenMode.commandIn("pan, listen only please"))
        assertEquals(ListenMode.Mode.NAME, ListenMode.commandIn("only answer to your name"))
        assertEquals(ListenMode.Mode.NORMAL, ListenMode.commandIn("back to normal"))
        assertEquals(ListenMode.Mode.FORGET, ListenMode.commandIn("don't remember any of this"))
        assertEquals(ListenMode.Mode.FORGET, ListenMode.commandIn("go incognito"))
        assertNull(ListenMode.commandIn("i like to just listen to music"))
        assertNull(ListenMode.commandIn("i don't remember what he said"))
    }

    @Test fun onlyTheButtonEndsDontRemember() {
        inMode(ListenMode.Mode.FORGET) {
            assertNull(ListenMode.commandIn("remember again"))
            assertNull(ListenMode.commandIn("just listen"))
            assertNull(ListenMode.commandIn("back to normal"))
        }
        inMode(ListenMode.Mode.LISTEN) { assertNull(ListenMode.commandIn("remember again")) }
    }

    @Test fun forgettingIsOnlyDontRemember() {
        inMode(ListenMode.Mode.FORGET) { assertTrue(ListenMode.forgetting()) }
        inMode(ListenMode.Mode.LISTEN) { assertFalse(ListenMode.forgetting()) }
    }

    @Test fun ownWordsAreSplitAndCapped() {
        assertEquals(listOf("Jarvis", "hey you"), ListenMode.split("Jarvis\nhey you, ,Jarvis"))
        assertEquals(12, ListenMode.split((1..20).joinToString("\n") { "w$it" }).size)
    }

    @Test fun leavingDontRememberSaysSo() =
        assertEquals("Okay, I'm remembering again.", ListenMode.ack(ListenMode.Mode.NORMAL, ListenMode.Mode.FORGET))
}
