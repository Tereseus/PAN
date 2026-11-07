package dev.pan.app.tts

/**
 * Numbers as words, for a line the voice reads to someone. The translator writes digits, and on
 * lines that are mostly numbers Supertonic got 24% of the sounds wrong in English and 8% in Greek,
 * against 11% and 1% as words: "1,200 yen" came back "1 to 00 yen", "στις 15" as "στις 5"
 * (evals/ears/voice_readback.py, 2026-11-06). In an interpreter those are the words that matter
 * most. Japanese reads its digits well, 0.8%, so it stays as it is.
 */
object SpokenNumbers {
    fun say(text: String, lang: String): String = when {
        text.none { it.isDigit() } -> text
        lang == "en" -> english(text)
        lang == "el" -> greek(text)
        else -> text
    }

    private val ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen " +
        "fourteen fifteen sixteen seventeen eighteen nineteen").split(" ")
    private val TENS = "x x twenty thirty forty fifty sixty seventy eighty ninety".split(" ")
    private val IRREGULAR = mapOf("one" to "first", "two" to "second", "three" to "third", "five" to "fifth",
        "eight" to "eighth", "nine" to "ninth", "twelve" to "twelfth")

    private val EN_CLOCK = Regex("\\b(\\d{1,2}):(\\d{2})\\b")
    private val EN_POINT = Regex("\\b(\\d+)\\.(\\d+)\\b")
    private val EN_ORDINAL = Regex("\\b(\\d+)(?:st|nd|rd|th)\\b")
    private val EN_GROUPED = Regex("\\b\\d{1,3}(?:,\\d{3})+\\b")
    private val EN_PLAIN = Regex("\\b\\d+\\b")

    private fun digits(s: String, names: List<String>) = s.map { names[it - '0'] }.joinToString(" ")

    private fun cardinal(n: Long): String = when {
        n < 20 -> ONES[n.toInt()]
        n < 100 -> TENS[(n / 10).toInt()] + if (n % 10 != 0L) " " + ONES[(n % 10).toInt()] else ""
        n < 1_000 -> ONES[(n / 100).toInt()] + " hundred" + if (n % 100 != 0L) " " + cardinal(n % 100) else ""
        n < 1_000_000 -> cardinal(n / 1_000) + " thousand" + if (n % 1_000 != 0L) " " + cardinal(n % 1_000) else ""
        else -> cardinal(n / 1_000_000) + " million" + if (n % 1_000_000 != 0L) " " + cardinal(n % 1_000_000) else ""
    }

    private fun ordinal(n: Long): String {
        val words = cardinal(n).split(" ")
        val last = words.last()
        val nth = IRREGULAR[last] ?: if (last.endsWith("y")) last.dropLast(1) + "ieth" else last + "th"
        return (words.dropLast(1) + nth).joinToString(" ")
    }

    // Longer than this is a phone number or a code, read a digit at a time.
    private const val LONGEST = 9

    private fun english(text: String): String {
        var s = EN_CLOCK.replace(text) { m ->
            val hour = cardinal(m.groupValues[1].toLong())
            val minute = m.groupValues[2].toLong()
            when {
                minute == 0L -> "$hour o'clock"
                minute < 10 -> "$hour oh ${cardinal(minute)}"
                else -> "$hour ${cardinal(minute)}"
            }
        }
        s = EN_POINT.replace(s) { m -> cardinal(m.groupValues[1].toLong()) + " point " + digits(m.groupValues[2], ONES) }
        s = EN_ORDINAL.replace(s) { m -> ordinal(m.groupValues[1].toLong()) }
        s = EN_GROUPED.replace(s) { m -> m.value.replace(",", "").let { if (it.length <= LONGEST) cardinal(it.toLong()) else digits(it, ONES) } }
        return EN_PLAIN.replace(s) { m -> if (m.value.length <= LONGEST) cardinal(m.value.toLong()) else digits(m.value, ONES) }
    }

    private val EL_ONES = ("μηδέν ένα δύο τρία τέσσερα πέντε έξι επτά οκτώ εννέα δέκα έντεκα δώδεκα δεκατρία " +
        "δεκατέσσερα δεκαπέντε δεκαέξι δεκαεπτά δεκαοκτώ δεκαεννέα").split(" ")
    private val EL_TENS = "x x είκοσι τριάντα σαράντα πενήντα εξήντα εβδομήντα ογδόντα ενενήντα".split(" ")
    private val EL_HUNDREDS = "x εκατό διακόσια τριακόσια τετρακόσια πεντακόσια εξακόσια επτακόσια οκτακόσια εννιακόσια".split(" ")
    private val EL_FEMININE = mapOf(1 to "μία", 3 to "τρεις", 4 to "τέσσερις", 13 to "δεκατρείς", 14 to "δεκατέσσερις")

    private val EL_CLOCK = Regex("(?<![\\d.,:])(\\d{1,2}):(\\d{2})(?!\\d)")
    private val EL_COMMA = Regex("(?<![\\d.])(\\d+),(\\d+)(?!\\d)")
    private val EL_GROUPED = Regex("(?<!\\d)\\d{1,3}(?:\\.\\d{3})+(?!\\d)")
    private val EL_HOUR = Regex("([Σσ]τις) (\\d{1,2})(?!\\d)")
    private val EL_PLAIN = Regex("(?<!\\d)\\d+(?!\\d)")

    /** Hours and thousands are feminine in Greek, and most other things in a shop are neuter. */
    private fun greekCardinal(n: Long, feminine: Boolean = false): String {
        fun rest(of: Long, unit: Long) = if (of % unit != 0L) " " + greekCardinal(of % unit, feminine) else ""
        return when {
            n < 20 -> (if (feminine) EL_FEMININE[n.toInt()] else null) ?: EL_ONES[n.toInt()]
            n < 100 -> EL_TENS[(n / 10).toInt()] + rest(n, 10)
            n % 100 == 0L && n < 1_000 -> EL_HUNDREDS[(n / 100).toInt()]
            n < 200 -> "εκατόν" + rest(n, 100)
            n < 1_000 -> EL_HUNDREDS[(n / 100).toInt()] + rest(n, 100)
            n < 2_000 -> "χίλια" + rest(n, 1_000)
            n < 1_000_000 -> greekCardinal(n / 1_000, true) + " χιλιάδες" + rest(n, 1_000)
            n < 2_000_000 -> "ένα εκατομμύριο" + rest(n, 1_000_000)
            else -> greekCardinal(n / 1_000_000) + " εκατομμύρια" + rest(n, 1_000_000)
        }
    }

    private fun greek(text: String): String {
        var s = EL_CLOCK.replace(text) { m ->
            val hour = greekCardinal(m.groupValues[1].toLong(), true)
            val minute = m.groupValues[2].toLong()
            if (minute == 0L) hour else "$hour και ${greekCardinal(minute)}"
        }
        s = EL_COMMA.replace(s) { m -> greekCardinal(m.groupValues[1].toLong()) + " κόμμα " + greekCardinal(m.groupValues[2].toLong()) }
        s = EL_GROUPED.replace(s) { m -> m.value.replace(".", "").let { if (it.length <= LONGEST) greekCardinal(it.toLong()) else digits(it, EL_ONES) } }
        s = EL_HOUR.replace(s) { m -> m.groupValues[1] + " " + greekCardinal(m.groupValues[2].toLong(), true) }
        return EL_PLAIN.replace(s) { m -> if (m.value.length <= LONGEST) greekCardinal(m.value.toLong()) else digits(m.value, EL_ONES) }
    }
}
