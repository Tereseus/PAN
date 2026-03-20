package dev.pan.app.stt

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.*
import javax.inject.Inject
import javax.inject.Singleton

/**
 * GoogleStreamingStt — uses Android's built-in speech recognition.
 *
 * Transcribes in REAL TIME as the user speaks. No chunks, no silence
 * waiting, no 18-second Whisper delay. Results come back as partial
 * results while speaking and final results when done.
 *
 * Automatically restarts after each utterance to stay always-listening.
 * Pauses processing while TTS is speaking to avoid echo.
 */
@Singleton
class GoogleStreamingStt @Inject constructor(
    @ApplicationContext private val context: Context
) : SttEngine {

    companion object {
        private const val TAG = "GoogleSTT"
        private const val RESTART_DELAY_MS = 300L
    }

    private var recognizer: SpeechRecognizer? = null
    private var callback: ((String, Boolean) -> Unit)? = null
    private var _enabled = true
    private val mainScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    override var isListening: Boolean = false
        private set

    var onLog: ((String) -> Unit)? = null
    var isTtsSpeaking: (() -> Boolean)? = null
    var onInterrupt: (() -> Unit)? = null

    // Track what PAN said recently for echo stripping
    private val recentTtsOutput = mutableListOf<String>()
    private val ttsTimestamps = mutableListOf<Long>()
    private val TTS_ECHO_WINDOW_MS = 3000L

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

    private fun log(msg: String) {
        Log.i(TAG, msg)
        onLog?.invoke("[STT] $msg")
    }

    fun registerTtsOutput(text: String) {
        val lower = text.lowercase().trim()
        recentTtsOutput.add(lower)
        // Estimate TTS end time (~80ms per word)
        val words = lower.split("\\s+".toRegex()).size
        ttsTimestamps.add(System.currentTimeMillis() + words * 80L)
        while (recentTtsOutput.size > 10) {
            recentTtsOutput.removeAt(0)
            ttsTimestamps.removeAt(0)
        }
    }

    private fun stripEcho(text: String): String {
        val now = System.currentTimeMillis()
        var result = text.lowercase().trim()

        for (i in recentTtsOutput.indices) {
            if (now - ttsTimestamps[i] > TTS_ECHO_WINDOW_MS) continue
            val ttsWords = recentTtsOutput[i].split("\\s+".toRegex()).filter { it.length > 2 }.toSet()
            if (ttsWords.isEmpty()) continue

            val resultWords = result.split("\\s+".toRegex()).toMutableList()
            val matched = mutableSetOf<Int>()
            for (tw in ttsWords) {
                for (j in resultWords.indices) {
                    if (j in matched) continue
                    if (resultWords[j] == tw || (resultWords[j].length > 3 && tw.length > 3 &&
                                (resultWords[j].contains(tw) || tw.contains(resultWords[j])))) {
                        matched.add(j)
                        break
                    }
                }
            }
            if (matched.size > ttsWords.size * 0.5) {
                result = resultWords.filterIndexed { i, _ -> i !in matched }.joinToString(" ").trim()
            }
        }

        val remaining = result.split("\\s+".toRegex()).filter { it.length > 1 }
        return if (remaining.size < 2) "" else result
    }

    private fun createRecognizerIntent(): Intent {
        return Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            // Keep listening longer before giving up on silence
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 3000L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 500L)
        }
    }

    override fun startListening(onResult: (String, Boolean) -> Unit) {
        if (!_enabled) return
        callback = onResult

        mainScope.launch {
            startRecognizer()
        }
    }

    // Mute the system beep that plays when SpeechRecognizer starts/stops
    private fun muteBeep() {
        try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            am.adjustStreamVolume(AudioManager.STREAM_NOTIFICATION, AudioManager.ADJUST_MUTE, 0)
            am.adjustStreamVolume(AudioManager.STREAM_SYSTEM, AudioManager.ADJUST_MUTE, 0)
        } catch (_: Exception) {}
    }

    private fun unmuteBeep() {
        try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            am.adjustStreamVolume(AudioManager.STREAM_NOTIFICATION, AudioManager.ADJUST_UNMUTE, 0)
            am.adjustStreamVolume(AudioManager.STREAM_SYSTEM, AudioManager.ADJUST_UNMUTE, 0)
        } catch (_: Exception) {}
    }

    private fun startRecognizer() {
        if (!_enabled || !SpeechRecognizer.isRecognitionAvailable(context)) {
            log("Speech recognition not available")
            return
        }

        try {
            recognizer?.destroy()

            // Mute system beeps before starting recognizer
            muteBeep()

            // Use standard recognizer — on-device throws ERROR 11 on some Pixels
            recognizer = SpeechRecognizer.createSpeechRecognizer(context)

            recognizer?.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {
                    isListening = true
                    log("Listening...")
                }

                override fun onBeginningOfSpeech() {
                    // User started talking — interrupt TTS if playing
                    if (isTtsSpeaking?.invoke() == true) {
                        onInterrupt?.invoke()
                    }
                }

                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}

                override fun onPartialResults(partialResults: Bundle?) {
                    val texts = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    val partial = texts?.firstOrNull() ?: return
                    // Don't process partials while TTS is speaking
                    if (isTtsSpeaking?.invoke() == true) return
                    // Could show partial in UI if needed
                }

                override fun onResults(results: Bundle?) {
                    val texts = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    val finalText = texts?.firstOrNull() ?: ""

                    if (finalText.isNotBlank()) {
                        // If TTS was speaking during this recognition, it's echo — discard
                        if (isTtsSpeaking?.invoke() == true) {
                            log("Discarded (TTS speaking): $finalText")
                        } else {
                            val userSpeech = stripEcho(finalText)
                            if (userSpeech.isNotBlank()) {
                                log("Final: $userSpeech")
                                callback?.invoke(userSpeech, true)
                            } else {
                                log("Echo filtered: $finalText")
                            }
                        }
                    }

                    // Auto-restart — but wait if TTS is speaking
                    restartListening()
                }

                override fun onError(error: Int) {
                    val errorName = when (error) {
                        SpeechRecognizer.ERROR_AUDIO -> "AUDIO"
                        SpeechRecognizer.ERROR_CLIENT -> "CLIENT"
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "PERMISSIONS"
                        SpeechRecognizer.ERROR_NETWORK -> "NETWORK"
                        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "NETWORK_TIMEOUT"
                        SpeechRecognizer.ERROR_NO_MATCH -> "NO_MATCH"
                        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "BUSY"
                        SpeechRecognizer.ERROR_SERVER -> "SERVER"
                        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "SPEECH_TIMEOUT"
                        else -> "UNKNOWN($error)"
                    }

                    // NO_MATCH and SPEECH_TIMEOUT are normal — just means silence
                    if (error != SpeechRecognizer.ERROR_NO_MATCH &&
                        error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        log("Error: $errorName")
                    }

                    // Always restart
                    restartListening()
                }

                override fun onEndOfSpeech() {
                    isListening = false
                }

                override fun onEvent(eventType: Int, params: Bundle?) {}
            })

            recognizer?.startListening(createRecognizerIntent())
        } catch (e: Exception) {
            log("Failed to start: ${e.message}")
            // Retry after delay
            mainScope.launch {
                delay(RESTART_DELAY_MS * 3)
                if (_enabled) startRecognizer()
            }
        }
    }

    private fun restartListening() {
        if (!_enabled) return
        mainScope.launch {
            // Wait for TTS to finish before restarting — prevents hearing ourselves
            var waitedMs = 0L
            while (isTtsSpeaking?.invoke() == true && waitedMs < 30000) {
                delay(200)
                waitedMs += 200
            }
            delay(RESTART_DELAY_MS)
            if (_enabled) {
                startRecognizer()
            }
        }
    }

    override fun stopListening() {
        isListening = false
        try { recognizer?.stopListening() } catch (_: Exception) {}
        try { recognizer?.destroy() } catch (_: Exception) {}
        recognizer = null
    }

    fun destroy() {
        _enabled = false
        stopListening()
        mainScope.cancel()
    }
}
