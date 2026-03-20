package dev.pan.app.stt

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import com.whispercpp.whisper.WhisperContext
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.pan.app.audio.VoiceActivityDetector
import kotlinx.coroutines.*
import java.io.File
import java.io.FileOutputStream
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.sqrt

@Singleton
class WhisperSttEngine @Inject constructor(
    @ApplicationContext private val context: Context
) : SttEngine {

    companion object {
        private const val TAG = "WhisperSTT"
        private const val SAMPLE_RATE = 16000
        private const val MODEL_NAME = "ggml-tiny.en.bin"
        private const val MAX_SPEECH_SECONDS = 10
        private const val MAX_SPEECH_SAMPLES = SAMPLE_RATE * MAX_SPEECH_SECONDS
        private const val MIN_SPEECH_SAMPLES = SAMPLE_RATE / 2
        private const val READ_SIZE = 1024
        private const val MAX_CONSECUTIVE_ERRORS = 5
        private const val RESTART_DELAY_MS = 1000L
        private const val WATCHDOG_INTERVAL_MS = 5000L
    }

    private var whisperContext: WhisperContext? = null
    private var audioRecord: AudioRecord? = null
    private var recordingJob: Job? = null
    private var watchdogJob: Job? = null
    private var callback: ((String, Boolean) -> Unit)? = null
    private var _enabled = true
    private val vad = VoiceActivityDetector()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // Persistent log callback — set by PanForegroundService to log to server
    var onLog: ((String) -> Unit)? = null

    private fun log(msg: String) {
        Log.i(TAG, msg)
        onLog?.invoke("[Whisper] $msg")
    }

    private fun logError(msg: String) {
        Log.e(TAG, msg)
        onLog?.invoke("[Whisper ERROR] $msg")
    }

    override var isListening: Boolean = false
        private set

    // Recent TTS output — used to filter out PAN hearing its own voice
    // Only filter within 2 seconds of TTS finishing — after that, same words = real conversation
    private val recentTtsOutput = mutableListOf<String>()
    private val TTS_ECHO_WINDOW_MS = 2_000L
    private val ttsTimestamps = mutableListOf<Long>()

    // Set by the service — check if TTS is actively speaking
    var isTtsSpeaking: (() -> Boolean)? = null
    // Called when user speaks over TTS — stop PAN from talking
    var onInterrupt: (() -> Unit)? = null

    // Called by the service when TTS speaks — we remember what was said
    fun registerTtsOutput(text: String) {
        val lower = text.lowercase().trim()
        recentTtsOutput.add(lower)
        // Estimate when TTS will finish: ~100ms per word
        val wordCount = lower.split("\\s+".toRegex()).size
        val estimatedDurationMs = wordCount * 100L
        ttsTimestamps.add(System.currentTimeMillis() + estimatedDurationMs)
        // Keep last 10
        while (recentTtsOutput.size > 10) {
            recentTtsOutput.removeAt(0)
            ttsTimestamps.removeAt(0)
        }
    }

    // Strip PAN's own TTS words from the transcription, return what the user said.
    // If PAN said "Opening YouTube" and the mic picked up "Opening YouTube what about the weather",
    // this returns "what about the weather" — the user's actual speech.
    // If the entire transcription is PAN echo, returns empty string.
    private fun stripEcho(text: String): String {
        val now = System.currentTimeMillis()
        var result = text.lowercase().trim()

        // Collect all recent TTS phrases (within the echo window)
        val activeTtsPhrases = mutableListOf<String>()
        for (i in recentTtsOutput.indices) {
            if (now - ttsTimestamps[i] < TTS_ECHO_WINDOW_MS) {
                activeTtsPhrases.add(recentTtsOutput[i])
            }
        }

        if (activeTtsPhrases.isEmpty()) return text // Nothing to strip

        // For each TTS phrase, find and remove it from the transcription
        for (ttsPhrase in activeTtsPhrases) {
            val ttsWords = ttsPhrase.split("\\s+".toRegex()).filter { it.length > 1 }
            if (ttsWords.isEmpty()) continue

            // Try to find the longest matching subsequence and remove it
            // Use a sliding window approach
            val resultWords = result.split("\\s+".toRegex()).toMutableList()
            val matchedIndices = mutableSetOf<Int>()

            for (tw in ttsWords) {
                for (i in resultWords.indices) {
                    if (i in matchedIndices) continue
                    // Fuzzy match — Whisper might slightly alter words
                    if (resultWords[i] == tw ||
                        (resultWords[i].length > 3 && tw.length > 3 &&
                         (resultWords[i].contains(tw) || tw.contains(resultWords[i])))) {
                        matchedIndices.add(i)
                        break
                    }
                }
            }

            // If we matched more than 50% of TTS words, remove all matched words
            if (matchedIndices.size > ttsWords.size * 0.5) {
                result = resultWords.filterIndexed { i, _ -> i !in matchedIndices }
                    .joinToString(" ").trim()
            }
        }

        // If after stripping we have very little left (< 3 words), it was probably all echo
        val remaining = result.split("\\s+".toRegex()).filter { it.length > 1 }
        if (remaining.size < 2) return ""

        return result
    }

    var enabled: Boolean
        get() = _enabled
        set(value) {
            _enabled = value
            if (!value) {
                stopListening()
            } else if (!isListening && callback != null) {
                startListening(callback!!)
            }
        }

    private suspend fun ensureModel(): File {
        val modelFile = File(context.filesDir, MODEL_NAME)
        if (modelFile.exists()) return modelFile

        log("Extracting Whisper model from assets...")
        withContext(Dispatchers.IO) {
            context.assets.open("models/$MODEL_NAME").use { input ->
                FileOutputStream(modelFile).use { output ->
                    input.copyTo(output)
                }
            }
        }
        log("Model extracted: ${modelFile.length() / 1024 / 1024}MB")
        return modelFile
    }

    private fun calculateRms(buffer: ShortArray, size: Int): Double {
        var sum = 0.0
        for (i in 0 until size) {
            val sample = buffer[i].toDouble()
            sum += sample * sample
        }
        return sqrt(sum / size)
    }

    @SuppressLint("MissingPermission")
    override fun startListening(onResult: (String, Boolean) -> Unit) {
        if (!_enabled) return
        callback = onResult
        stopListening() // Clean up any existing recording

        recordingJob = scope.launch {
            recordingLoop()
        }

        // Start watchdog that monitors and restarts recording if it dies
        startWatchdog()
    }

    @SuppressLint("MissingPermission")
    private suspend fun recordingLoop() {
        try {
            val modelFile = ensureModel()
            if (whisperContext == null) {
                log("Loading Whisper model...")
                whisperContext = WhisperContext.createContextFromFile(modelFile.absolutePath)
                log("Whisper model loaded")
            }
        } catch (e: Exception) {
            logError("Whisper init failed: ${e.message}")
            return
        }

        var consecutiveErrors = 0

        while (_enabled && currentCoroutineContext().isActive) {
            try {
                val bufferSize = AudioRecord.getMinBufferSize(
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT
                )

                audioRecord = AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    maxOf(bufferSize * 2, MAX_SPEECH_SAMPLES * 2)
                )

                if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                    logError("AudioRecord init failed, retrying in ${RESTART_DELAY_MS}ms...")
                    releaseAudioRecord()
                    delay(RESTART_DELAY_MS)
                    consecutiveErrors++
                    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                        logError("Too many consecutive errors, giving up")
                        break
                    }
                    continue
                }

                audioRecord?.startRecording()
                isListening = true
                consecutiveErrors = 0
                log("Recording started")

                val speechBuffer = ShortArray(MAX_SPEECH_SAMPLES)
                var speechPos = 0
                var wasSpeaking = false

                while (_enabled && currentCoroutineContext().isActive) {
                    val readBuffer = ShortArray(READ_SIZE)
                    val read = audioRecord?.read(readBuffer, 0, readBuffer.size) ?: -1

                    if (read < 0) {
                        logError("AudioRecord.read() returned $read — recording interrupted")
                        break
                    }
                    if (read == 0) {
                        delay(10)
                        continue
                    }

                    consecutiveErrors = 0

                    val rms = calculateRms(readBuffer, read)
                    val isSpeech = vad.isSpeech(rms)

                    if (isSpeech) {
                        val toCopy = minOf(read, MAX_SPEECH_SAMPLES - speechPos)
                        if (toCopy > 0) {
                            System.arraycopy(readBuffer, 0, speechBuffer, speechPos, toCopy)
                            speechPos += toCopy
                        }
                        wasSpeaking = true
                    }

                    // Only transcribe when:
                    // 1. Speech ended (silence after talking) — wait for the user to finish
                    // 2. Buffer hit max (15s) — safety limit for very long speech
                    // NO forced chunking — let the user finish their thought
                    val silenceEnded = wasSpeaking && !isSpeech && speechPos >= MIN_SPEECH_SAMPLES
                    val bufferFull = speechPos >= MAX_SPEECH_SAMPLES

                    val shouldTranscribe = silenceEnded || bufferFull

                    if (shouldTranscribe) {
                        val seconds = speechPos / SAMPLE_RATE.toFloat()
                        log("Transcribing ${String.format("%.1f", seconds)}s")

                        val floatData = FloatArray(speechPos) { speechBuffer[it] / 32767.0f }

                        try {
                            val text = whisperContext?.transcribeData(floatData, printTimestamp = false) ?: ""
                            val cleaned = text.trim()
                                .replace(Regex("\\[.*?]"), "")
                                .trim()

                            if (cleaned.isNotBlank()) {
                                // Strip PAN's own TTS words from the transcription
                                val userSpeech = stripEcho(cleaned)
                                if (userSpeech.isNotBlank()) {
                                    log("Transcribed: $userSpeech")
                                    callback?.invoke(userSpeech, true)
                                } else {
                                    log("All echo (PAN talking to itself): $cleaned")
                                }
                            }
                        } catch (e: Exception) {
                            logError("Transcription error: ${e.message}")
                        }

                        speechPos = 0
                        wasSpeaking = false
                    }
                }

                // Inner loop exited — AudioRecord died, clean up and restart
                log("Recording loop exited, cleaning up for restart")
                releaseAudioRecord()
                isListening = false

                if (_enabled) {
                    consecutiveErrors++
                    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                        logError("Too many restart attempts ($consecutiveErrors), stopping")
                        break
                    }
                    log("Restarting recording in ${RESTART_DELAY_MS}ms (attempt $consecutiveErrors)...")
                    delay(RESTART_DELAY_MS)
                }

            } catch (e: CancellationException) {
                throw e // Don't catch coroutine cancellation
            } catch (e: Exception) {
                logError("Recording loop crashed: ${e.message}")
                releaseAudioRecord()
                isListening = false
                if (_enabled) {
                    consecutiveErrors++
                    delay(RESTART_DELAY_MS)
                }
            }
        }

        releaseAudioRecord()
        isListening = false
        log("Recording fully stopped")
    }

    private fun releaseAudioRecord() {
        try {
            audioRecord?.stop()
        } catch (_: Exception) {}
        try {
            audioRecord?.release()
        } catch (_: Exception) {}
        audioRecord = null
    }

    // Watchdog: periodically checks if recording is alive and restarts if needed
    private fun startWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = scope.launch {
            while (_enabled && isActive) {
                delay(WATCHDOG_INTERVAL_MS)

                if (_enabled && !isListening && callback != null) {
                    log("Watchdog: recording died, restarting...")
                    recordingJob?.cancel()
                    recordingJob = scope.launch { recordingLoop() }
                }
            }
        }
    }

    override fun stopListening() {
        watchdogJob?.cancel()
        watchdogJob = null
        recordingJob?.cancel()
        recordingJob = null
        releaseAudioRecord()
        isListening = false
    }

    fun destroy() {
        _enabled = false
        stopListening()
        scope.cancel()
        runBlocking {
            whisperContext?.release()
        }
        whisperContext = null
    }
}
