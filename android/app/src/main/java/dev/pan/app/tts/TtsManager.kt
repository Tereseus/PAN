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
                // VOICE_COMMUNICATION routes through the telephony audio path.
                // When AudioManager is in MODE_IN_COMMUNICATION, AEC gets the speaker
                // reference signal from this path and can cancel TTS bleed from the mic.
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
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
                    englishVoice = best
                    Log.i(TAG, "TTS voice: ${best.name} (quality=${best.quality})")
                }
            }

            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    if (!piperActive || utteranceId in foreignIds) onSpeakingStateChanged?.invoke(true)
                }
                override fun onDone(utteranceId: String?) {
                    if (!piperActive || foreignIds.remove(utteranceId)) onSpeakingStateChanged?.invoke(false)
                }
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    if (!piperActive || foreignIds.remove(utteranceId)) onSpeakingStateChanged?.invoke(false)
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

    // Piper's voices only speak English. A reply in another script (translate mode answering
    // in Japanese) goes to the Android voice for that language instead of coming out as nothing.
    private var englishVoice: android.speech.tts.Voice? = null
    private val foreignIds: MutableSet<String> =
        java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>())

    // Only when that script is most of the reply's letters: one Greek word in an English
    // sentence ("your threads are ΠΑΝ, Map Creation...") read the whole sentence in the
    // Greek voice (2026-11-03).
    private fun scriptLocale(text: String): Locale? {
        val letters = text.count { it.isLetter() }.coerceAtLeast(1)
        fun most(script: String) = Regex("[$script]").findAll(text).count() * 2 > letters
        val cjk = most("\\u3040-\\u30FF\\u4E00-\\u9FFF\\uAC00-\\uD7AF")
        return when {
            cjk && Regex("[\\u3040-\\u30FF]").containsMatchIn(text) -> Locale.JAPANESE   // kana, so Japanese
            cjk && Regex("[\\uAC00-\\uD7AF]").containsMatchIn(text) -> Locale.KOREAN
            cjk -> Locale.CHINESE    // Han without kana
            most("\\u0370-\\u03FF\\u1F00-\\u1FFF") -> Locale("el")
            most("\\u0400-\\u04FF") -> Locale("ru")
            else -> null
        }
    }

    private val greekLatin = mapOf('Α' to "A", 'Β' to "V", 'Γ' to "G", 'Δ' to "D", 'Ε' to "E", 'Ζ' to "Z",
        'Η' to "I", 'Θ' to "Th", 'Ι' to "I", 'Κ' to "K", 'Λ' to "L", 'Μ' to "M", 'Ν' to "N", 'Ξ' to "X",
        'Ο' to "O", 'Π' to "P", 'Ρ' to "R", 'Σ' to "S", 'Τ' to "T", 'Υ' to "Y", 'Φ' to "F", 'Χ' to "Ch",
        'Ψ' to "Ps", 'Ω' to "O")

    /** A few Greek letters in English, spelled in Latin for the English voices: "ΠΑΝ" is said "PAN". */
    private fun latinGreek(text: String): String {
        if (!Regex("[\\u0370-\\u03FF\\u1F00-\\u1FFF]").containsMatchIn(text)) return text
        val plain = java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFD).replace(Regex("\\p{Mn}"), "")
        return buildString {
            for (c in plain) {
                val latin = greekLatin[c.uppercaseChar()]
                append(if (latin == null) c.toString() else if (c.isUpperCase()) latin.uppercase() else latin.lowercase())
            }
        }
    }

    private fun speakForeign(text: String, locale: Locale) {
        val t = tts ?: return
        val voice = t.voices
            ?.filter { it.locale.language == locale.language }
            ?.sortedWith(compareBy<android.speech.tts.Voice> { it.isNetworkConnectionRequired }.thenByDescending { it.quality })
            ?.firstOrNull()
        if (voice != null) t.voice = voice else t.language = locale
        val id = "pan-fx-${System.currentTimeMillis()}"
        foreignIds.add(id)
        t.speak(text, TextToSpeech.QUEUE_ADD, Bundle(), id)
        Log.d(TAG, "Speaking (${locale.language}, ${voice?.name ?: "default"}): ${text.take(30)}")
    }

    fun speak(text: String) {
        if (text.isBlank()) return

        val foreign = scriptLocale(text)
        if (foreign != null && ready) {
            speakForeign(text, foreign)
            return
        }

        if (piperActive) {
            piper.speak(latinGreek(text))
            return
        }

        // Android TTS fallback
        if (!ready) return
        var cleaned = latinGreek(text)
            .replace(Regex("\\*\\*(.+?)\\*\\*"), "$1")
            .replace(Regex("\\*(.+?)\\*"), "$1")
            .replace(Regex("`(.+?)`"), "$1")
            .replace(Regex("^#+\\s+", RegexOption.MULTILINE), "")
            .replace(Regex("^[\\-*]\\s+", RegexOption.MULTILINE), "")
            .trim()
        val spoken = if (cleaned.length > 500) cleaned.take(500) + "... see full response in the app." else cleaned
        // A foreign reply may have switched the voice; English goes back to the English one.
        englishVoice?.let { if (tts?.voice != it) tts?.voice = it }
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
