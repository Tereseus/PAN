package dev.pan.app.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaFormat
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
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The voice itself in a call with someone on this ΠAN (the owner, 2026-11-19: a call should be a
 * call, both hear each other). The hub's side is call-voice.js.
 *
 * Out: the microphone loop (SherpaStreamingStt) hands every window it reads to feed(). The same
 * sound still goes to ΠAN's own listening, so "ΠAN, ..." works in a call. While someone is
 * talking it is sent to the hub in pieces. Silence is not sent.
 *
 * The sound is Opus at 16 kHz, about 2 kB a second, in pieces of a fifth of a second (the owner,
 * the same day: 58 MB an hour is a lot; that was mu-law at 16 kB a second). Android's own
 * encoder and decoder do it, nothing is added to the app. mu-law stays as the way back: a call
 * starts on it, and moves to Opus once the hub says everyone listening can play it. A device
 * whose encoder will not start keeps to mu-law.
 *
 * In: one stream held open to the hub. Each piece on it says who it is from and which kind of
 * sound it is, and is played at once, one player per person, so a group call mixes by itself. It
 * plays as a phone call does (voice call audio, loudspeaker), which is what lets the phone's echo
 * canceller take it out of the microphone again.
 *
 * Nothing is kept on the phone or on the hub. When the sound cannot get through, the call still
 * works the old way: the hub has the other device read the written lines out.
 */
object CallAudio {
    private const val RATE = 16_000
    private const val PIECE_BYTES = 1536            // mu-law: about 96 ms, three microphone windows
    private const val MAX_WAITING = 16_000          // mu-law: one second; older sound is dropped, not sent late
    private const val OPEN_RMS = 0.006f             // louder than this is someone talking
    private const val HOLD_MS = 700L                // keep sending this long after the last loud window
    private const val LEAD_WINDOWS = 3              // the windows just before the voice, so its start is not cut
    private const val OPUS_BITS = 16_000            // bits a second
    private const val OPUS_BATCH = 10               // packets of 20 ms sent as one piece
    private const val OPUS_MAX_WAITING = 100        // two seconds of packets; older ones are dropped
    private const val MULAW = 0
    private const val OPUS = 1

    @Volatile var active = false
        private set

    /** For a test of the whole path with nobody listening: what arrives is counted and not played. */
    @Volatile var quiet = false

    private var job: Job? = null
    private val out = ByteArrayOutputStream()               // mu-law waiting to go
    private val packets = ArrayDeque<ByteArray>()           // Opus packets waiting to go
    private val lead = ArrayDeque<ShortArray>()
    private var encoder: OpusOut? = null                    // guarded by out's lock
    @Volatile private var peersTakeOpus = false
    @Volatile private var loudAt = 0L
    @Volatile private var sentPieces = 0
    @Volatile private var gotPieces = 0
    @Volatile private var sentBytes = 0L
    @Volatile private var gotBytes = 0L
    @Volatile private var sentOpus = 0
    @Volatile private var gotMs = 0L
    private var netAtStart = 0L to 0L
    private var log: (String) -> Unit = {}
    @Volatile private var open: okhttp3.Response? = null

    /** For the log and the tests: pieces sent and received in this call. */
    fun counts(): Pair<Int, Int> = sentPieces to gotPieces

    /** For the log and the tests: the same, with the bytes and how much of it was Opus. */
    fun detail(): String = "sent $sentPieces pieces ($sentOpus Opus, $sentBytes bytes), got $gotPieces ($gotBytes bytes, $gotMs ms of sound)"

    /** From the microphone loop: one window of what it just read. Cheap when no call is on. */
    fun feed(shorts: ShortArray, n: Int) {
        if (!active || n <= 0) return
        var sum = 0.0
        for (i in 0 until n) {
            val s = shorts[i].toInt()
            sum += (s * s).toDouble()
        }
        val rms = (sqrt(sum / n) / 32768.0).toFloat()
        val now = android.os.SystemClock.elapsedRealtime()
        if (rms >= OPEN_RMS) loudAt = now
        synchronized(out) {
            if (now - loudAt <= HOLD_MS) {
                // The voice just began: the windows before it go first.
                while (lead.isNotEmpty()) lead.removeFirst().let { put(it, it.size) }
                put(shorts, n)
            } else {
                lead.addLast(shorts.copyOf(n))
                while (lead.size > LEAD_WINDOWS) lead.removeFirst()
            }
        }
    }

    // Holding out's lock. One window of sound into whichever kind is being sent now.
    private fun put(pcm: ShortArray, n: Int) {
        val enc = encoder
        if (peersTakeOpus && enc != null) {
            try {
                packets.addAll(enc.encode(pcm, n))
                while (packets.size > OPUS_MAX_WAITING) packets.removeFirst()
                return
            } catch (e: Exception) {
                log("Call voice: the Opus encoder stopped (${e.message}); back to mu-law")
                enc.release()
                encoder = null
            }
        }
        for (i in 0 until n) out.write(muLaw(pcm[i].toInt()).toInt())
        if (out.size() > MAX_WAITING) {
            val all = out.toByteArray()
            out.reset()
            out.write(all, all.size - MAX_WAITING / 2, MAX_WAITING / 2)
        }
    }

    fun start(scope: CoroutineScope, client: PanServerClient, audioManager: AudioManager, logger: (String) -> Unit) {
        if (active) return
        log = logger
        sentPieces = 0; gotPieces = 0; sentBytes = 0; gotBytes = 0; sentOpus = 0; gotMs = 0; loudAt = 0L
        peersTakeOpus = false
        netAtStart = net()
        synchronized(out) {
            out.reset(); packets.clear(); lead.clear()
            encoder?.release()
            encoder = runCatching { OpusOut() }.onFailure { log("Call voice: no Opus encoder here (${it.message}); mu-law") }.getOrNull()
        }
        active = true
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
        synchronized(out) { out.reset(); packets.clear(); lead.clear(); encoder?.release(); encoder = null }
        if (!pan_is_speaking) runCatching { audioManager?.mode = AudioManager.MODE_NORMAL }
        // What the whole app sent and received while the call was on: the call's sound and
        // everything around it (the hub's answers, the checks for notes, the log).
        val (up, down) = net()
        log("Call voice: off (${detail()}; the app's network in that time: ${up - netAtStart.first} bytes up, ${down - netAtStart.second} down)")
    }

    private fun net(): Pair<Long, Long> {
        val uid = android.os.Process.myUid()
        return android.net.TrafficStats.getUidTxBytes(uid) to android.net.TrafficStats.getUidRxBytes(uid)
    }

    private suspend fun CoroutineScope.sendLoop(client: PanServerClient) {
        var lastSend = 0L
        var failures = 0
        while (isActive && active) {
            val now = android.os.SystemClock.elapsedRealtime()
            var kind = MULAW
            val piece: ByteArray? = synchronized(out) {
                val n = out.size()
                when {
                    // A full batch, or the tail of what was said once it has waited a little.
                    packets.size >= OPUS_BATCH || (packets.isNotEmpty() && now - lastSend > 260) -> {
                        kind = OPUS
                        val batch = ByteArrayOutputStream()
                        var taken = 0
                        while (packets.isNotEmpty() && taken < OPUS_BATCH * 2) {
                            val p = packets.removeFirst()
                            batch.write(p.size and 0xff); batch.write((p.size shr 8) and 0xff)
                            batch.write(p)
                            taken++
                        }
                        batch.toByteArray()
                    }
                    n >= PIECE_BYTES || (n > 0 && now - lastSend > 150) -> out.toByteArray().also { out.reset() }
                    else -> null
                }
            }
            if (piece == null) { delay(20); continue }
            lastSend = now
            val (code, takeOpus) = client.voiceSend(piece, kind == OPUS)
            when {
                code == 200 || code == 204 -> {
                    sentPieces++; sentBytes += piece.size; failures = 0
                    if (kind == OPUS) sentOpus++
                    if (takeOpus != null && takeOpus != peersTakeOpus) {
                        peersTakeOpus = takeOpus
                        log("Call voice: sending ${if (takeOpus) "Opus" else "mu-law (a device listening cannot play Opus)"}")
                    }
                }
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
                    // [who: 4][which kind: 1][how long: 2], then the sound.
                    val head = ByteArray(7)
                    while (isActive && active) {
                        readFully(input, head, 7)
                        val from = (head[0].toInt() and 0xff) or ((head[1].toInt() and 0xff) shl 8) or
                            ((head[2].toInt() and 0xff) shl 16) or ((head[3].toInt() and 0xff) shl 24)
                        val kind = head[4].toInt() and 0xff
                        val n = (head[5].toInt() and 0xff) or ((head[6].toInt() and 0xff) shl 8)
                        if (n == 0) continue                      // only keeps the stream open
                        val sound = ByteArray(n)
                        readFully(input, sound, n)
                        if (gotPieces++ == 0) log("Call voice: hearing person $from (${if (kind == OPUS) "Opus" else "mu-law"})")
                        gotBytes += n
                        gotMs += players.getOrPut(from) { Player() }.play(kind, sound, quiet)
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
        private var track: AudioTrack? = null
        private var trackRate = 0
        private var lastAt = 0L
        private var opus: OpusIn? = null

        /** Plays a piece (or only decodes it, when [silent]). -> how many ms of sound it held. */
        fun play(kind: Int, sound: ByteArray, silent: Boolean): Int {
            if (kind == OPUS) {
                val dec = opus ?: OpusIn().also { opus = it }
                val pcm = dec.decode(sound)
                if (pcm.isEmpty()) return 0
                if (!silent) write(pcm, dec.rate)
                return pcm.size * 1000 / dec.rate
            }
            val pcm = ShortArray(sound.size) { LINEAR[sound[it].toInt() and 0xff] }
            if (!silent) write(pcm, RATE)
            return pcm.size * 1000 / RATE
        }

        private fun write(pcm: ShortArray, rate: Int) {
            if (track == null || trackRate != rate) {
                track?.let { t -> runCatching { t.stop() }; runCatching { t.release() } }
                val min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
                track = AudioTrack.Builder()
                    .setAudioAttributes(AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(maxOf(min, rate * 2))      // one second: late pieces queue, they do not block
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build().also { it.play() }
                trackRate = rate
                lastAt = 0L
            }
            val t = track ?: return
            val now = android.os.SystemClock.elapsedRealtime()
            // After a silence, a short lead of quiet first: the pieces that follow then arrive
            // before the one playing runs out, and the voice does not stutter.
            if (now - lastAt > 400) {
                val quiet = rate * 120 / 1000
                t.write(ShortArray(quiet), 0, quiet, AudioTrack.WRITE_NON_BLOCKING)
            }
            lastAt = now
            t.write(pcm, 0, pcm.size, AudioTrack.WRITE_NON_BLOCKING)
        }

        fun release() {
            track?.let { t -> runCatching { t.stop() }; runCatching { t.release() } }
            track = null
            opus?.release()
            opus = null
        }
    }

    // ── Opus, by Android's own codecs ───────────────────────────────────────────────────────

    /** 16 kHz sound in, Opus packets of 20 ms out. */
    private class OpusOut {
        private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
        private val info = MediaCodec.BufferInfo()
        private var samples = 0L

        init {
            val f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, RATE, 1)
            f.setInteger(MediaFormat.KEY_BIT_RATE, OPUS_BITS)
            f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 8192)
            codec.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
        }

        fun encode(pcm: ShortArray, n: Int): List<ByteArray> {
            val got = ArrayList<ByteArray>()
            var at = 0
            var tries = 0
            while (at < n) {
                val i = codec.dequeueInputBuffer(5_000)
                if (i < 0) {
                    drain(got)
                    if (++tries > 4) break          // the encoder is not taking sound: this window is lost, not the microphone loop
                    continue
                }
                val buf = codec.getInputBuffer(i) ?: break
                buf.clear()
                buf.order(ByteOrder.LITTLE_ENDIAN)
                val take = minOf(n - at, buf.remaining() / 2)
                buf.asShortBuffer().put(pcm, at, take)
                codec.queueInputBuffer(i, 0, take * 2, samples * 1_000_000L / RATE, 0)
                samples += take
                at += take
                drain(got)
            }
            drain(got)
            return got
        }

        private fun drain(into: MutableList<ByteArray>) {
            while (true) {
                val o = codec.dequeueOutputBuffer(info, 0)
                if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue
                if (o < 0) return
                // The first buffers describe the stream; the decoder here is told that itself.
                if (info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                    codec.getOutputBuffer(o)?.let { b ->
                        b.position(info.offset); b.limit(info.offset + info.size)
                        into.add(ByteArray(info.size).also { b.get(it) })
                    }
                }
                codec.releaseOutputBuffer(o, false)
            }
        }

        fun release() { runCatching { codec.stop() }; runCatching { codec.release() } }
    }

    /** Opus packets in, sound out at whatever rate the decoder gives (48 kHz on Android). */
    private class OpusIn {
        private val codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
        private val info = MediaCodec.BufferInfo()
        private var channels = 1
        private var at = 0L
        var rate = 48_000
            private set

        init {
            val f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, 48_000, 1)
            // The stream's header, as the decoder wants it: "OpusHead", version 1, one channel,
            // nothing to skip, made from 16 kHz sound, no gain, the plain channel layout.
            val head = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN)
            head.put("OpusHead".toByteArray(Charsets.US_ASCII)).put(1.toByte()).put(1.toByte()).putShort(0.toShort()).putInt(RATE).putShort(0.toShort()).put(0.toByte())
            head.flip()
            f.setByteBuffer("csd-0", head)
            f.setByteBuffer("csd-1", ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(0L).also { it.flip() })
            f.setByteBuffer("csd-2", ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(80_000_000L).also { it.flip() })
            codec.configure(f, null, null, 0)
            codec.start()
        }

        /** A piece from the hub: packets, each behind its length. -> the sound in all of them. */
        fun decode(piece: ByteArray): ShortArray {
            val pcm = ArrayList<ShortArray>()
            var p = 0
            while (p + 2 <= piece.size) {
                val n = (piece[p].toInt() and 0xff) or ((piece[p + 1].toInt() and 0xff) shl 8)
                p += 2
                if (n <= 0 || p + n > piece.size) break
                val i = codec.dequeueInputBuffer(10_000)
                if (i >= 0) {
                    val buf = codec.getInputBuffer(i)
                    if (buf != null && buf.capacity() >= n) {
                        buf.clear(); buf.put(piece, p, n)
                        codec.queueInputBuffer(i, 0, n, at, 0)
                    } else codec.queueInputBuffer(i, 0, 0, at, 0)
                    at += 20_000
                }
                p += n
                drain(pcm, 0)
            }
            // The last packets come out a moment after they went in.
            drain(pcm, 12_000)
            val total = pcm.sumOf { it.size }
            val all = ShortArray(total)
            var w = 0
            for (a in pcm) { a.copyInto(all, w); w += a.size }
            return all
        }

        private fun drain(into: MutableList<ShortArray>, firstWaitUs: Long) {
            var wait = firstWaitUs
            while (true) {
                val o = codec.dequeueOutputBuffer(info, wait)
                if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    val of = codec.outputFormat
                    rate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                    channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT).coerceAtLeast(1)
                    continue
                }
                if (o < 0) return
                wait = if (firstWaitUs > 0) 3_000 else 0
                if (info.size > 0) {
                    codec.getOutputBuffer(o)?.let { b ->
                        b.position(info.offset); b.limit(info.offset + info.size)
                        val s = b.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                        val frames = s.remaining() / channels
                        // More than one channel: the first is the voice.
                        into.add(ShortArray(frames) { s.get(it * channels) })
                    }
                }
                codec.releaseOutputBuffer(o, false)
            }
        }

        fun release() { runCatching { codec.stop() }; runCatching { codec.release() } }
    }

    /**
     * For a check on a device with no sound made: one second of a made-up voice-like tone through
     * this device's Opus encoder and back through its decoder. -> one line saying what came out.
     */
    fun selfTest(): String = try {
        val enc = OpusOut()
        val dec = OpusIn()
        val window = 512
        var inSum = 0.0
        var bytes = 0
        var count = 0
        var outSamples = 0
        var outSum = 0.0
        val took = android.os.SystemClock.elapsedRealtime()
        for (w in 0 until RATE / window) {
            val pcm = ShortArray(window) { i ->
                val t = (w * window + i).toDouble() / RATE
                val env = 0.5 + 0.5 * sin(2 * PI * 3 * t)
                val v = env * (0.12 * sin(2 * PI * 180 * t) + 0.08 * sin(2 * PI * 540 * t) + 0.05 * sin(2 * PI * 1900 * t))
                inSum += v * v
                (v * 32767).toInt().toShort()
            }
            val got = enc.encode(pcm, window)
            if (got.isEmpty()) continue
            val piece = ByteArrayOutputStream()
            for (p in got) { piece.write(p.size and 0xff); piece.write((p.size shr 8) and 0xff); piece.write(p); bytes += p.size; count++ }
            val back = dec.decode(piece.toByteArray())
            outSamples += back.size
            for (s in back) { val v = s / 32768.0; outSum += v * v }
        }
        val ms = android.os.SystemClock.elapsedRealtime() - took
        val rate = dec.rate
        enc.release(); dec.release()
        "Opus test: 1000 ms in, $count packets, $bytes bytes; out $outSamples samples at $rate Hz (${outSamples * 1000L / rate} ms); " +
            "level in %.3f out %.3f; took $ms ms".format(sqrt(inSum / RATE), if (outSamples > 0) sqrt(outSum / outSamples) else 0.0)
    } catch (e: Exception) {
        "Opus test: failed (${e.javaClass.simpleName}: ${e.message})"
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
