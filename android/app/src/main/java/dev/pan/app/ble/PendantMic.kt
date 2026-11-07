package dev.pan.app.ble

import android.os.SystemClock
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile

/**
 * The pendant's microphone, as it arrives over Bluetooth: 20 ms packets of IMA ADPCM (the firmware
 * header in firmware/pendant/xiao_cam_ble.ino has the layout). Each packet carries its own decoder
 * state, so a lost one costs 20 ms of quiet and nothing after it.
 *
 * While [live], fill() replaces what the phone's own mic heard, the same way bench audio does in
 * SherpaStreamingStt, so everything after that point runs exactly as it does for the phone's mic.
 */
object PendantMic {
    private const val TAG = "PendantMic"
    private const val SAMPLE_RATE = 16000
    private const val FRAME = 320
    // Anything queued past this is old speech: drop it rather than fall further behind.
    private const val MAX_QUEUED = FRAME * 25

    private val STEPS = intArrayOf(
        7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
        80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
        544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
        2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
        12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767)
    private val NEXT = intArrayOf(-1, -1, -1, -1, 2, 4, 6, 8)

    /** The pendant's mic is what PAN hears. */
    @Volatile var live = false

    private val lock = Any()
    private val queue = ShortArray(MAX_QUEUED)
    private var head = 0
    private var queued = 0
    private var lastSeq = -1
    private var received = 0
    private var lost = 0
    private var dropped = 0
    private var lastAt = 0L
    private var worstGap = 0L
    private var recording: ByteArrayOutputStream? = null

    fun decode(pkt: ByteArray): ShortArray? {
        if (pkt.size < 6 + FRAME / 2) return null
        var pred = ((pkt[2].toInt() shl 8) or (pkt[3].toInt() and 0xFF)).toShort().toInt()
        var idx = (pkt[4].toInt() and 0xFF).coerceIn(0, 88)
        val out = ShortArray(FRAME)
        for (i in 0 until FRAME) {
            val byte = pkt[6 + i / 2].toInt() and 0xFF
            val code = if (i % 2 == 0) byte and 0x0F else byte shr 4
            val step = STEPS[idx]
            var delta = step shr 3
            if (code and 4 != 0) delta += step
            if (code and 2 != 0) delta += step shr 1
            if (code and 1 != 0) delta += step shr 2
            pred = (if (code and 8 != 0) pred - delta else pred + delta).coerceIn(-32768, 32767)
            idx = (idx + NEXT[code and 7]).coerceIn(0, 88)
            out[i] = pred.toShort()
        }
        return out
    }

    private fun push(pcm: ShortArray) {
        recording?.let { r -> for (s in pcm) { r.write(s.toInt() and 0xFF); r.write((s.toInt() shr 8) and 0xFF) } }
        if (!live) return
        for (s in pcm) {
            if (queued == MAX_QUEUED) { head = (head + 1) % MAX_QUEUED; queued--; dropped++ }
            queue[(head + queued) % MAX_QUEUED] = s
            queued++
        }
    }

    /** A packet from the pendant. Notifications land on a pool of binder threads. */
    fun onPacket(pkt: ByteArray) {
        val pcm = decode(pkt) ?: return
        val seq = ((pkt[0].toInt() and 0xFF) shl 8) or (pkt[1].toInt() and 0xFF)
        synchronized(lock) {
            val now = SystemClock.elapsedRealtime()
            if (lastAt > 0L) worstGap = maxOf(worstGap, now - lastAt)
            lastAt = now
            if (lastSeq >= 0) {
                val missed = ((seq - lastSeq - 1) and 0xFFFF).let { if (it > 500) 0 else it }
                lost += missed
                val quiet = ShortArray(FRAME)
                repeat(missed) { push(quiet) }
            }
            lastSeq = seq
            received++
            push(pcm)
        }
    }

    /** Replace what the phone's mic read with what the pendant sent. Short of speech is quiet. */
    fun fill(buf: ShortArray, n: Int) {
        synchronized(lock) {
            for (i in 0 until n) {
                if (queued > 0) {
                    buf[i] = queue[head]
                    head = (head + 1) % MAX_QUEUED
                    queued--
                } else buf[i] = 0
            }
        }
    }

    fun reset() = synchronized(lock) {
        head = 0; queued = 0; lastSeq = -1; received = 0; lost = 0; dropped = 0; lastAt = 0L; worstGap = 0L
    }

    fun startRecording() = synchronized(lock) { reset(); recording = ByteArrayOutputStream() }

    /** Stop recording, write the WAV, and log what the link did. */
    fun stopRecording(to: File) {
        val pcm = synchronized(lock) { recording?.toByteArray().also { recording = null } } ?: return
        RandomAccessFile(to, "rw").use { f ->
            f.setLength(0)
            fun le(v: Int, bytes: Int) { for (i in 0 until bytes) f.write((v shr (8 * i)) and 0xFF) }
            f.writeBytes("RIFF"); le(36 + pcm.size, 4); f.writeBytes("WAVEfmt "); le(16, 4); le(1, 2); le(1, 2)
            le(SAMPLE_RATE, 4); le(SAMPLE_RATE * 2, 4); le(2, 2); le(16, 2); f.writeBytes("data"); le(pcm.size, 4)
            f.write(pcm)
        }
        Log.i(TAG, "MIC received=$received lost=$lost worst_gap_ms=$worstGap seconds=${pcm.size / 2 / SAMPLE_RATE} file=${to.name}")
    }
}
