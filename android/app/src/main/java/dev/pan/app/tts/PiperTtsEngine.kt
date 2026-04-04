package dev.pan.app.tts

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import com.k2fsa.sherpa.onnx.GeneratedAudio
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import kotlinx.coroutines.*
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
        val VOICES = mapOf(
            "low" to VoiceModel("low", "Amy (Low)", "Low",
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-low.tar.bz2",
                "", 8_000_000L, 16000),
            "medium" to VoiceModel("medium", "Amy (Medium)", "Medium",
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-medium.tar.bz2",
                "", 35_000_000L, 22050),
            "high" to VoiceModel("high", "Lessac (High)", "High",
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-high.tar.bz2",
                "", 65_000_000L, 22050)
        )
    }

    data class VoiceModel(val id: String, val name: String, val quality: String,
        val tarUrl: String, val unused: String, val sizeBytes: Long, val sampleRate: Int)

    private val modelsDir = File(context.filesDir, "piper-models")
    private val espeakDir = File(modelsDir, "espeak-ng-data")
    private var currentVoice: VoiceModel? = null
    // NEVER created until isFullyReady() == true
    private var offlineTts: OfflineTts? = null
    private var audioTrack: AudioTrack? = null
    private var speakJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    var onSpeakingStateChanged: ((Boolean) -> Unit)? = null
    val isSpeaking: Boolean get() = speakJob?.isActive == true

    fun getDownloadedVoices(): List<String> = VOICES.keys.filter { isVoiceDownloaded(it) }

    fun isVoiceDownloaded(quality: String): Boolean {
        val v = VOICES[quality] ?: return false
        val voiceDir = File(modelsDir, v.id)
        // Look for any .onnx file in the voice directory
        return voiceDir.exists() && voiceDir.listFiles()?.any { it.name.endsWith(".onnx") && it.length() > 1000 } == true
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
                    val extracted = modelsDir.listFiles()?.firstOrNull {
                        it.isDirectory && it.name.startsWith("vits-piper") && it.name.contains(voice.id.replace("high", "lessac-high").replace("medium", "amy-medium").replace("low", "amy-low"))
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

        if (modelFile == null || !modelFile.exists()) {
            Log.e(TAG, "No .onnx file found in ${voiceDir.absolutePath}")
            return false
        }

        return try {
            val config = OfflineTtsConfig(
                model = OfflineTtsModelConfig(
                    vits = OfflineTtsVitsModelConfig(
                        model = modelFile.absolutePath,
                        lexicon = "",
                        tokens = tokensFile.absolutePath,
                        dataDir = espeakDir.absolutePath,
                        dictDir = ""
                    ),
                    numThreads = 2,
                    debug = false,
                    provider = "cpu"
                )
            )
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
        stop()
        speakJob = scope.launch {
            try {
                onSpeakingStateChanged?.invoke(true)
                val cleaned = text
                    .replace(Regex("\\*\\*(.+?)\\*\\*"), "$1")
                    .replace(Regex("\\*(.+?)\\*"), "$1")
                    .replace(Regex("`(.+?)`"), "$1")
                    .replace(Regex("^#+\\s+", RegexOption.MULTILINE), "")
                    .replace(Regex("^[\\-*]\\s+", RegexOption.MULTILINE), "")
                    .trim()
                val spoken = if (cleaned.length > 500) cleaned.take(500) + ". See the app." else cleaned
                Log.d(TAG, "Generating: ${spoken.take(50)}...")
                val audio: GeneratedAudio = tts.generate(text = spoken, sid = 0, speed = 1.0f)
                if (audio.samples.isNotEmpty() && isActive) {
                    playAudio(audio.samples, audio.sampleRate)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Speak failed: ${e.message}", e)
            } finally {
                onSpeakingStateChanged?.invoke(false)
            }
        }
    }

    private suspend fun playAudio(samples: FloatArray, sampleRate: Int) = withContext(Dispatchers.IO) {
        Log.i(TAG, "Playing ${samples.size} samples at ${sampleRate}Hz")

        // Convert float samples to 16-bit PCM (more compatible across devices)
        val shortSamples = ShortArray(samples.size)
        for (i in samples.indices) {
            val clamped = samples[i].coerceIn(-1f, 1f)
            shortSamples[i] = (clamped * 32767f).toInt().toShort()
        }

        val minBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val bufSize = maxOf(minBuf, shortSamples.size * 2)
        Log.i(TAG, "AudioTrack: minBuf=$minBuf, bufSize=$bufSize")

        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
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
        // Wait for playback to finish
        val durationMs = (samples.size.toLong() * 1000) / sampleRate
        delay(durationMs + 100)
        track.stop()
        track.release()
        audioTrack = null
        Log.i(TAG, "Playback done (${durationMs}ms)")
    }

    fun stop() {
        speakJob?.cancel()
        speakJob = null
        try { audioTrack?.stop() } catch (_: Exception) {}
        try { audioTrack?.release() } catch (_: Exception) {}
        audioTrack = null
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
