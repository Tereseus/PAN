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
 *
 * IMPORTANT (2026-07-15 fix): the recognizer instance is REUSED across
 * utterances. The previous code destroyed + recreated it on every result
 * and every error, which (a) made the on-device recognition service throw
 * ERROR_SERVER_DISCONNECTED (11) in a tight loop, and (b) opened a fresh
 * mic-warmup gap each cycle that swallowed the user's first word. We now
 * reuse one instance and only recreate on a HARD error, with backoff.
 */
@Singleton
class GoogleStreamingStt @Inject constructor(
    @ApplicationContext private val context: Context
) : SttEngine {

    companion object {
        private const val TAG = "GoogleSTT"
        private const val RESTART_DELAY_MS = 300L
        // Backoff after a HARD recognizer error (service disconnected / busy / client /
        // server). Tight-looping a restart on ERROR 11 was the churn source — see onError().
        private const val HARD_ERROR_BACKOFF_MS = 700L
    }

    private var recognizer: SpeechRecognizer? = null
    private var recognitionListener: RecognitionListener? = null
    private var hardErrors = 0   // consecutive hard errors → escalating backoff
    private var callback: ((String, Boolean) -> Unit)? = null
    private var _enabled = true
    private val mainScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    override var isListening: Boolean = false
        private set

    var onLog: ((String) -> Unit)? = null
    var isTtsSpeaking: (() -> Boolean)? = null
    var onInterrupt: (() -> Unit)? = null

    // Set to true while a server query is in-flight (from query sent → TTS starts / query fails).
    // Prevents STT from restarting and picking up TTS audio before TTS has a chance to begin.
    @Volatile var queryPending: Boolean = false

    // Track what PAN said recently for echo stripping
    private val recentTtsOutput = mutableListOf<String>()
    private val ttsTimestamps = mutableListOf<Long>()
    // Was 1000ms. Echo transcripts finalize ~4-5s AFTER PAN speaks (the recognizer waits out
    // a 3-4s silence timeout before emitting a final), so a 1s window let PAN's own words
    // sail through as a "user" command. 8s covers the finalize latency without holding
    // phrases so long they'd clobber a genuine follow-up that reuses PAN's words.
    // (2026-07-15 echo fix.)
    private val TTS_ECHO_WINDOW_MS = 8000L

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
            if (matched.size > ttsWords.size * 0.8) {
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
            // Don't steal audio focus from music — allow coexistence
            putExtra("android.speech.extra.DICTATION_MODE", true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
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
            // Mute system beeps before starting recognizer
            muteBeep()

            // Reuse a single recognizer instance across utterances. Destroying +
            // recreating it every cycle is what caused the ERROR_SERVER_DISCONNECTED (11)
            // churn and the mic-warmup gap that ate the user's first word.
            if (recognizer == null) {
                recognizer = SpeechRecognizer.createSpeechRecognizer(context).also {
                    it.setRecognitionListener(buildListener())
                }
            } else {
                // Reset any lingering session before re-arming so startListening doesn't BUSY.
                try { recognizer?.cancel() } catch (_: Exception) {}
            }

            recognizer?.startListening(createRecognizerIntent())
            log("Recognizer listening (reuse)")
        } catch (e: Exception) {
            log("Failed to start: ${e.message}")
            recreateSoon(RESTART_DELAY_MS * 3)
        }
    }

    /** Destroy the current recognizer and start a fresh one after [delayMs] — used only for
     *  hard errors where the recognition service itself is wedged. */
    private fun recreateSoon(delayMs: Long) {
        try { recognizer?.destroy() } catch (_: Exception) {}
        recognizer = null
        mainScope.launch {
            delay(delayMs)
            if (_enabled) startRecognizer()
        }
    }

    private fun errorName(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "AUDIO"
        SpeechRecognizer.ERROR_CLIENT -> "CLIENT"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "PERMISSIONS"
        SpeechRecognizer.ERROR_NETWORK -> "NETWORK"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "NETWORK_TIMEOUT"
        SpeechRecognizer.ERROR_NO_MATCH -> "NO_MATCH"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "BUSY"
        SpeechRecognizer.ERROR_SERVER -> "SERVER"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "SPEECH_TIMEOUT"
        SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> "SERVER_DISCONNECTED"
        else -> "UNKNOWN($error)"
    }

    private fun buildListener(): RecognitionListener {
        recognitionListener?.let { return it }
        val l = object : RecognitionListener {
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
                // If actual words are being recognized while TTS is playing,
                // that's the user talking — interrupt TTS immediately
                if (partial.isNotBlank() && isTtsSpeaking?.invoke() == true) {
                    onInterrupt?.invoke()
                }
            }

            override fun onResults(results: Bundle?) {
                hardErrors = 0  // a clean result means the service is healthy again
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
                val name = errorName(error)
                // Log ALL errors for debugging (NO_MATCH/SPEECH_TIMEOUT are normal but useful)
                log("Error: $name")

                when (error) {
                    // HARD errors: the recognition service died / is wedged. Recreating on a
                    // backoff (instead of hammering startListening) is what stops the ERROR 11
                    // storm. If TTS/query is in-flight we defer to restartListening's wait loop.
                    SpeechRecognizer.ERROR_SERVER_DISCONNECTED,
                    SpeechRecognizer.ERROR_CLIENT,
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
                    SpeechRecognizer.ERROR_SERVER -> {
                        hardErrors++
                        if (queryPending || isTtsSpeaking?.invoke() == true) {
                            restartListening()
                        } else {
                            recreateSoon(HARD_ERROR_BACKOFF_MS * hardErrors.coerceAtMost(5))
                        }
                    }
                    // SOFT errors (no speech / timeout): normal end-of-utterance — just re-arm.
                    else -> {
                        hardErrors = 0
                        restartListening()
                    }
                }
            }

            override fun onEndOfSpeech() {
                isListening = false
            }

            override fun onEvent(eventType: Int, params: Bundle?) {}
        }
        recognitionListener = l
        return l
    }

    private fun restartListening() {
        if (!_enabled) return
        mainScope.launch {
            // Wait while a query is pending (server hasn't responded yet) OR TTS is playing.
            // This prevents STT from restarting and immediately barge-in-ing on TTS audio
            // that starts 2-4s after the query is sent.
            var waitedMs = 0L
            while ((queryPending || isTtsSpeaking?.invoke() == true) && waitedMs < 30000) {
                delay(200)
                waitedMs += 200
            }
            if (waitedMs > 0) {
                delay(1000) // 1s after TTS/query finishes
            } else {
                delay(100) // Minimal gap when no query was pending
            }
            if (_enabled) {
                startRecognizer()
            }
        }
    }

    override fun stopListening() {
        isListening = false
        // Cancel (do NOT destroy) so the warm recognizer is REUSED on the next start.
        // Destroying here reopened the ~200-500ms mic-warmup gap that swallowed the
        // user's first word right after PAN finished speaking (e.g. "when do you
        // contemplate it" arriving as "you contemplate it"). While cancelled the
        // instance isn't capturing, so it can't echo during TTS. Full teardown is
        // done only in destroy(). (2026-07-15 first-word fix #2.)
        try { recognizer?.cancel() } catch (_: Exception) {}
    }

    fun destroy() {
        _enabled = false
        isListening = false
        try { recognizer?.cancel() } catch (_: Exception) {}
        try { recognizer?.destroy() } catch (_: Exception) {}
        recognizer = null
        mainScope.cancel()
    }
}
