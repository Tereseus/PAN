package dev.pan.app.stt

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class GoogleSttEngine @Inject constructor(
    @ApplicationContext private val context: Context
) : SttEngine {

    companion object {
        private const val TAG = "GoogleSTT"
    }

    private val handler = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var callback: ((String, Boolean) -> Unit)? = null
    private var _enabled = true
    private var consecutiveErrors = 0

    override var isListening: Boolean = false
        private set

    var enabled: Boolean
        get() = _enabled
        set(value) {
            _enabled = value
            if (!value) stopListening()
            else if (callback != null) handler.post { restart() }
        }

    override fun startListening(onResult: (String, Boolean) -> Unit) {
        if (!_enabled) return
        callback = onResult
        handler.post { restart() }
    }

    override fun stopListening() {
        handler.removeCallbacksAndMessages(null)
        handler.post {
            recognizer?.cancel()
            recognizer?.destroy()
            recognizer = null
        }
        isListening = false
    }

    fun destroy() {
        _enabled = false
        stopListening()
    }

    private fun restart() {
        if (!_enabled || callback == null) return

        // Reuse existing recognizer — don't destroy/recreate (that causes the sound)
        if (recognizer == null) {
            if (!SpeechRecognizer.isRecognitionAvailable(context)) return
            recognizer = SpeechRecognizer.createSpeechRecognizer(context)
            recognizer?.setRecognitionListener(listener)
        }

        try {
            recognizer?.startListening(createIntent())
            isListening = true
        } catch (e: Exception) {
            Log.e(TAG, "Start failed: ${e.message}")
            // Recreate recognizer on failure
            recognizer?.destroy()
            recognizer = null
            handler.postDelayed({ restart() }, 1000)
        }
    }

    private fun createIntent(): Intent {
        return Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra("android.speech.extra.OBSCENITY_FILTER", false)
            putExtra("android.speech.extra.DICTATION_MODE", true)
            // Longer speech timeout so it doesn't cut out as fast
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 3000)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 3000)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 5000)
        }
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            consecutiveErrors = 0
        }
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}

        override fun onError(error: Int) {
            isListening = false
            when (error) {
                SpeechRecognizer.ERROR_NO_MATCH,
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> {
                    consecutiveErrors = 0
                    // Restart immediately — reuse same recognizer, no sound
                    handler.post { restart() }
                }
                SpeechRecognizer.ERROR_CLIENT -> {
                    // Recognizer busy — wait a bit
                    handler.postDelayed({ restart() }, 500)
                }
                else -> {
                    consecutiveErrors++
                    val backoff = (1000L * consecutiveErrors).coerceAtMost(10000L)
                    handler.postDelayed({ restart() }, backoff)
                }
            }
        }

        override fun onResults(results: Bundle?) {
            val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
            if (text.isNotBlank()) {
                callback?.invoke(text, true)
            }
            isListening = false
            consecutiveErrors = 0
            // Restart immediately — same recognizer instance, no gap
            handler.post { restart() }
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
            if (text.isNotBlank()) {
                callback?.invoke(text, false)
            }
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }
}
