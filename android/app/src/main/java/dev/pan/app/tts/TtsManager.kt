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
        private const val PREFS = "pan_tts_prefs"
        private const val KEY_VOICE = "voice_quality"
    }

    private var tts: TextToSpeech? = null
    private var ready = false

    // Piper engine — created but NEVER loads a model until files are confirmed ready
    val piper = PiperTtsEngine(context)
    private var piperActive = false

    var onSpeakingStateChanged: ((Boolean) -> Unit)? = null
        set(value) {
            field = value
            piper.onSpeakingStateChanged = value
        }

    val isSpeaking: Boolean
        get() = if (piperActive) piper.isSpeaking else tts?.isSpeaking == true

    var voiceQuality: String
        get() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_VOICE, "android") ?: "android"
        set(value) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_VOICE, value).apply()
            activateVoice(value)
        }

    init {
        tts = TextToSpeech(context, this)
        // Do NOT load Piper here — wait until explicitly activated after download
    }

    /** Call this ONLY when piper.isFullyReady(quality) is true */
    fun activateVoice(quality: String) {
        if (quality == "android") {
            piperActive = false
            Log.i(TAG, "Using Android TTS")
            return
        }
        if (piper.isFullyReady(quality) && piper.setVoice(quality)) {
            piperActive = true
            Log.i(TAG, "Piper active: $quality")
        } else {
            piperActive = false
            Log.w(TAG, "Piper '$quality' not ready, using Android TTS")
        }
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            tts?.language = Locale.US
            tts?.setSpeechRate(1.1f)
            tts?.setPitch(0.95f)

            tts?.setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
            )

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

            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    if (!piperActive) onSpeakingStateChanged?.invoke(true)
                }
                override fun onDone(utteranceId: String?) {
                    if (!piperActive) onSpeakingStateChanged?.invoke(false)
                }
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    if (!piperActive) onSpeakingStateChanged?.invoke(false)
                }
            })

            ready = true
            Log.i(TAG, "TTS initialized")

            // Now try to activate Piper if user had it selected and files are ready
            val q = voiceQuality
            if (q != "android" && piper.isFullyReady(q)) {
                activateVoice(q)
            }
        } else {
            Log.e(TAG, "TTS init failed: $status")
        }
    }

    fun speak(text: String) {
        if (text.isBlank()) return

        if (piperActive) {
            piper.speak(text)
            return
        }

        // Android TTS fallback
        if (!ready) return
        var cleaned = text
            .replace(Regex("\\*\\*(.+?)\\*\\*"), "$1")
            .replace(Regex("\\*(.+?)\\*"), "$1")
            .replace(Regex("`(.+?)`"), "$1")
            .replace(Regex("^#+\\s+", RegexOption.MULTILINE), "")
            .replace(Regex("^[\\-*]\\s+", RegexOption.MULTILINE), "")
            .trim()
        val spoken = if (cleaned.length > 500) cleaned.take(500) + "... see full response in the app." else cleaned
        val params = Bundle()
        tts?.speak(spoken, TextToSpeech.QUEUE_ADD, params, "pan-${System.currentTimeMillis()}")
        Log.d(TAG, "Speaking: ${spoken.take(50)}...")
    }

    fun stop() {
        piper.stop()
        tts?.stop()
    }

    fun destroy() {
        piper.destroy()
        tts?.stop()
        tts?.shutdown()
        tts = null
    }
}
