package dev.pan.app.tts

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import com.k2fsa.sherpa.onnx.GeneratedAudio
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsSupertonicModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.tanh
import java.io.File
import java.io.FileOutputStream
import java.net.URL

/**
 * Piper TTS — high-quality on-device speech.
 *
 * CRITICAL: OfflineTts must NEVER be created until model + espeak data are fully downloaded.
 * sherpa-onnx will SIGSEGV (native crash, uncatchable) if files are missing.
 */
class PiperTtsEngine(private val context: Context) {

    companion object {
        private const val TAG = "PiperTTS"

        // espeak-ng data is bundled in APK assets/espeak-ng-data/
        // Copied to filesDir on first run (~18MB)

        // Use sherpa-onnx repackaged models (have sample_rate in metadata)
        // Raw Piper models from HuggingFace DON'T work with sherpa-onnx
        private const val REL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models"

        /**
         * Engines disagree wildly about output level. Measured on one sentence:
         * Piper peaks at -1.7 dBFS, Supertonic -7.6, Kokoro -14.8, and the RMS
         * gap between Piper and Supertonic is 7.5 dB - about half the perceived
         * loudness. Nothing normalised, so changing engine silently changed the
         * volume. Normalise every utterance to a fixed peak instead.
         */
        private const val TARGET_PEAK = 0.95f

        /** Cap so near-silence is not amplified into hiss. */
        private const val MAX_GAIN = 8f

        /**
         * How far the gain may move between one utterance and the next.
         *
         * playAudio() normalises PER CALL and the streaming path calls it once
         * per SENTENCE, so a reply was re-levelled mid-run: a short "Right."
         * has a low peak and got boosted up to 8x, then the next sentence
         * contained a plosive, peaked near 1.0 and got 1.05x. The result is the
         * volume lurching from quiet to blaring inside one answer, and it became
         * far more audible once replies turned conversational and multi-sentence.
         *
         * Normalising is still right - engines differ by ~7.5 dB - but it has to
         * move slowly. 1.3 tracks a genuine voice change over a few utterances
         * while keeping one reply level.
         */
        private const val MAX_GAIN_STEP = 1.3f

        private val SUPERTONIC_FILES = listOf(
            "text_encoder.int8.onnx", "duration_predictor.int8.onnx",
            "vector_estimator.int8.onnx", "vocoder.int8.onnx",
            "voice.bin", "tts.json", "unicode_indexer.bin"
        )

        val VOICES = mapOf(
            "low" to VoiceModel("low", "Amy (Low)", "Low",
                "$REL/vits-piper-en_US-amy-low.tar.bz2",
                "vits-piper-en_US-amy-low", 8_000_000L, 16000),
            "medium" to VoiceModel("medium", "Amy (Medium)", "Medium",
                "$REL/vits-piper-en_US-amy-medium.tar.bz2",
                "vits-piper-en_US-amy-medium", 35_000_000L, 22050),
            "high" to VoiceModel("high", "Lessac (High)", "High",
                "$REL/vits-piper-en_US-lessac-high.tar.bz2",
                "vits-piper-en_US-lessac-high", 65_000_000L, 22050),
            // Kokoro 82M (StyleTTS2). Markedly less synthetic than Piper.
            // int8 multi-lang is 140MB vs 305MB for the fp32 English-only build,
            // and it is the newer v1.1 architecture, so it wins on both counts.
            // sid picks the speaker out of voices.bin; 0 is af_alloy.
            "kokoro" to VoiceModel("kokoro", "Kokoro (Natural)", "Natural",
                "$REL/kokoro-int8-multi-lang-v1_1.tar.bz2",
                "kokoro-int8-multi-lang-v1_1", 147_000_000L, 24000,
                kind = "kokoro", sid = 0, numThreads = 4),
            // Supertonic: measured 7.3x realtime vs Kokoro's 0.9x on the same
            // sentence, at 44.1kHz and under half the size. MIT licensed. Four
            // separate onnx graphs, and NO espeak-ng-data - it phonemises from
            // unicode_indexer.bin, which is why nothing here points at espeakDir.
            "supertonic" to VoiceModel("supertonic", "Supertonic (Fast)", "Fast",
                "$REL/sherpa-onnx-supertonic-tts-int8-2026-03-06.tar.bz2",
                "sherpa-onnx-supertonic-tts-int8-2026-03-06", 85_000_000L, 44100,
                // sid 9 of 10, chosen by ear from the full sampler.
                // 1.0 reads as deliberate to the point of sounding slow in
                // conversation. 1.18 is brisk without clipping consonants.
                kind = "supertonic", sid = 9, numThreads = 4, speed = 1.35f)
        )
    }

    data class VoiceModel(val id: String, val name: String, val quality: String,
        val tarUrl: String, val archiveDir: String, val sizeBytes: Long, val sampleRate: Int,
        val kind: String = "vits", val sid: Int = 0, val numThreads: Int = 2,
        val speed: Float = 1.0f)

    private val modelsDir = File(context.filesDir, "piper-models")
    private val espeakDir = File(modelsDir, "espeak-ng-data")
    private var currentVoice: VoiceModel? = null
    // NEVER created until isFullyReady() == true
    private var offlineTts: OfflineTts? = null
    private var audioTrack: AudioTrack? = null
    private var speakJob: Job? = null

    // Last gain actually applied, so the next utterance can only step so far
    // from it. -1 means nothing has played yet and the first value is taken
    // as-is.
    @Volatile private var lastGain = -1f
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /**
     * Only ONE utterance is ever audible at a time.
     *
     * The streaming path calls panSpeak() once per SENTENCE as chunks arrive, so
     * several speak() calls land within a few hundred ms of each other. The old
     * code cancelled the previous job and started a new one - but cancellation in
     * Kotlin is COOPERATIVE and AudioTrack.write() blocks uninterruptibly, so a
     * sentence already mid-write kept playing while the next one opened its own
     * AudioTrack. Two voices, talking over each other.
     *
     * A fair Mutex serialises them instead: sentence two waits for sentence one
     * to finish, which is also the order they should be heard in.
     */
    private val playLock = Mutex()

    /**
     * Utterances queued or playing. The speaking flag must go FALSE only when the
     * last one finishes - flipping it per sentence would re-arm the microphone in
     * the middle of PAN's own answer, which is how barge-in gets triggered by its
     * own voice.
     */
    private val pending = AtomicInteger(0)

    var onSpeakingStateChanged: ((Boolean) -> Unit)? = null
    val isSpeaking: Boolean get() = pending.get() > 0 || playLock.isLocked

    fun getDownloadedVoices(): List<String> = VOICES.keys.filter { isVoiceDownloaded(it) }

    fun isVoiceDownloaded(quality: String): Boolean {
        val v = VOICES[quality] ?: return false
        val voiceDir = File(modelsDir, v.id)
        // Look for any .onnx file in the voice directory
        val hasModel = voiceDir.exists() &&
            voiceDir.listFiles()?.any { it.name.endsWith(".onnx") && it.length() > 1000 } == true
        // Kokoro carries its speakers in a separate voices.bin. Without it the
        // native loader SIGSEGVs exactly like a missing model, so gate on it too.
        if (v.kind == "kokoro") {
            return hasModel && File(voiceDir, "voices.bin").length() > 1000
        }
        // Supertonic is four graphs plus three data files. A partial extract that
        // still contains *an* .onnx would otherwise look ready and then SIGSEGV.
        if (v.kind == "supertonic") {
            return SUPERTONIC_FILES.all { File(voiceDir, it).length() > 1000 }
        }
        return hasModel
    }

    fun isEspeakReady(): Boolean {
        return File(espeakDir, "phontab").exists() &&
               File(espeakDir, "phonindex").exists() &&
               File(espeakDir, "phondata").exists()
    }

    fun isFullyReady(quality: String): Boolean = isVoiceDownloaded(quality) && isEspeakReady()

    suspend fun downloadVoice(quality: String, onProgress: ((Float) -> Unit)? = null): Boolean =
        withContext(Dispatchers.IO) {
            val voice = VOICES[quality] ?: return@withContext false
            modelsDir.mkdirs()
            try {
                if (!isEspeakReady()) {
                    copyEspeakFromAssets()
                }
                val voiceDir = File(modelsDir, voice.id)
                if (!isVoiceDownloaded(quality)) {
                    voiceDir.mkdirs()
                    Log.i(TAG, "Downloading ${voice.name} (${voice.sizeBytes / 1_000_000}MB)...")
                    val tarFile = File(modelsDir, "${voice.id}.tar.bz2")
                    downloadFile(voice.tarUrl, tarFile, voice.sizeBytes, onProgress)
                    // Extract tar.bz2
                    Log.i(TAG, "Extracting ${voice.name}...")
                    extractTarBz2(tarFile, modelsDir)
                    tarFile.delete()
                    // The tar extracts to a directory like "vits-piper-en_US-amy-low"
                    // Rename to our simple name
                    // The tar unpacks to its own upstream directory name, which is
                    // recorded per voice. The previous matcher string-mangled the
                    // piper voice ids and could never have matched a Kokoro archive.
                    val extracted = File(modelsDir, voice.archiveDir).takeIf { it.isDirectory }
                        ?: modelsDir.listFiles()?.firstOrNull {
                            it.isDirectory && it.name == voice.archiveDir
                        }
                    if (extracted != null && extracted.name != voice.id) {
                        val target = File(modelsDir, voice.id)
                        if (target.exists()) target.deleteRecursively()
                        extracted.renameTo(target)
                    }
                }
                Log.i(TAG, "${voice.name} ready")
                true
            } catch (e: Exception) {
                Log.e(TAG, "Download failed: ${e.message}")
                false
            }
        }

    /**
     * Load a voice. ONLY call this when isFullyReady(quality) == true.
     * Will SIGSEGV if files are missing.
     */
    fun setVoice(quality: String): Boolean {
        val voice = VOICES[quality] ?: return false
        if (!isFullyReady(quality)) {
            Log.e(TAG, "Cannot load voice '$quality' — files not ready")
            return false
        }
        // Release previous
        try { offlineTts?.release() } catch (_: Exception) {}
        offlineTts = null

        val voiceDir = File(modelsDir, voice.id)
        val modelFile = voiceDir.listFiles()?.firstOrNull { it.name.endsWith(".onnx") }
        val tokensFile = File(voiceDir, "tokens.txt").let { if (it.exists()) it else File(espeakDir, "tokens.txt") }

        // Supertonic names its four graphs explicitly, so the "find any .onnx"
        // probe is meaningless for it (it would pick an arbitrary one of four).
        if (voice.kind != "supertonic" && (modelFile == null || !modelFile.exists())) {
            Log.e(TAG, "No .onnx file found in ${voiceDir.absolutePath}")
            return false
        }

        // Kokoro archives ship their own espeak-ng-data; prefer it over the shared
        // copy so a model built against newer phoneme tables is not fed older ones.
        val dataDir = File(voiceDir, "espeak-ng-data").let { if (it.isDirectory) it else espeakDir }

        return try {
            val modelConfig = if (voice.kind == "supertonic") {
                OfflineTtsModelConfig(
                    supertonic = OfflineTtsSupertonicModelConfig(
                        textEncoder = File(voiceDir, "text_encoder.int8.onnx").absolutePath,
                        durationPredictor = File(voiceDir, "duration_predictor.int8.onnx").absolutePath,
                        vectorEstimator = File(voiceDir, "vector_estimator.int8.onnx").absolutePath,
                        vocoder = File(voiceDir, "vocoder.int8.onnx").absolutePath,
                        voiceStyle = File(voiceDir, "voice.bin").absolutePath,
                        ttsJson = File(voiceDir, "tts.json").absolutePath,
                        unicodeIndexer = File(voiceDir, "unicode_indexer.bin").absolutePath
                    ),
                    numThreads = voice.numThreads,
                    debug = false,
                    provider = "cpu"
                )
            } else if (voice.kind == "kokoro") {
                // English only. Measured: adding lexicon-zh.txt makes the loader spew
                // "Unknown token" on characters it cannot map and costs load time
                // parsing 2MB we never use. dict/ is jieba data for Chinese, likewise
                // dead weight here, and "" is the documented "not set" value.
                val lexicon = File(voiceDir, "lexicon-us-en.txt")
                    .let { if (it.exists()) it.absolutePath else "" }
                val dictDir = ""
                OfflineTtsModelConfig(
                    kokoro = OfflineTtsKokoroModelConfig(
                        model = modelFile!!.absolutePath,
                        voices = File(voiceDir, "voices.bin").absolutePath,
                        tokens = tokensFile.absolutePath,
                        dataDir = dataDir.absolutePath,
                        lexicon = lexicon,
                        lang = "en",
                        dictDir = dictDir
                    ),
                    numThreads = voice.numThreads,
                    debug = false,
                    provider = "cpu"
                )
            } else {
                OfflineTtsModelConfig(
                    vits = OfflineTtsVitsModelConfig(
                        model = modelFile!!.absolutePath,
                        lexicon = "",
                        tokens = tokensFile.absolutePath,
                        dataDir = dataDir.absolutePath,
                        dictDir = ""
                    ),
                    numThreads = voice.numThreads,
                    debug = false,
                    provider = "cpu"
                )
            }
            val config = OfflineTtsConfig(model = modelConfig)
            offlineTts = OfflineTts(assetManager = null, config = config)
            currentVoice = voice
            Log.i(TAG, "Voice loaded: ${voice.name}, sampleRate=${offlineTts?.sampleRate()}")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load voice: ${e.message}", e)
            false
        }
    }

    fun speak(text: String) {
        val tts = offlineTts
        if (text.isBlank() || tts == null) return
        // NO stop() here. That cancelled the sentence currently being spoken, and
        // because AudioTrack.write() blocks uninterruptibly the old one kept
        // playing anyway - two voices at once. Queue behind the mutex instead.
        if (pending.getAndIncrement() == 0) onSpeakingStateChanged?.invoke(true)
        speakJob = scope.launch {
          playLock.withLock {
            try {
                val cleaned = text
                    .replace(Regex("\\*\\*(.+?)\\*\\*"), "$1")
                    .replace(Regex("\\*(.+?)\\*"), "$1")
                    .replace(Regex("`(.+?)`"), "$1")
                    .replace(Regex("^#+\\s+", RegexOption.MULTILINE), "")
                    .replace(Regex("^[\\-*]\\s+", RegexOption.MULTILINE), "")
                    // Dashes made the voice swallow the word right after them
                    // once speed went above 1.0. A comma gives the same pause
                    // and survives the phonemiser. Intra-word hyphens
                    // ("well-known") are deliberately left alone.
                    .replace(Regex("[\u2014\u2013]"), ", ")
                    .replace(Regex("(?<=\\s)-+(?=\\s)"), ",")
                    .trim()
                val spoken = if (cleaned.length > 500) cleaned.take(500) + ". See the app." else cleaned
                Log.d(TAG, "Generating: ${spoken.take(50)}...")
                val audio: GeneratedAudio = tts.generate(text = spoken, sid = currentVoice?.sid ?: 0, speed = currentVoice?.speed ?: 1.0f)
                if (audio.samples.isNotEmpty() && isActive) {
                    playAudio(audio.samples, audio.sampleRate)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Speak failed: ${e.message}", e)
            } finally {
                if (pending.decrementAndGet() <= 0) {
                    pending.set(0)
                    onSpeakingStateChanged?.invoke(false)
                }
            }
          }
        }
    }

    private suspend fun playAudio(samples: FloatArray, sampleRate: Int) = withContext(Dispatchers.IO) {
        Log.i(TAG, "Playing ${samples.size} samples at ${sampleRate}Hz")

        // Convert float samples to 16-bit PCM (more compatible across devices)
        var peak = 0f
        for (s in samples) { val a = abs(s); if (a > peak) peak = a }
        val wanted = if (peak > 0.01f) min(TARGET_PEAK / peak, MAX_GAIN) else 1f
        // Clamp the step from the previous utterance so one reply is level.
        val gain = if (lastGain <= 0f) wanted
                   else wanted.coerceIn(lastGain / MAX_GAIN_STEP, lastGain * MAX_GAIN_STEP)
        lastGain = gain

        // Soft-clip instead of hard-clipping at the ceiling. tanh squashes the
        // peaks so the whole waveform can be driven harder without the crackle a
        // hard clip produces, which is what actually makes speech sound louder:
        // perceived loudness tracks average level, not peak, and peak alone was
        // already maxed.
        val drive = 1.7f
        val norm = tanh(drive)
        val shortSamples = ShortArray(samples.size)
        for (i in samples.indices) {
            val driven = tanh(samples[i] * gain * drive) / norm
            val clamped = driven.coerceIn(-1f, 1f)
            shortSamples[i] = (clamped * 32767f).toInt().toShort()
        }
        Log.i(TAG, "level: peak=%.3f gain=%.2fx (wanted %.2fx)".format(peak, gain, wanted))

        // Route to the LOUDSPEAKER, not the earpiece.
        //
        // USAGE_VOICE_COMMUNICATION is used so AEC can cancel our own output from
        // the mic (that is what stops TTS triggering barge-in). The side effect is
        // that Android routes it exactly like a phone call, i.e. out of the little
        // earpiece at the top of the phone. Measured on device: STREAM_VOICE_CALL
        // was already at max volume 15/15 with "Devices: earpiece(1)", so it was
        // never a gain problem, it was the wrong speaker - easily 20+ dB.
        //
        // Only overridden when the current device IS the earpiece, so a connected
        // Bluetooth headset or wired headphones keep the audio they should get.
        try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val current = am.communicationDevice?.type
            if (current == null || current == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
                val speaker = am.availableCommunicationDevices
                    .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                if (speaker != null) {
                    val ok = am.setCommunicationDevice(speaker)
                    Log.i(TAG, "routed to loudspeaker: $ok (was $current)")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "speaker routing failed: ${e.message}")
        }

        val minBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val bufSize = maxOf(minBuf, shortSamples.size * 2)
        Log.i(TAG, "AudioTrack: minBuf=$minBuf, bufSize=$bufSize")

        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder()
                // VOICE_COMMUNICATION routes through the telephony audio path.
                // When AudioManager is in MODE_IN_COMMUNICATION, AEC can cancel this output
                // from the mic signal — preventing Piper TTS bleed from triggering barge-in.
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(bufSize)
            .build()
        audioTrack = track
        track.play()
        val written = track.write(shortSamples, 0, shortSamples.size)
        Log.i(TAG, "Wrote $written/${shortSamples.size} samples, state=${track.playState}")
        // Wait for playback to ACTUALLY finish, not for a computed duration.
        //
        // WHAT WAS BROKEN: this slept for (sample count / rate) + 100ms and then
        // stopped the track. But play() does not begin output instantly and
        // write() of a large buffer takes time of its own, so that margin
        // expired while audio was still queued - and stop() cut it. The symptom
        // was the last word (or syllable) being clipped off every utterance,
        // worst at 44.1kHz where the buffer holds more samples.
        //
        // playbackHeadPosition counts frames the hardware has actually played,
        // so waiting on it is exact regardless of startup latency or buffer size.
        val durationMs = (samples.size.toLong() * 1000) / sampleRate
        val deadline = System.currentTimeMillis() + durationMs + 2000  // never hang
        try {
            while (isActive &&
                   track.playbackHeadPosition < shortSamples.size &&
                   System.currentTimeMillis() < deadline) {
                delay(20)
            }
            // A final grace period: the head position reaching the last frame means it
            // was handed to the mixer, not that it left the speaker.
            delay(120)
        } finally {
            // CUT, do not drain. AudioTrack.stop() on a STREAM-mode track plays out
            // everything already written, and bufSize above is deliberately large
            // enough to hold the WHOLE utterance - so stopping used to play the rest
            // of the sentence. That is the tail you hear talking over you after a
            // barge-in. flush() is the only call that discards queued audio, and it
            // is legal only while paused or stopped.
            val interrupted = !isActive
            val played = try { track.playbackHeadPosition } catch (_: Exception) { -1 }
            // stop() may have already taken and released this track; only clean up
            // the one we still own, or we double-release.
            if (audioTrack === track) {
                if (interrupted) {
                    try { track.pause() } catch (_: Exception) {}
                    try { track.flush() } catch (_: Exception) {}
                }
                try { track.stop() } catch (_: Exception) {}
                try { track.release() } catch (_: Exception) {}
                audioTrack = null
            }
            Log.i(TAG, "Playback ${if (interrupted) "CUT" else "done"} (${durationMs}ms, played $played/${shortSamples.size} frames)")
        }
    }

    fun stop() {
        // Cancel EVERY queued utterance, not just the most recent. speakJob only
        // ever held the last one, so a barge-in used to silence one sentence and
        // let the rest of the queue play on.
        scope.coroutineContext.cancelChildren()
        speakJob = null
        pending.set(0)
        onSpeakingStateChanged?.invoke(false)
        // pause + flush BEFORE stop. stop() alone DRAINS the buffer, so a barge-in
        // used to be followed by the rest of the sentence playing over the user.
        // Take the reference first so playAudio's finally sees it is no longer the
        // owner and does not release the same track twice.
        val t = audioTrack
        audioTrack = null
        try { t?.pause() } catch (_: Exception) {}
        try { t?.flush() } catch (_: Exception) {}
        try { t?.stop() } catch (_: Exception) {}
        try { t?.release() } catch (_: Exception) {}
    }

    fun destroy() {
        stop()
        try { offlineTts?.release() } catch (_: Exception) {}
        offlineTts = null
        scope.cancel()
    }

    private fun extractTarBz2(tarFile: File, destDir: File) {
        // Use ProcessBuilder to run tar (available on Android)
        try {
            val pb = ProcessBuilder("tar", "xjf", tarFile.absolutePath, "-C", destDir.absolutePath)
            pb.redirectErrorStream(true)
            val p = pb.start()
            val output = p.inputStream.bufferedReader().readText()
            val exitCode = p.waitFor()
            if (exitCode != 0) {
                Log.e(TAG, "tar extract failed ($exitCode): $output")
            }
        } catch (e: Exception) {
            Log.e(TAG, "tar extract exception: ${e.message}")
            // Fallback: try bzip2 + tar separately via Java
        }
    }

    private fun copyEspeakFromAssets() {
        espeakDir.mkdirs()
        Log.i(TAG, "Copying espeak-ng data from assets...")
        val assets = context.assets
        fun copyDir(assetPath: String, destDir: File) {
            destDir.mkdirs()
            val files = assets.list(assetPath) ?: return
            for (name in files) {
                val dest = File(destDir, name)
                val subPath = "$assetPath/$name"
                val subFiles = assets.list(subPath)
                if (subFiles != null && subFiles.isNotEmpty()) {
                    copyDir(subPath, dest)
                } else {
                    if (!dest.exists()) {
                        assets.open(subPath).use { input ->
                            FileOutputStream(dest).use { output -> input.copyTo(output) }
                        }
                    }
                }
            }
        }
        copyDir("espeak-ng-data", espeakDir)
        Log.i(TAG, "espeak-ng data ready")
    }

    private suspend fun downloadFile(url: String, dest: File, totalSize: Long, onProgress: ((Float) -> Unit)?) =
        withContext(Dispatchers.IO) {
            val tmp = File(dest.parent, dest.name + ".tmp")
            URL(url).openConnection().apply {
                connectTimeout = 15000; readTimeout = 30000
            }.getInputStream().use { input ->
                FileOutputStream(tmp).use { output ->
                    val buf = ByteArray(8192)
                    var dl = 0L; var n: Int
                    while (input.read(buf).also { n = it } != -1) {
                        output.write(buf, 0, n); dl += n
                        if (totalSize > 0) onProgress?.invoke(dl.toFloat() / totalSize)
                    }
                }
            }
            tmp.renameTo(dest)
        }
}
