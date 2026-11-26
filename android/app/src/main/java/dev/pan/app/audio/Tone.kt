package dev.pan.app.audio

import kotlin.math.PI
import kotlin.math.sin

/** ΠAN's own feedback sounds: short, soft sine notes with smooth ends (no click). */
object Tone {
    const val RATE = 24000

    /** Two notes going down: muted. */
    fun muteNotes(): ShortArray = notes(listOf(660.0 to 90, 440.0 to 130))

    fun notes(list: List<Pair<Double, Int>>, level: Double = 0.25): ShortArray {
        val out = ArrayList<Short>()
        for ((hz, ms) in list) {
            val n = RATE * ms / 1000
            val fade = minOf(n / 4, RATE * 12 / 1000)
            for (i in 0 until n) {
                val edge = minOf(i, n - 1 - i).toDouble()
                val env = if (edge < fade) sin(PI / 2 * edge / fade) else 1.0
                out.add((sin(2 * PI * hz * i / RATE) * env * level * 32767).toInt().toShort())
            }
        }
        return out.toShortArray()
    }
}
