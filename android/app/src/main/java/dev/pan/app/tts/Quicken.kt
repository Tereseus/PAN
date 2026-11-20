package dev.pan.app.tts

import kotlin.math.PI
import kotlin.math.cos

/**
 * A line said quicker without losing a sound. The voice model is asked for its own unhurried pace
 * and the samples are shortened here, by overlapping short pieces at the spot where they fit best,
 * so the pitch stays and nothing is skipped.
 *
 * Why: asked for 1.2 itself, Supertonic 3 drops the ends of clauses. The owner heard "Super" where
 * the line was "Super Bowls" and a list of years with the last figure of each missing
 * (2026-11-20). Read back by the phone's own ear, 20 lines three times each: built at 1.2, 14% of
 * words wrong and the last word lost in 11 of 60; built at 1.0, 8% and 6 of 60; built at 1.0 and
 * shortened here to the pace of 1.2, 8% and 5 of 60. The speaker was not at fault: on a Pixel 6 Pro
 * and a Pixel 10 Pro the mic heard every sample handed to it, to the last one.
 *
 * The last 40 ms or so of the line are passed through untouched.
 */
object Quicken {
    /** What the model is asked for, and how much [faster] has to add, to say a line at [pace]. */
    fun plan(pace: Float): Pair<Float, Float> = if (pace > 1f) 1f to pace else pace to 1f

    fun faster(x: FloatArray, rate: Int, speed: Float): FloatArray {
        if (speed <= 1.001f) return x
        val n = (rate * 30 / 1000) and 1.inv()   // one piece, 30 ms
        val hop = n / 2                          // pieces overlap by half
        val reach = rate * 8 / 1000              // how far either side to look for the best join
        val step = 4                             // compare every 4th sample
        val frames = ((x.size - n - reach) / (hop * speed)).toInt()
        if (frames < 2) return x
        val win = FloatArray(n) { (0.5 - 0.5 * cos(2 * PI * (it + 0.5) / n)).toFloat() }
        val body = FloatArray(frames * hop)
        // The first piece starts at full level, with no fade in, and fades out into the second.
        for (i in 0 until hop) body[i] = x[i]
        for (i in hop until n) body[i] += x[i] * win[i]
        var pos = 0
        for (k in 1 until frames) {
            val want = (k * hop * speed).toInt()     // where this piece would come from, untouched
            val follow = pos + hop                   // what came next after the last piece
            val lo = maxOf(0, want - reach)
            val hi = minOf(x.size - n, want + reach)
            var at = minOf(want, x.size - n)
            if (follow + n <= x.size) {
                var best = Float.NEGATIVE_INFINITY
                var c = lo
                while (c <= hi) {
                    var s = 0f
                    var i = 0
                    while (i < n) { s += x[c + i] * x[follow + i]; i += step }
                    if (s > best) { best = s; at = c }
                    c += 2
                }
            }
            pos = at
            val to = k * hop
            val len = if (k < frames - 1) n else hop
            for (i in 0 until len) body[to + i] += x[pos + i] * win[i]
        }
        // From the middle of the last piece on, the line is untouched to its very end.
        val rest = x.size - (pos + hop)
        val out = body.copyOf(body.size + rest)
        System.arraycopy(x, pos + hop, out, body.size, rest)
        return out
    }
}
