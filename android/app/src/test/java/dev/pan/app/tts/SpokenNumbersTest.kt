package dev.pan.app.tts

import org.junit.Assert.assertEquals
import org.junit.Test

class SpokenNumbersTest {
    private fun en(s: String) = SpokenNumbers.say(s, "en")
    private fun el(s: String) = SpokenNumbers.say(s, "el")

    @Test fun englishAmounts() {
        assertEquals("It costs one thousand two hundred yen.", en("It costs 1,200 yen."))
        assertEquals("That's twenty five euros.", en("That's 25 euros."))
        assertEquals("We are two people.", en("We are 2 people."))
        assertEquals("It is three point five zero euros.", en("It is 3.50 euros."))
        assertEquals("Room two hundred four, please.", en("Room 204, please."))
        assertEquals("zero", en("0"))
        assertEquals("one million two hundred thousand", en("1,200,000"))
    }

    @Test fun englishTimesAndDates() {
        assertEquals("The train leaves at eight fifteen.", en("The train leaves at 8:15."))
        assertEquals("at eight oh five or nine o'clock", en("at 8:05 or 9:00"))
        assertEquals("It's on March fifteenth, the twenty first, the second, the third, the thirtieth.",
            en("It's on March 15th, the 21st, the 2nd, the 3rd, the 30th."))
        assertEquals("Come at seven pm.", en("Come at 7 pm."))
    }

    @Test fun longDigitsAreReadOneAtATime() {
        assertEquals("one two three four five six seven eight nine zero", en("1234567890"))
        assertEquals("ένα δύο τρία τέσσερα πέντε έξι επτά οκτώ εννέα μηδέν", el("1234567890"))
    }

    @Test fun greekAmounts() {
        assertEquals("Κοστίζει είκοσι πέντε ευρώ.", el("Κοστίζει 25 ευρώ."))
        assertEquals("Είναι δώδεκα ευρώ.", el("Είναι 12 ευρώ."))
        assertEquals("Είναι τρία κόμμα πενήντα ευρώ.", el("Είναι 3,50 ευρώ."))
        assertEquals("Το δωμάτιο διακόσια τέσσερα.", el("Το δωμάτιο 204."))
        assertEquals("χίλια διακόσια ευρώ", el("1.200 ευρώ"))
        assertEquals("εκατό και εκατόν είκοσι ένα", el("100 και 121"))
        assertEquals("δύο χιλιάδες πεντακόσια", el("2500"))
        assertEquals("τρεις χιλιάδες", el("3000"))
    }

    @Test fun greekHoursAreFeminine() {
        assertEquals("Στις τρεις και στις δεκατρείς.", el("Στις 3 και στις 13."))
        assertEquals("Στις οκτώ και δεκαπέντε.", el("Στις 8:15."))
        assertEquals("Μένω εδώ τρία χρόνια.", el("Μένω εδώ 3 χρόνια."))
    }

    @Test fun otherLanguagesAndPlainTextAreLeftAlone() {
        assertEquals("この寿司は1,200円です。", SpokenNumbers.say("この寿司は1,200円です。", "ja"))
        assertEquals("No numbers here.", en("No numbers here."))
    }
}
