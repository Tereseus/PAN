package dev.pan.app.interpret

/**
 * Set phrases, translated by hand. These are the lines the translator gets wrong because their
 * meaning is not in their words: on 40 everyday lines it turned どういたしまして into "how are you doing?"
 * and こちらこそまた明日 into "Here we are again tomorrow." (2026-11-06). They are also the commonest
 * things people say, so a table is both right and instant.
 */
object JaPhrases {
    // These may open a longer line.
    private val OPENERS = listOf(
        "どうもありがとうございます" to "Thank you very much.", "ありがとうございました" to "Thank you very much.",
        "ありがとうございます" to "Thank you very much.", "よろしくお願いします" to "Pleased to meet you.",
        "おはようございます" to "Good morning.", "どういたしまして" to "You're welcome.",
        "おやすみなさい" to "Good night.", "はじめまして" to "Nice to meet you.", "ごめんなさい" to "I'm sorry.",
        "こんにちは" to "Hello.", "こんばんは" to "Good evening.", "こちらこそ" to "Same to you.",
        "さようなら" to "Goodbye.", "すみません" to "Sorry.", "また明日" to "See you tomorrow.")
    // These only mean this when they are the whole sentence.
    private val WHOLE = mapOf(
        "あなたは" to "And you?", "一緒に行きましょう" to "Let's go together.", "いただきます" to "Thanks for the food.",
        "ごちそうさまでした" to "Thank you for the meal.", "大丈夫です" to "It's fine.", "そうですね" to "That's right.",
        "そうですか" to "I see.", "もちろんです" to "Of course.", "いいですね" to "That's nice.",
        "分かりました" to "Got it.", "分かりません" to "I don't understand.", "またね" to "See you.",
        "ありがとう" to "Thanks.", "どうぞ" to "Go ahead.")

    private fun bare(s: String) = s.trim { !it.isLetterOrDigit() }

    /** One sentence into English: the table where it knows the words, [translate] for the rest. */
    fun translate(sentence: String, translate: (String) -> String?): String? {
        val out = mutableListOf<String>()
        var rest = bare(sentence)
        while (rest.isNotEmpty()) {
            val whole = WHOLE[rest]
            if (whole != null) {
                out += whole
                rest = ""
                break
            }
            val hit = OPENERS.firstOrNull { rest.startsWith(it.first) } ?: break
            out += hit.second
            rest = bare(rest.substring(hit.first.length))
        }
        if (rest.isNotEmpty()) translate(sentence.substring(sentence.indexOf(rest)))?.trim()?.let { out += it }
        return out.joinToString(" ").ifBlank { null }
    }
}
