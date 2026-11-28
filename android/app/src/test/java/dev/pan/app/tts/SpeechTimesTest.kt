package dev.pan.app.tts

import org.junit.Assert.assertEquals
import org.junit.Test

class SpeechTimesTest {
    private fun piece(q: Long, bf: Long, b: Long, p: Long, e: Long, audio: Long = e - p) =
        PiperTtsEngine.Piece(q, 40).apply { builtFrom = bf; built = b; play = p; end = e; audioMs = audio }

    @Test fun timesAreFromTheFirstPiece() {
        val rows = SpeechTimes.rows(listOf(piece(1000, 1000, 1400, 1450, 3450), piece(1300, 1400, 2200, 3460, 5000)))
        assertEquals(0L, rows[0].queued)
        assertEquals(450L, rows[0].play)
        assertEquals(300L, rows[1].queued)
        assertEquals(2460L, rows[1].play)
        assertEquals(listOf(10L), SpeechTimes.gaps(rows))
    }

    @Test fun aPieceNeverPlayedIsLeftOut() {
        val never = PiperTtsEngine.Piece(1200, 10)
        val rows = SpeechTimes.rows(listOf(piece(1000, 1000, 1400, 1450, 2000), never))
        assertEquals(1, rows.size)
        assertEquals(emptyList<Long>(), SpeechTimes.gaps(rows))
    }

    @Test fun piecesAreInTheOrderHandedIn() {
        val rows = SpeechTimes.rows(listOf(piece(2000, 2100, 2600, 4000, 5000), piece(1000, 1000, 1500, 1600, 3900)))
        assertEquals(0L, rows[0].queued)
        assertEquals(listOf(100L), SpeechTimes.gaps(rows))
    }

    @Test fun nothingPlayedIsEmpty() {
        assertEquals(emptyList<SpeechTimes.Row>(), SpeechTimes.rows(emptyList()))
    }
}
