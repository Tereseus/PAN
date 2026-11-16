package dev.pan.app.stt

import android.content.Context
import android.util.Log
import org.tensorflow.lite.Interpreter
import java.io.File
import java.util.concurrent.Executors

/**
 * Is there music in the room? YAMNet (Google, Apache 2.0, 4 MB, assets/yamnet.tflite) labels each
 * second of sound with 521 AudioSet classes. The owner, Nov 15: in a bar PAN has to know the lyrics are
 * music, not him. The phone already knows when its own apps play music (isMusicActive); this is
 * for music it does not play: a bar, a car radio, another phone. On the OnePlus Pad bench, lyrics
 * from the laptop's speakers were answered as if he had said them.
 *
 * It runs beside the recogniser on its own thread, about twice a second on the last 0.975 s of
 * the mic, so it adds nothing to the reply time. The service asks [heardMusic] when a line is sent,
 * and the hub then answers only lines that name PAN or follow the assistant button (music_playing).
 */
class MusicDetector private constructor(context: Context) {

    private val interp: Interpreter? = try {
        val f = File(context.filesDir, "yamnet.tflite")
        if (!f.exists() || f.length() == 0L) {
            context.assets.open("yamnet.tflite").use { i -> f.outputStream().use { o -> i.copyTo(o) } }
        }
        Interpreter(f, Interpreter.Options().setNumThreads(1))
    } catch (e: Throwable) {
        Log.w(TAG, "YAMNet unavailable: ${e.message}")
        null
    }
    private val inShape = interp?.getInputTensor(0)?.shape() ?: intArrayOf(WINDOW)
    private val need = inShape.fold(1) { a, b -> a * b }
    private val outShape = interp?.getOutputTensor(0)?.shape() ?: intArrayOf(1, 521)

    private val ring = FloatArray(need)
    private var pos = 0
    private var filled = 0
    private var sinceRun = 0
    @Volatile private var busy = false
    private val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "yamnet").apply { priority = Thread.MIN_PRIORITY } }

    // (time, music odds) for the last few seconds
    private val recent = ArrayDeque<Pair<Long, Float>>()

    /** Last measured odds that the room holds music, for the log. */
    @Volatile var last = 0f
        private set
    private var wasOn = false
    private var readings = 0

    init { Log.i(TAG, if (interp != null) "YAMNet loaded, input ${inShape.joinToString("x")}, output ${outShape.joinToString("x")}" else "YAMNet not loaded") }

    // A second, raw mic stream. The recogniser's VOICE_COMMUNICATION path suppresses noise, and
    // that removes music: on the OnePlus Pad a song from the Mint's speakers read as "music 0.00,
    // speech 0.92" (Nov 15). Android 10+ lets one app record twice; if this phone refuses, YAMNet
    // falls back to the recogniser's audio (feed), which still catches the phone's own music.
    @Volatile private var raw: android.media.AudioRecord? = null
    @Volatile private var rawLive = false
    private var rawThread: Thread? = null

    @android.annotation.SuppressLint("MissingPermission")
    @Synchronized
    fun startRaw() {
        if (interp == null || raw != null) return
        val src = android.media.MediaRecorder.AudioSource.UNPROCESSED
        val min = android.media.AudioRecord.getMinBufferSize(16_000, android.media.AudioFormat.CHANNEL_IN_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT)
        val r = try {
            android.media.AudioRecord(src, 16_000, android.media.AudioFormat.CHANNEL_IN_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT, maxOf(min * 4, 32_000))
        } catch (e: Throwable) { Log.w(TAG, "raw mic refused: ${e.message}"); return }
        if (r.state != android.media.AudioRecord.STATE_INITIALIZED) { Log.w(TAG, "raw mic not initialised"); r.release(); return }
        try { r.startRecording() } catch (e: Throwable) { Log.w(TAG, "raw mic start failed: ${e.message}"); r.release(); return }
        raw = r
        rawThread = Thread({
            val buf = ShortArray(1_600)
            var level = 0.0; var n = 0
            while (raw === r) {
                val k = try { r.read(buf, 0, buf.size) } catch (_: Throwable) { -1 }
                if (k <= 0) { if (k < 0) break; continue }
                dev.pan.app.debug.AecDump.raw(buf, k)
                val f = FloatArray(k) { buf[it] / 32768f }
                for (x in f) level += x * x
                n += k
                if (n >= 16_000 * 5) { Log.d(TAG, "raw mic level %.4f".format(Math.sqrt(level / n))); level = 0.0; n = 0 }
                rawLive = true
                push(f)
            }
            rawLive = false
        }, "yamnet-mic").apply { priority = Thread.MIN_PRIORITY; start() }
        Log.i(TAG, "raw mic stream on (UNPROCESSED)")
    }

    @Synchronized
    fun stopRaw() {
        val r = raw ?: return
        raw = null
        runCatching { r.stop() }
        runCatching { rawThread?.join(500) }
        runCatching { r.release() }
        rawLive = false
        Log.i(TAG, "raw mic stream off")
    }

    /** Mic audio at 16 kHz from the recogniser, used only when the raw stream is not running. */
    fun feed(frame: FloatArray) {
        if (interp == null || rawLive) return
        push(frame)
    }

    private fun push(frame: FloatArray) {
        val snap: FloatArray?
        synchronized(this) {
            for (x in frame) { ring[pos] = x; pos = (pos + 1) % need }
            filled = minOf(need, filled + frame.size)
            sinceRun += frame.size
            snap = if (filled >= need && sinceRun >= HOP && !busy) {
                sinceRun = 0
                FloatArray(need) { i -> ring[(pos + i) % need] }
            } else null
        }
        if (snap != null) {
            busy = true
            exec.execute { try { classify(snap) } catch (e: Throwable) { Log.w(TAG, "classify: ${e.message}") } finally { busy = false } }
        }
    }

    private fun classify(x: FloatArray) {
        val ip = interp ?: return
        val input: Any = if (inShape.size == 1) x else arrayOf(x)
        val scores: FloatArray
        if (outShape.size == 1) {
            scores = FloatArray(outShape[0]); ip.run(input, scores)
        } else {
            val out = Array(outShape[0]) { FloatArray(outShape[1]) }; ip.run(input, out); scores = out[0]
        }
        val music = MUSIC.maxOf { if (it < scores.size) scores[it] else 0f }
        last = music
        if (++readings % 6 == 0) {
            val top = scores.indices.maxBy { scores[it] }
            Log.d(TAG, "music %.2f speech %.2f top #%d %.2f".format(music, scores[0], top, scores[top]))
        }
        val on = music >= MUSIC_ODDS
        if (on != wasOn) { wasOn = on; Log.i(TAG, if (on) "music started (%.2f)".format(music) else "music stopped (%.2f)".format(music)) }
        val now = System.currentTimeMillis()
        synchronized(recent) {
            recent.addLast(now to music)
            while (recent.isNotEmpty() && now - recent.first().first > KEEP_MS) recent.removeFirst()
        }
    }

    /**
     * Music in the room lately: two or more readings at [MUSIC_ODDS] or above in the last [ms].
     * A song's quiet parts read as speech or silence, and on the Pad bench (Nov 15) "most of the
     * last 4 s" let lines between the loud parts through, so one loud stretch counts for a while.
     */
    fun heardMusic(ms: Long = 12_000L): Boolean {
        val now = System.currentTimeMillis()
        val r = synchronized(recent) { recent.filter { now - it.first <= ms } }
        return r.count { it.second >= MUSIC_ODDS } >= 2
    }

    companion object {
        private const val TAG = "MusicDetector"
        private const val WINDOW = 15_600          // 0.975 s at 16 kHz, YAMNet's patch
        private const val HOP = 8_000              // a reading every 0.5 s
        private const val KEEP_MS = 15_000L
        const val MUSIC_ODDS = 0.3f
        // AudioSet classes: Music, Singing, Rapping, Vocal music, Song (yamnet_class_map.csv).
        private val MUSIC = intArrayOf(132, 24, 31, 249, 261)

        @Volatile private var instance: MusicDetector? = null
        fun get(context: Context): MusicDetector =
            instance ?: synchronized(this) { instance ?: MusicDetector(context.applicationContext).also { instance = it } }
    }
}
