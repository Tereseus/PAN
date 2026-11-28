package dev.pan.app.tts

/**
 * The pieces ΠAN's voice said for one reply, as the hub's speech timing wants them (task 1107):
 * ms from the first piece's text reaching the voice. The hub (voice-timing.js speechGaps) splits
 * each silence between pieces into the hub sending late, this device building late, and the
 * speaker. Plain math, tested in SpeechTimesTest.
 */
object SpeechTimes {
    data class Row(val queued: Long, val builtFrom: Long, val built: Long, val play: Long, val end: Long,
                   val audio: Long, val chars: Int, val cut: Boolean)

    /** Pieces in the order they were handed in, relative to the first; pieces never played are left out. */
    fun rows(pieces: List<PiperTtsEngine.Piece>): List<Row> {
        val played = pieces.filter { it.play > 0 }.sortedBy { it.queued }
        if (played.isEmpty()) return emptyList()
        val t0 = played.first().queued
        fun r(x: Long) = if (x > 0) x - t0 else -1L
        return played.map { Row(r(it.queued), r(it.builtFrom), r(it.built), r(it.play), r(it.end), it.audioMs, it.chars, it.cut) }
    }

    /** The silence before each piece after the first, ms. */
    fun gaps(rows: List<Row>): List<Long> = rows.zipWithNext { a, b -> if (a.end >= 0 && b.play >= 0) b.play - a.end else 0L }
}
