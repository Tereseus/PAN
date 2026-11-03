package dev.pan.app.debug

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Recorded speech in place of the microphone, for the conversation benchmark
 * (service/src/evals/voicebench). Debug builds only.
 *
 * TEST_SAY injects TEXT, so it skips everything the complaints are about: the
 * VAD, the recogniser, Smart Turn, the echo filter and barge-in. This injects
 * AUDIO at the one place the microphone enters the app. SherpaStreamingStt's
 * read loop still reads the real AudioRecord, which keeps real-time pacing, and
 * then hands the samples to fill(), which overwrites them with the next part of
 * the queued clip. Everything after that runs exactly as it does for him.
 *
 * While a session is active the microphone is replaced by silence between clips,
 * so room noise cannot change a run, and nothing the run says is persisted
 * (DataRepository, history sync, and bench:true on the hub query).
 */
object TestAudio {
    @Volatile var active = false
        private set

    private val lock = Any()
    private val clips = ArrayDeque<Pair<String, ShortArray>>()
    private var current: Pair<String, ShortArray>? = null
    private var pos = 0
    @Volatile private var lastActivity = 0L

    fun enqueue(id: String, pcm: ShortArray) {
        synchronized(lock) { clips.addLast(id to pcm) }
        lastActivity = android.os.SystemClock.elapsedRealtime()
        active = true
    }

    /**
     * How long the session has had nothing to play: no clip queued or playing since the last
     * one ended. The service ends a session idle this long, because a run that dies (the USB
     * cable came out mid-run, 2026-11-03) never sends TEST_AUDIO_END and left the microphone
     * replaced by silence: PAN could not hear him at all.
     */
    fun idleMs(): Long = synchronized(lock) {
        if (current != null || clips.isNotEmpty()) 0L
        else android.os.SystemClock.elapsedRealtime() - lastActivity
    }

    /** Ends the session: drops anything still queued and gives the microphone back. */
    fun end() {
        synchronized(lock) {
            clips.clear()
            current = null
            pos = 0
        }
        active = false
    }

    /**
     * Called by the read loop with the n samples it just read. Overwrites them
     * with injected audio, or silence between clips, while a session is active.
     */
    fun fill(buf: ShortArray, n: Int) {
        if (!active) return
        synchronized(lock) {
            var i = 0
            while (i < n) {
                val c = current ?: clips.removeFirstOrNull()?.also {
                    current = it
                    pos = 0
                    VoiceEvents.emit("inject_start", "clip" to it.first, "samples" to it.second.size)
                }
                if (c == null) {
                    buf.fill(0.toShort(), i, n)
                    break
                }
                val take = minOf(n - i, c.second.size - pos)
                System.arraycopy(c.second, pos, buf, i, take)
                pos += take
                i += take
                if (pos >= c.second.size) {
                    VoiceEvents.emit("inject_end", "clip" to c.first)
                    current = null
                    lastActivity = android.os.SystemClock.elapsedRealtime()
                }
            }
        }
    }

    /** 16 kHz mono PCM16 WAV only, which is exactly what the benchmark writes. */
    fun readWav(file: File): ShortArray {
        val bytes = file.readBytes()
        require(bytes.size > 12 && String(bytes, 0, 4) == "RIFF" && String(bytes, 8, 4) == "WAVE") { "not a WAV file" }
        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        var channels = 0
        var rate = 0
        var bits = 0
        var off = 12
        while (off + 8 <= bytes.size) {
            val id = String(bytes, off, 4)
            val len = bb.getInt(off + 4)
            if (id == "fmt ") {
                channels = bb.getShort(off + 10).toInt()
                rate = bb.getInt(off + 12)
                bits = bb.getShort(off + 22).toInt()
            } else if (id == "data") {
                require(channels == 1 && rate == 16000 && bits == 16) {
                    "need 16 kHz mono PCM16, got ${rate}Hz ${channels}ch ${bits}bit"
                }
                val count = minOf(len, bytes.size - off - 8) / 2
                val out = ShortArray(count)
                for (k in 0 until count) out[k] = bb.getShort(off + 8 + k * 2)
                return out
            }
            off += 8 + len + (len and 1)
        }
        error("WAV has no data chunk")
    }
}
