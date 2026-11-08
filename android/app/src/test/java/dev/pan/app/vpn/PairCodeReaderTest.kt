package dev.pan.app.vpn

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pairing scanner's decoding, on frames shaped like CameraX's: a brightness plane
 * with padded rows, a short last row, the code turned sideways (the sensor's
 * orientation) and not filling the frame.
 */
class PairCodeReaderTest {

    private val code = "pan://pair?a=10.77.0.2&e=192.168.50.20%3A41720&g=10.77.0.1" +
        "&h=TESTpairKEYonlyForThisTestXXXXXXXXXXXXXXXXX&k=TESThubPUBLICkeyOnlyForThisTestYYYYYYYYYYYY" +
        "&n=PAN+hub&v=1&x=1794139304"

    /** A grey frame with [text] as a QR, [scale] pixels a module, turned 90 degrees. */
    private fun frame(text: String?, width: Int = 640, height: Int = 480, stride: Int = 704, scale: Int = 3): ByteArray {
        val y = ByteArray(stride * (height - 1) + width) { 0x70 } // short last row, like CameraX
        if (text == null) return y
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, mapOf(EncodeHintType.MARGIN to 4))
        val size = m.width * scale
        val left = (width - size) / 2
        val top = (height - size) / 2
        for (r in 0 until size) for (c in 0 until size) {
            // Turned: the frame's (r, c) shows the code's (c, size-1-r).
            val dark = m.get(c / scale, (size - 1 - r) / scale)
            y[(top + r) * stride + left + c] = if (dark) 0x10 else 0xE0.toByte()
        }
        return y
    }

    @Test fun readsAPairingCodeFromAPaddedSidewaysFrame() {
        assertEquals(code, PairCodeReader().read(frame(code), 704, 640, 480))
    }

    @Test fun aFrameWithoutACodeGivesNothing() {
        assertNull(PairCodeReader().read(frame(null), 704, 640, 480))
    }

    @Test fun keepsReadingAfterAMiss() {
        val r = PairCodeReader()
        assertNull(r.read(frame(null), 704, 640, 480))
        assertEquals(code, r.read(frame(code), 704, 640, 480))
    }

    @Test fun onlyPanPairingLinksCount() {
        assertTrue(PairCodeReader.isPairCode(code))
        assertFalse(PairCodeReader.isPairCode("https://example.com/pair"))
        assertFalse(PairCodeReader.isPairCode("pan://pairing-is-not-this"))
        assertFalse(PairCodeReader.isPairCode("PAN://PAIR?a=1"))
    }
}
