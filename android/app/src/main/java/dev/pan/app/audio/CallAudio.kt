package dev.pan.app.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import dev.pan.app.network.PanServerClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.InputStream
import kotlin.math.sqrt

/**
 * The voice itself in a call with someone on this ΠAN (the owner, 2026-11-19: a call should be a
 * call, both hear each other). The hub's side is call-voice.js.
 *
 * Out: the microphone loop (SherpaStreamingStt) hands every window it reads to feed(). The same
 * sound still goes to ΠAN's own listening, so "ΠAN, ..." works in a call. While someone is
 * talking it is sent to the hub in pieces of about a tenth of a second: 16 kHz, one channel,
 * mu-law. Silence is not sent.
 *
 * In: one stream held open to the hub. Each piece on it says who it is from and is played at
 * once, one player per person, so a group call mixes by itself. It plays as a phone call does
 * (voice call audio, loudspeaker), which is what lets the phone's echo canceller take it out of
 * the microphone again.
 *
 * Nothing is kept on the phone or on the hub. When the sound cannot get through, the call still
 * works the old way: the hub has the other device read the written lines out.
 */
object CallAudio {
    private const val RATE = 16_000
    private const val PIECE_BYTES = 1536            // about 96 ms: three microphone windows
    private const val MAX_WAITING = 16_000          // one second; older sound is dropped, not sent late
    private const val OPEN_RMS = 0.006f             // louder than this is someone talking
    private const val HOLD_MS = 700L                // keep sending this long after the last loud window
    private const val LEAD_WINDOWS = 3              // the windows just before the voice, so its start is not cut

    @Volatile var active = false
        private set

    /** For a test of the whole path with nobody listening: what arrives is counted and not played. */
    @Volatile var quiet = false

    private var job: Job? = null
    private val out = ByteArrayOutputStream()
    private val lead = ArrayDeque<ByteArray>()
    @Volatile private var loudAt = 0L
    @Volatile private var sentPieces = 0
    @Volatile private var gotPieces = 0
    private var log: (String) -> Unit = {}
    @Volatile private var open: okhttp3.Response? = null

    /** For the log and the tests: pieces sent and received in this call. */
    fun counts(): Pair<Int, Int> = sentPieces to gotPieces

    /** From the microphone loop: one window of what it just read. Cheap when no call is on. */
    fun feed(shorts: ShortArray, n: Int) {
        if (!active || n <= 0) return
        var sum = 0.0
        val bytes = ByteArray(n)
        for (i in 0 until n) {
            val s = shorts[i].toInt()
            sum += (s * s).toDouble()
            bytes[i] = muLaw(s)
        }
        val rms = (sqrt(sum / n) / 32768.0).toFloat()
        val now = android.os.SystemClock.elapsedRealtime()
        if (rms >= OPEN_RMS) loudAt = now
        synchronized(out) {
            if (now - loudAt <= HOLD_MS) {
                // The voice just began: the windows before it go first.
                while (lead.isNotEmpty()) out.write(lead.removeFirst())
                out.write(bytes)
                if (out.size() > MAX_WAITING) {
                    val all = out.toByteArray()
                    out.reset()
                    out.write(all, all.size - MAX_WAITING / 2, MAX_WAITING / 2)
                }
            } else {
                lead.addLast(bytes)
                while (lead.size > LEAD_WINDOWS) lead.removeFirst()
            }
        }
    }

    fun start(scope: CoroutineScope, client: PanServerClient, audioManager: AudioManager, logger: (String) -> Unit) {
        if (active) return
        active = true
        log = logger
        sentPieces = 0; gotPieces = 0; loudAt = 0L
        synchronized(out) { out.reset(); lead.clear() }
        // As a phone call on the loudspeaker: the echo canceller gets what the speaker plays.
        runCatching {
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = true
        }
        log("Call voice: on")
        job = scope.launch(Dispatchers.IO) {
            launch { sendLoop(client) }
            listenLoop(client)
        }
    }

    fun stop(audioManager: AudioManager?, pan_is_speaking: Boolean = false) {
        if (!active) return
        active = false
        job?.cancel()
        job = null
        // A read waiting on the stream ends now, not at the hub's next piece.
        val was = open
        open = null
        if (was != null) Thread { runCatching { was.close() } }.start()
        synchronized(out) { out.reset(); lead.clear() }
        if (!pan_is_speaking) runCatching { audioManager?.mode = AudioManager.MODE_NORMAL }
        log("Call voice: off (sent $sentPieces pieces, got $gotPieces)")
    }

    private suspend fun CoroutineScope.sendLoop(client: PanServerClient) {
        var lastSend = 0L
        var failures = 0
        while (isActive && active) {
            val now = android.os.SystemClock.elapsedRealtime()
            val piece: ByteArray? = synchronized(out) {
                val n = out.size()
                // A full piece, or the tail of what was said once it has waited a little.
                if (n >= PIECE_BYTES || (n > 0 && now - lastSend > 150)) out.toByteArray().also { out.reset() } else null
            }
            if (piece == null) { delay(20); continue }
            lastSend = now
            val code = client.voiceSend(piece)
            when {
                code == 200 -> { sentPieces++; failures = 0 }
                // Not on a call any more, or another of this person's devices carries it: wait for the hub to say.
                code == 409 -> delay(1000)
                else -> { if (failures++ % 50 == 0) log("Call voice: a piece did not go out ($code)"); delay(100) }
            }
        }
    }

    private suspend fun CoroutineScope.listenLoop(client: PanServerClient) {
        val players = HashMap<Int, Player>()
        try {
            while (isActive && active) {
                val response = client.voiceStream()
                if (response == null || response.code != 200) {
                    response?.close()
                    delay(if (response?.code == 409) 1000 else 500)
                    continue
                }
                open = response
                try {
                    val input = response.body?.byteStream() ?: continue
                    val head = ByteArray(6)
                    while (isActive && active) {
                        readFully(input, head, 6)
                        val from = (head[0].toInt() and 0xff) or ((head[1].toInt() and 0xff) shl 8) or
                            ((head[2].toInt() and 0xff) shl 16) or ((head[3].toInt() and 0xff) shl 24)
                        val n = (head[4].toInt() and 0xff) or ((head[5].toInt() and 0xff) shl 8)
                        if (n == 0) continue                      // only keeps the stream open
                        val sound = ByteArray(n)
                        readFully(input, sound, n)
                        if (gotPieces++ == 0) log("Call voice: hearing person $from")
                        if (!quiet) players.getOrPut(from) { Player() }.play(sound)
                    }
                } catch (_: EOFException) {
                    // The hub closed it: the call ended, or it swapped. Look again.
                } catch (e: Exception) {
                    if (isActive && active) log("Call voice: the stream broke (${e.message})")
                } finally {
                    if (open === response) open = null
                    runCatching { response.close() }
                }
                delay(300)
            }
        } finally {
            players.values.forEach { it.release() }
        }
    }

    private fun readFully(input: InputStream, into: ByteArray, n: Int) {
        var got = 0
        while (got < n) {
            val r = input.read(into, got, n - got)
            if (r < 0) throw EOFException()
            got += r
        }
    }

    /** One person's voice. Its own track, so two people talking at once are mixed by the phone. */
    private class Player {
        private val track: AudioTrack
        private var lastAt = 0L

        init {
            val min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            track = AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(maxOf(min, RATE * 2))      // one second: late pieces queue, they do not block
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            track.play()
        }

        fun play(sound: ByteArray) {
            val now = android.os.SystemClock.elapsedRealtime()
            // After a silence, a short lead of quiet first: the pieces that follow then arrive
            // before the one playing runs out, and the voice does not stutter.
            if (now - lastAt > 300) track.write(ShortArray(RATE * 80 / 1000), 0, RATE * 80 / 1000, AudioTrack.WRITE_NON_BLOCKING)
            lastAt = now
            val pcm = ShortArray(sound.size) { LINEAR[sound[it].toInt() and 0xff] }
            track.write(pcm, 0, pcm.size, AudioTrack.WRITE_NON_BLOCKING)
        }

        fun release() { runCatching { track.stop() }; runCatching { track.release() } }
    }

    // ── mu-law (G.711), on 16-bit samples ───────────────────────────────────────────────────
    private const val BIAS = 0x84
    private const val CLIP = 32635

    private fun muLaw(sample: Int): Byte {
        var s = sample
        val sign = if (s < 0) { s = -s; 0x80 } else 0
        if (s > CLIP) s = CLIP
        s += BIAS
        var exponent = 7
        var mask = 0x4000
        while (exponent > 0 && (s and mask) == 0) { exponent--; mask = mask shr 1 }
        val mantissa = (s shr (exponent + 3)) and 0x0f
        return (sign or (exponent shl 4) or mantissa).inv().toByte()
    }

    private val LINEAR = ShortArray(256) { i ->
        val u = i.inv() and 0xff
        val sign = u and 0x80
        val exponent = (u shr 4) and 0x07
        val mantissa = u and 0x0f
        val magnitude = (((mantissa shl 3) + BIAS) shl exponent) - BIAS
        (if (sign != 0) -magnitude else magnitude).toShort()
    }
}
