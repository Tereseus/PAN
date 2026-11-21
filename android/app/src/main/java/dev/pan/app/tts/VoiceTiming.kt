package dev.pan.app.tts

import android.content.Context

/**
 * How long this device takes to build ΠAN's voice (the owner, 2026-11-21). For every Supertonic
 * line: how long the build took and how long the sound it made lasts. The last [KEEP] lines are
 * kept on the device, so a slow unit (the car) can be compared with a fast phone, and so the
 * automatic voice pace ([VoicePace]) has real numbers to work from once its rule is written.
 *
 * The math is plain functions with tests (VoiceTimingTest); [record] and [stats] keep the lines
 * in SharedPreferences. Nothing said is kept: two numbers a line.
 */
object VoiceTiming {
    const val KEEP = 50
    private const val PREFS = "pan_voice_timing"
    private const val KEY = "lines"

    /** One built line: [buildMs] to build it, [audioMs] the length of the sound. */
    data class Line(val buildMs: Long, val audioMs: Long)

    /**
     * [ratio] is the middle of build ms per second of sound over the kept lines (under 1000 means
     * it builds faster than it talks). [medianBuildMs] the middle build time. [count] lines kept.
     */
    data class Stats(val count: Int, val medianBuildMs: Long, val ratio: Long) {
        val empty get() = count == 0
    }

    val NONE = Stats(0, 0, 0)

    fun audioMs(samples: Int, rate: Int): Long = if (rate <= 0 || samples <= 0) 0 else samples * 1000L / rate

    /** [lines] with [line] added, the oldest dropped past [keep]. A line with no sound is not kept. */
    fun add(lines: List<Line>, line: Line, keep: Int = KEEP): List<Line> =
        if (line.audioMs <= 0 || line.buildMs < 0) lines else (lines + line).takeLast(keep)

    fun median(xs: List<Long>): Long {
        if (xs.isEmpty()) return 0
        val s = xs.sorted()
        val m = s.size / 2
        return if (s.size % 2 == 1) s[m] else (s[m - 1] + s[m]) / 2
    }

    fun stats(lines: List<Line>): Stats {
        val ok = lines.filter { it.audioMs > 0 }
        if (ok.isEmpty()) return NONE
        return Stats(ok.size, median(ok.map { it.buildMs }), median(ok.map { it.buildMs * 1000 / it.audioMs }))
    }

    /** "build:audio,build:audio". */
    fun encode(lines: List<Line>): String = lines.joinToString(",") { "${it.buildMs}:${it.audioMs}" }

    fun decode(s: String?): List<Line> = s.orEmpty().split(",").mapNotNull { pair ->
        val p = pair.split(":")
        val b = p.getOrNull(0)?.trim()?.toLongOrNull()
        val a = p.getOrNull(1)?.trim()?.toLongOrNull()
        if (p.size == 2 && b != null && a != null && a > 0 && b >= 0) Line(b, a) else null
    }

    // Kept in memory as well, so a line does not read the file back each time.
    @Volatile private var cache: List<Line>? = null

    private fun lines(context: Context): List<Line> = cache ?: decode(
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)).also { cache = it }

    @Synchronized
    fun record(context: Context, buildMs: Long, audioMs: Long) {
        val next = add(lines(context), Line(buildMs, audioMs))
        cache = next
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, encode(next)).apply()
    }

    fun stats(context: Context): Stats = stats(lines(context))
}
