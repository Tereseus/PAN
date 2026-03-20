package dev.pan.app.tts

import android.content.Context
import android.media.AudioAttributes
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.Locale
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class TtsManager @Inject constructor(
    @ApplicationContext private val context: Context
) : TextToSpeech.OnInitListener {

    companion object {
        private const val TAG = "PanTTS"
    }

    private var tts: TextToSpeech? = null
    private var ready = false

    // Callback to mute/unmute mic while speaking — set by PanForegroundService
    var onSpeakingStateChanged: ((Boolean) -> Unit)? = null

    val isSpeaking: Boolean
        get() = tts?.isSpeaking == true

    init {
        tts = TextToSpeech(context, this)
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            tts?.language = Locale.US
            tts?.setSpeechRate(1.1f)
            tts?.setPitch(0.95f)

            val voices = tts?.voices
            if (voices != null) {
                val preferred = voices.filter {
                    it.locale.language == "en" && !it.isNetworkConnectionRequired
                }.sortedByDescending { it.quality }

                val best = preferred.firstOrNull { it.name.contains("en-us-x-iom") }
                    ?: preferred.firstOrNull { it.name.contains("en-us-x-iob") }
                    ?: preferred.firstOrNull { it.name.contains("en-us-x-tpf") }
                    ?: preferred.firstOrNull { it.quality >= 400 }
                    ?: preferred.firstOrNull()

                if (best != null) {
                    tts?.voice = best
                    Log.i(TAG, "TTS voice: ${best.name} (quality=${best.quality})")
                }
            }

            // Track when TTS starts/stops speaking so we can mute the mic
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    Log.d(TAG, "TTS started speaking")
                    onSpeakingStateChanged?.invoke(true)
                }

                override fun onDone(utteranceId: String?) {
                    Log.d(TAG, "TTS done speaking")
                    onSpeakingStateChanged?.invoke(false)
                }

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    Log.e(TAG, "TTS error")
                    onSpeakingStateChanged?.invoke(false)
                }
            })

            ready = true
            Log.i(TAG, "TTS initialized")
        } else {
            Log.e(TAG, "TTS init failed: $status")
        }
    }

    fun speak(text: String) {
        if (!ready || text.isBlank()) return

        val spoken = if (text.length > 500) text.take(500) + "... see full response in the app." else text
        val params = Bundle()
        tts?.speak(spoken, TextToSpeech.QUEUE_ADD, params, "pan-${System.currentTimeMillis()}")
        Log.d(TAG, "Speaking: ${spoken.take(50)}...")
    }

    fun stop() {
        tts?.stop()
    }

    fun destroy() {
        tts?.stop()
        tts?.shutdown()
        tts = null
    }
}
