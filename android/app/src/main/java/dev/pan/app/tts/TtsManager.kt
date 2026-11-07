package dev.pan.app.tts

import android.content.Context
import android.media.AudioAttributes
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.pan.app.debug.VoiceEvents
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

    // With Piper active the Android voice still speaks the lines in another script (translate
    // mode), and "is PAN talking" said no all through them: the recogniser, which stops
    // transcribing while PAN talks so it cannot hear itself, transcribed PAN's own Japanese.
    val isSpeaking: Boolean
        get() = if (piperActive) piper.isSpeaking || (foreignIds.isNotEmpty() && (tts?.isSpeaking == true || otherSpeaking))
                else tts?.isSpeaking == true || otherSpeaking

    private val otherSpeaking: Boolean get() = others.values.any { it.isSpeaking }

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
            tts?.let { tune(it) }

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
                    mainVoice = best
                    englishVoice = best
                    Log.i(TAG, "TTS voice: ${best.name} (quality=${best.quality})")
                }
            }

            tts?.setOnUtteranceProgressListener(progress)

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

    private fun tune(t: TextToSpeech) {
        t.setSpeechRate(1.1f)
        t.setPitch(0.95f)
        t.setAudioAttributes(AudioAttributes.Builder()
            // VOICE_COMMUNICATION routes through the telephony audio path.
            // When AudioManager is in MODE_IN_COMMUNICATION, AEC gets the speaker
            // reference signal from this path and can cancel TTS bleed from the mic.
            .setUsage(if (androidOnMedia) AudioAttributes.USAGE_MEDIA else AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        )
    }

    // Interpreted lines go out on the media path, like Supertonic's. The call path needs the
    // loudspeaker asked for on every line, and Chinese went out of the earpiece without it.
    private var androidOnMedia = false
        set(value) {
            if (field == value) return
            field = value
            tts?.let { tune(it) }
            others.values.forEach { tune(it) }
        }
    // The same tts_play_start / tts_play_end the Piper engine logs, so the voice benchmark
    // can time a Japanese reply and knows when it has finished.
    private val progress = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {
            if (utteranceId == WARM_ID) return
            if (!piperActive || utteranceId in foreignIds) {
                onSpeakingStateChanged?.invoke(true)
                VoiceEvents.emit("tts_play_start", "engine" to "android")
                startOf = utteranceId
                if (firstAudioOf == utteranceId) voiceOut()
            }
        }
        // Neither call alone means a person can hear it. The audio can be ready while the player
        // is still busy with another line, and onStart can come before there is any audio. So the
        // card and the bench time the later of the two.
        override fun onAudioAvailable(utteranceId: String?, audio: ByteArray?) {
            if (utteranceId == null || utteranceId == WARM_ID || utteranceId == firstAudioOf) return
            if (!piperActive || utteranceId in foreignIds) {
                firstAudioOf = utteranceId
                if (startOf == utteranceId) voiceOut()
            }
        }
        override fun onDone(utteranceId: String?) {
            if (utteranceId == WARM_ID) {
                warmLeft.decrementAndGet()
                return
            }
            if (!piperActive || foreignIds.remove(utteranceId)) {
                onSpeakingStateChanged?.invoke(false)
                VoiceEvents.emit("tts_play_end", "engine" to "android", "cut" to false)
            }
        }
        // tts.stop() (barge-in, mute, screen off) ends a line here, not in onDone, so a
        // Japanese line cut short never told the service PAN had stopped talking.
        override fun onStop(utteranceId: String?, interrupted: Boolean) {
            if (utteranceId == WARM_ID) {
                warmLeft.decrementAndGet()
                return
            }
            if (!piperActive || foreignIds.remove(utteranceId)) {
                onSpeakingStateChanged?.invoke(false)
                VoiceEvents.emit("tts_play_end", "engine" to "android", "cut" to true)
            }
        }
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) {
            if (utteranceId == WARM_ID) {
                warmLeft.decrementAndGet()
                return
            }
            if (!piperActive || foreignIds.remove(utteranceId)) {
                onSpeakingStateChanged?.invoke(false)
                VoiceEvents.emit("tts_play_end", "engine" to "android", "cut" to true)
            }
        }
    }

    // ONE ENGINE PER LANGUAGE WHILE INTERPRETING. A two way talk changes language on every line,
    // and one engine changing voice took up to 0.8 s to start a line. An engine that keeps its
    // voice started in 60 to 110 ms on lines it had never said, one engine flipping in 230 to 930
    // ms (InterpretBench fresh, 2026-11-05).
    private val others = java.util.concurrent.ConcurrentHashMap<String, TextToSpeech>()
    private val WARM_ID = "pan-warm"
    @Volatile private var firstAudioOf: String? = null
    @Volatile private var startOf: String? = null
    private val warmLeft = java.util.concurrent.atomic.AtomicInteger()
    private var preparedFor: String? = null

    private fun voiceOut() {
        VoiceEvents.emit("tts_audio", "engine" to "android")
        onPlayStart?.invoke()
    }

    // A number nobody has said, quietly. Google's voice answers a line it knows from its cache
    // without loading anything, so "Yes" warmed nothing, and every language can read a number.
    private fun warm(t: TextToSpeech) {
        val quiet = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 0f) }
        warmLeft.incrementAndGet()
        t.speak("${100 + (Math.random() * 900).toInt()}", TextToSpeech.QUEUE_ADD, quiet, WARM_ID)
    }

    // All the engines share one player: a line behind the four quiet ones waited 4 s to start.
    private fun dropWarming() {
        if (warmLeft.get() <= 0) return
        tts?.stop()
        others.values.forEach { it.stop() }
    }

    // Back and forth: the first new line on a voice after the other one had been used took 0.47 s,
    // once, and every line after that was quick.
    private fun warmBoth(t: TextToSpeech) {
        val main = tts ?: return
        repeat(2) {
            warm(main)
            warm(t)
        }
    }

    /** Gets a language's own engine ready, voice loaded, before its first line. */
    fun prepareLanguage(code: String) {
        otherLanguage = code
        if (piperActive && piper.speaks(code)) return
        if (preparedFor == code) return     // the hub says so after every reply
        preparedFor = code
        others[code]?.let {
            warmBoth(it)
            return
        }
        var engine: TextToSpeech? = null
        engine = TextToSpeech(context) { status ->
            val t = engine
            if (status != TextToSpeech.SUCCESS || t == null) return@TextToSpeech
            tune(t)
            t.setOnUtteranceProgressListener(progress)
            val voice = t.voices
                ?.filter { it.locale.language == code }
                ?.sortedWith(compareBy<android.speech.tts.Voice> { it.isNetworkConnectionRequired }.thenByDescending { it.quality })
                ?.firstOrNull()
            if (voice != null) t.voice = voice else t.language = Locale(code)
            others[code] = t
            warmBoth(t)
            Log.i(TAG, "Own engine for $code: ${voice?.name}")
        }
    }

    // Piper's voices only speak English. A reply in another script (translate mode answering
    // in Japanese) goes to the Android voice for that language instead of coming out as nothing.
    private var englishVoice: android.speech.tts.Voice? = null
    private var mainVoice: android.speech.tts.Voice? = null   // what the main engine has now
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
        val own = others[locale.language]
        if (own != null) {
            speakOn(own, text)
            return
        }
        val t = tts ?: return
        val voice = t.voices
            ?.filter { it.locale.language == locale.language }
            ?.sortedWith(compareBy<android.speech.tts.Voice> { it.isNetworkConnectionRequired }.thenByDescending { it.quality })
            ?.firstOrNull()
        speakTracked(text, voice, locale)
    }

    // An Android-voice line while Piper is the voice: its id goes in foreignIds, so the listener
    // reports it (onSpeakingStateChanged, the tts_play events) and isSpeaking counts it. A
    // counter, not the clock: two lines queued in the same millisecond shared an id, and the
    // second one's end was never reported.
    private val fxSeq = java.util.concurrent.atomic.AtomicLong()

    private fun speakTracked(text: String, voice: android.speech.tts.Voice?, locale: Locale) {
        val t = tts ?: return
        if (voice == null) {
            t.language = locale
            mainVoice = null
        } else if (voice != mainVoice) {
            t.voice = voice
            mainVoice = voice
        }
        speakOn(t, text)
        Log.d(TAG, "Speaking (${locale.language}, ${voice?.name ?: "default"}): ${text.take(30)}")
    }

    private fun speakOn(t: TextToSpeech, text: String) {
        dropWarming()
        if (!androidOnMedia) piper.toLoudspeaker()
        val id = "pan-fx-${fxSeq.incrementAndGet()}"
        foreignIds.add(id)
        t.speak(text, TextToSpeech.QUEUE_ADD, Bundle(), id)
    }

    /**
     * While interpreting (the hub says so at the start of the reply) Supertonic says the line in
     * whatever language it is in, on the normal audio path. The owner heard each language five
     * ways and picked this over the Android voices on either path (2026-11-06), though the Android
     * voice starts in 0.1 s and this one takes 0.45 to 0.8 s to build a line. A language it cannot
     * read stays on the Android voice. Set per reply by the service.
     */
    @Volatile var interpreting = false
        set(value) {
            field = value
            piper.plainPath = value && piperActive
            androidOnMedia = value
            lineVoice = null
        }

    /** Whose voice the interpreted line goes out in, set after [interpreting]. Null is PAN's own. */
    @Volatile var lineVoice: Int? = null

    /** The line going out now is on the normal audio path: no call mode. */
    val plainPath: Boolean get() = androidOnMedia

    // The language being interpreted, once the hub names it. Han with no kana is Chinese to
    // scriptLocale, and in Japanese that is a short line like 東京駅.
    @Volatile private var otherLanguage: String? = null

    /** Interpreting is starting: the first line should not pay for a cold voice. */
    fun warmVoice() {
        if (piperActive) piper.warm()
    }

    /** The voice is starting, whichever engine has the line. */
    var onPlayStart: (() -> Unit)? = null
        set(value) {
            field = value
            piper.onPlayStart = value
        }

    private fun lineLanguage(foreign: Locale?) = when {
        foreign == null -> "en"
        foreign.language == "zh" && otherLanguage == "ja" -> "ja"
        else -> foreign.language
    }

    private fun lineText(text: String, foreign: Locale?, lang: String) =
        SpokenNumbers.say(if (foreign == null) latinGreek(text) else text, lang)

    /** An interpreted line that will probably be said next. See PiperTtsEngine.prepare. */
    fun prepareLine(text: String, voice: Int? = null) {
        if (!piperActive) return
        val foreign = scriptLocale(text)
        val lang = lineLanguage(foreign)
        if (piper.speaks(lang)) piper.prepare(LineClauses.split(lineText(text, foreign, lang)).first(), lang, voice)
    }

    fun speak(text: String) {
        if (text.isBlank()) return

        val foreign = scriptLocale(text)
        if (interpreting && piperActive) {
            val lang = lineLanguage(foreign)
            if (piper.speaks(lang)) {
                val voice = lineVoice
                LineClauses.split(lineText(text, foreign, lang)).forEach { piper.speak(it, lang, voice) }
                return
            }
        }
        if (foreign != null && ready) {
            speakForeign(text, foreign)
            return
        }

        if (piperActive && interpreting && ready) {
            speakTracked(androidText(text), englishVoice, Locale.US)
            return
        }

        if (piperActive) {
            piper.speak(latinGreek(text))
            return
        }

        // Android TTS fallback
        if (!ready) return
        val spoken = androidText(text)
        // A foreign reply may have switched the voice; English goes back to the English one.
        englishVoice?.let { if (mainVoice != it) { tts?.voice = it; mainVoice = it } }
        val params = Bundle()
        tts?.speak(spoken, TextToSpeech.QUEUE_ADD, params, "pan-${System.currentTimeMillis()}")
        Log.d(TAG, "Speaking: ${spoken.take(50)}...")
    }

    /** A line as the Android voice should say it: Greek letters in Latin, no markdown, capped. */
    private fun androidText(text: String): String {
        val cleaned = latinGreek(text)
            .replace(Regex("\\*\\*(.+?)\\*\\*"), "$1")
            .replace(Regex("\\*(.+?)\\*"), "$1")
            .replace(Regex("`(.+?)`"), "$1")
            .replace(Regex("^#+\\s+", RegexOption.MULTILINE), "")
            .replace(Regex("^[\\-*]\\s+", RegexOption.MULTILINE), "")
            .trim()
        return if (cleaned.length > 500) cleaned.take(500) + "... see full response in the app." else cleaned
    }

    fun stop() {
        piper.stop()
        tts?.stop()
        others.values.forEach { it.stop() }
    }

    fun destroy() {
        piper.destroy()
        tts?.stop()
        tts?.shutdown()
        tts = null
        others.values.forEach { it.stop(); it.shutdown() }
        others.clear()
    }
}
