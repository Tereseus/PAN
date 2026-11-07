package dev.pan.app.interpret

/**
 * Where a heard Japanese line breaks into sentences. The ear often leaves the break out:
 * "日本ですかいいですね" style lines came back as one sentence, and the translator, trained on one sentence at
 * a time, made it into one wrong sentence (2026-11-06). Polite endings mark a sentence, unless more
 * of the same clause follows: ですから and ですが carry on.
 */
object JaSentences {
    private val END = Regex("(ですか|ますか|ましたか|ませんか|ですね|ますね|ですよ|ますよ|でした|ました|ません|です|ます)(?![がけからのとしでにもねよかな、。！？?!]|$)")

    fun split(text: String): List<String> {
        val out = mutableListOf<String>()
        var from = 0
        for (m in END.findAll(text)) {
            val end = m.range.last + 1
            out += text.substring(from, end) + "。"
            from = end
        }
        if (from < text.length) out += text.substring(from)
        return out
    }
}
