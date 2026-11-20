package dev.pan.app.tts

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

class QuickenTest {
    private val rate = 44100

    /** A voiced sound whose pitch and loudness move, three seconds of it. */
    private fun voiced(seconds: Double = 3.0) = FloatArray((rate * seconds).toInt()) { i ->
        val t = i.toDouble() / rate
        (0.5 * sin(2 * PI * (140 + 20 * sin(2 * PI * 0.7 * t)) * t) * (0.7 + 0.3 * sin(2 * PI * 3 * t))).toFloat()
    }

    @Test fun planBuildsAtTheModelsOwnPaceAndAddsTheRestHere() {
        assertEquals(1f to 1.2f, Quicken.plan(1.2f))
        assertEquals(1f to 1f, Quicken.plan(1f))
        // Slower than the model's own pace is the model's job: Japanese at 0.8.
        assertEquals(0.8f to 1f, Quicken.plan(0.8f))
    }

    @Test fun aLineIsShorterByTheSpeedAsked() {
        val x = voiced()
        val y = Quicken.faster(x, rate, 1.2f)
        assertEquals(1.2, x.size.toDouble() / y.size, 0.02)
    }

    @Test fun theEndOfTheLineIsUntouched() {
        val x = voiced()
        val y = Quicken.faster(x, rate, 1.2f)
        val tail = rate * 30 / 1000
        assertArrayEquals(x.copyOfRange(x.size - tail, x.size), y.copyOfRange(y.size - tail, y.size), 0f)
    }

    @Test fun theStartOfTheLineIsUntouched() {
        val x = voiced()
        val y = Quicken.faster(x, rate, 1.2f)
        val head = rate * 10 / 1000
        assertArrayEquals(x.copyOfRange(0, head), y.copyOfRange(0, head), 0f)
    }

    @Test fun itIsNoLouderAndHasNoClicks() {
        val x = voiced()
        val y = Quicken.faster(x, rate, 1.2f)
        assertTrue(y.maxOf { abs(it) } <= x.maxOf { abs(it) } * 1.05f)
        // The biggest jump between two samples of the input, with a little room: a bad join would
        // show as a jump many times that.
        val jump = (1 until x.size).maxOf { abs(x[it] - x[it - 1]) }
        assertTrue((1 until y.size).maxOf { abs(y[it] - y[it - 1]) } <= jump * 1.5f)
    }

    @Test fun aQuietStretchStaysQuietAndALoudOneLoud() {
        // Half a second of sound, half of nothing, half of sound: the gap is still there.
        val x = voiced(1.5)
        for (i in rate / 2 until rate) x[i] = 0f
        val y = Quicken.faster(x, rate, 1.2f)
        val mid = (rate * 0.75 / 1.2).toInt()
        assertTrue((mid - 2000 until mid + 2000).all { abs(y[it]) < 0.01f })
        assertTrue(y.copyOfRange(0, 8000).maxOf { abs(it) } > 0.2f)
        assertTrue(y.copyOfRange(y.size - 8000, y.size).maxOf { abs(it) } > 0.2f)
    }

    @Test fun normalSpeedAndATinyLineComeBackAsTheyWere() {
        val x = voiced()
        assertSame(x, Quicken.faster(x, rate, 1f))
        val tiny = voiced(0.04)
        assertSame(tiny, Quicken.faster(tiny, rate, 1.2f))
    }

    @Test fun otherRatesWork() {
        val x = FloatArray(16000 * 2) { (0.4 * sin(2 * PI * 180 * it / 16000)).toFloat() }
        val y = Quicken.faster(x, 16000, 1.35f)
        assertEquals(1.35, x.size.toDouble() / y.size, 0.03)
    }
}
