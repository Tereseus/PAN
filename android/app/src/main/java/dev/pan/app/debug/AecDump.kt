package dev.pan.app.debug

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Debug (TEST_AEC_DUMP): record, at the same time, the raw mic, the mic as the recogniser gets
 * it after Android's call processing, and every line PAN plays, each with the clock time it
 * started. For trying echo cancellers on a recording, off the phone, before one is built in:
 * Android's own canceller chews a word said over PAN ("stop" read as "WELL", 2026-11-15), so
 * PAN has to take its own voice out of the raw mic itself.
 *
 * While it runs, PAN is neither held nor stopped by sound over it (the point is to record both
 * voices at once). Files land in the app's external files folder, aecdump/.
 */
object AecDump {
    @Volatile var active = false
        private set
    private val lock = Any()
    private var raw = ByteArrayOutputStream()
    private var proc = ByteArrayOutputStream()
    private var rawT0 = 0L
    private var procT0 = 0L
    private class Ref(val at: Long, val rate: Int, val pcm: ShortArray)
    private val refs = ArrayList<Ref>()

    fun start() = synchronized(lock) {
        raw = ByteArrayOutputStream(); proc = ByteArrayOutputStream()
        rawT0 = 0L; procT0 = 0L
        refs.clear()
        active = true
    }

    /** Raw mic, 16 kHz, as read (MusicDetector's UNPROCESSED stream). */
    fun raw(buf: ShortArray, n: Int) {
        if (!active || n <= 0) return
        synchronized(lock) {
            if (rawT0 == 0L) rawT0 = System.nanoTime() - n * 1_000_000_000L / 16_000
            val b = ByteBuffer.allocate(n * 2).order(ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until n) b.putShort(buf[i])
            raw.write(b.array())
        }
    }

    /** The recogniser's mic, 16 kHz, after the call path. */
    fun proc(frame: FloatArray) {
        if (!active) return
        synchronized(lock) {
            if (procT0 == 0L) procT0 = System.nanoTime() - frame.size * 1_000_000_000L / 16_000
            val b = ByteBuffer.allocate(frame.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            for (v in frame) b.putShort((v.coerceIn(-1f, 1f) * 32767f).toInt().toShort())
            proc.write(b.array())
        }
    }

    /** A line handed to the speaker now. */
    fun ref(pcm: ShortArray, rate: Int) {
        if (!active) return
        synchronized(lock) { refs.add(Ref(System.nanoTime(), rate, pcm.copyOf())) }
    }

    fun stop(dir: File): String = synchronized(lock) {
        if (!active) return "not running"
        active = false
        dir.mkdirs()
        dir.listFiles()?.forEach { it.delete() }
        wav(File(dir, "raw.wav"), raw.toByteArray(), 16_000)
        wav(File(dir, "proc.wav"), proc.toByteArray(), 16_000)
        val meta = StringBuilder("{\"raw_t0\":$rawT0,\"proc_t0\":$procT0,\"refs\":[")
        refs.forEachIndexed { i, r ->
            val b = ByteBuffer.allocate(r.pcm.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            for (s in r.pcm) b.putShort(s)
            wav(File(dir, "ref_$i.wav"), b.array(), r.rate)
            if (i > 0) meta.append(',')
            meta.append("{\"i\":$i,\"at\":${r.at},\"rate\":${r.rate},\"samples\":${r.pcm.size}}")
        }
        meta.append("]}")
        File(dir, "meta.json").writeText(meta.toString())
        val out = "${dir.absolutePath}: raw ${raw.size() / 32_000} s, proc ${proc.size() / 32_000} s, ${refs.size} lines"
        raw = ByteArrayOutputStream(); proc = ByteArrayOutputStream(); refs.clear()
        out
    }

    private fun wav(f: File, pcm: ByteArray, rate: Int) {
        RandomAccessFile(f, "rw").use { o ->
            o.setLength(0)
            val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            h.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVE".toByteArray())
            h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2)
                .putShort(2).putShort(16)
            h.put("data".toByteArray()).putInt(pcm.size)
            o.write(h.array())
            o.write(pcm)
        }
    }
}
