package dev.pan.app.tts

/**
 * An interpreted line in the pieces the voice builds. Supertonic builds a whole piece before any
 * of it sounds, so the first clause goes alone and the rest builds while that one plays. The rest
 * stays in whole sentences: a clause on its own loses its tune, and only the first has to be quick.
 *
 * A line with no early comma is cut at a natural joint instead, after a particle in Japanese and
 * before a joining word in English. Build time follows length, 0.52 s for 5 kana against 1.09 s
 * for 21 (app 0.4.79, 4 steps), and people do not speak in commas (the owner, 2026-11-06).
 */
object LineClauses {
    // A space after the mark, so "1,200" and "3.5" stay in one piece.
    private val FIRST = Regex("(?<=[,;:.!?])\\s+|(?<=[、，；：。！？])\\s*")
    private val SENTENCE = Regex("(?<=[.!?])\\s+|(?<=[。！？])\\s*")
    private const val MIN_WEIGHT = 10
    // A comma later than this costs more than cutting at a joint.
    private const val QUICK_WEIGHT = 16
    private const val JA_PARTICLES = "はがをにでへと"
    private const val JA_FOLLOWERS = "はもの"
    private val EN_JOINT = Regex("\\s+(?=(?:near|at|in|on|for|with|and|but|because|when|if|from|after|before)\\b)", RegexOption.IGNORE_CASE)

    // A kana or kanji takes about as long to say as two Latin letters.
    private fun weight(s: String) = s.sumOf { c ->
        when {
            c.code >= 0x3000 -> 2
            c.isLetterOrDigit() -> 1
            else -> 0
        }.toInt()
    }

    private fun kanjiOrKatakana(c: Char) = c.code in 0x4E00..0x9FFF || c.code in 0x30A0..0x30FF

    /** Where a Japanese line can break after a particle: a particle straight after a noun. */
    private fun japaneseJoint(line: String): Int? {
        for (i in 3 until line.length - 1) {
            if (line[i] !in JA_PARTICLES || !kanjiOrKatakana(line[i - 1])) continue
            val end = if (line[i + 1] in JA_FOLLOWERS) i + 2 else i + 1
            if (weight(line.substring(end)) >= MIN_WEIGHT) return end
        }
        return null
    }

    private fun englishJoint(line: String): Int? = EN_JOINT.findAll(line).firstOrNull { m ->
        weight(line.substring(0, m.range.first)) >= MIN_WEIGHT - 2 &&
            weight(line.substring(m.range.last + 1)) >= MIN_WEIGHT
    }?.range?.first

    fun split(text: String): List<String> {
        val line = text.trim()
        val cut = FIRST.findAll(line).firstOrNull { m ->
            weight(line.substring(0, m.range.first)) >= MIN_WEIGHT &&
                weight(line.substring(m.range.first + m.value.length)) >= MIN_WEIGHT
        }
        val commaAt = cut?.range?.first
        val quick = commaAt != null && weight(line.substring(0, commaAt)) <= QUICK_WEIGHT
        val joint = if (quick) null else if (line.any { it.code >= 0x3000 }) japaneseJoint(line) else englishJoint(line)
        val head: String
        val rest: String
        when {
            joint != null && (commaAt == null || joint < commaAt) -> {
                head = line.substring(0, joint).trim()
                rest = line.substring(joint).trim()
            }
            cut != null -> {
                head = line.substring(0, cut.range.first).trim()
                rest = line.substring(cut.range.first + cut.value.length)
            }
            else -> return listOf(line)
        }
        val tail = mutableListOf<String>()
        for (s in rest.split(SENTENCE).filter { it.isNotBlank() }) {
            if (tail.isNotEmpty() && weight(tail.last()) < MIN_WEIGHT) tail[tail.lastIndex] = tail.last() + " " + s.trim()
            else tail += s.trim()
        }
        return listOf(head) + tail
    }
}
