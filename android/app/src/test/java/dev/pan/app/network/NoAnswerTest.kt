package dev.pan.app.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class NoAnswerTest {
    @Test fun aPhoneNeverPairedSaysSoWhateverElseIsWrong() {
        assertEquals("This phone isn't paired with a computer yet.", NoAnswer.words(paired = false, online = true))
        assertEquals("This phone isn't paired with a computer yet.", NoAnswer.words(paired = false, online = false))
    }
    @Test fun noInternetIsNotBlamedOnTheComputer() =
        assertEquals("There's no internet on this phone.", NoAnswer.words(paired = true, online = false))
    @Test fun pairedAndOnlineItIsTheComputer() =
        assertEquals("Your computer isn't answering.", NoAnswer.words(paired = true, online = true))
    @Test fun theThreeAreNeverTheSameSentence() {
        val all = setOf(NoAnswer.words(false, true), NoAnswer.words(true, false), NoAnswer.words(true, true))
        assertNotEquals(1, all.size); assertEquals(3, all.size)
    }
}
