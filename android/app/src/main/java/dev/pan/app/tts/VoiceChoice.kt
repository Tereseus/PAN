package dev.pan.app.tts

/**
 * Which voice speaks: decided here and nowhere else, as plain rules with no Android in them, so
 * every case is checked by a test on each build (VoiceChoiceTest).
 *
 * Why this is its own file: the car unit spoke in the Android voice for two days and said nothing
 * about it (2026-11-17 to 19). ΠAN's voice was on the unit, the setting had never moved to it, and
 * the one branch that state fell into logged nothing. The owner heard a voice that was not ΠAN's
 * and a woman's voice for Japanese. Two rules came out of that:
 *   1. When ΠAN's voice is on the device it is the voice, unless the Android voice was chosen by
 *      hand in Settings.
 *   2. No case is silent: every choice at start, and every line the Android voice takes, has a
 *      sentence for the log saying why.
 */
object VoiceChoice {
    /** ΠAN's voice, the same on every device. */
    const val MAIN = "supertonic3"
    const val ANDROID = "android"
    /** Voices that speak nothing on this sherpa-onnx; a setting still naming one is moved. */
    val DEAD = setOf("low", "medium", "high", "kokoro")

    enum class StartAction { USE, DOWNLOAD, KEEP_ANDROID }

    /**
     * What to do at start. [voice] is the voice to load (USE), to download (DOWNLOAD), or
     * "android" (KEEP_ANDROID). [setting] is what the saved setting should say now, when it has
     * to change. [say] is the line for the log: never empty.
     */
    data class AtStart(val action: StartAction, val voice: String, val setting: String?, val say: String)

    /**
     * [setting]: the saved voice. [picked]: it was chosen by hand in Settings. [ready]: is this
     * voice's model on the device, whole.
     */
    fun atStart(setting: String, picked: Boolean, ready: (String) -> Boolean): AtStart {
        val main = ready(MAIN)
        if (setting in DEAD) {
            return if (main) AtStart(StartAction.USE, MAIN, MAIN, "Voice: $setting speaks nothing on this sherpa-onnx, moving to $MAIN")
            else AtStart(StartAction.DOWNLOAD, MAIN, ANDROID, "Voice: $setting speaks nothing on this sherpa-onnx; downloading $MAIN, the Android voice until it is here")
        }
        if (setting != ANDROID && ready(setting)) return AtStart(StartAction.USE, setting, null, "Voice: $setting ready")
        if (setting == ANDROID && picked) return AtStart(StartAction.KEEP_ANDROID, ANDROID, null, "Voice: the Android voice, chosen in Settings")
        if (!main) return AtStart(StartAction.DOWNLOAD, MAIN, null, "Voice: downloading $MAIN, the Android voice until it is here (the setting says '$setting')")
        // The voice is on the device and the setting never moved to it (the download ended and the
        // app was stopped before the next line ran), or the setting names a voice that is not there.
        return AtStart(StartAction.USE, MAIN, MAIN, "Voice: $MAIN is on the device and the setting was '$setting', moving to it")
    }

    enum class Engine { PAN, ANDROID_OTHER_LANGUAGE, ANDROID_ENGLISH, NOTHING }

    /**
     * Who says one line. [lang] is the language it is said in. [sid] is a voice of ΠAN's for this
     * line, where an interpreted talk has one per person; null is ΠAN's own. [why] is set when the
     * Android voice has the line, for the log.
     */
    data class ForLine(val engine: Engine, val lang: String, val sid: Int?, val why: String?)

    /**
     * [panActive]: ΠAN's voice is loaded. [androidReady]: the Android voice can speak.
     * [interpreting]: this reply is an interpreted line. [script]: the language read off the
     * line's letters, null for Latin letters. [said]: the language whoever translated the line
     * says it is in. [other]: the language being interpreted. [lineVoice]: the voice of the person
     * this line is for. [speaks]: can ΠAN's voice read this language.
     */
    fun forLine(
        panActive: Boolean, androidReady: Boolean, interpreting: Boolean, script: String?, said: String?,
        other: String?, lineVoice: Int?, speaks: (String) -> Boolean,
    ): ForLine {
        val lang = when {
            script == null -> said?.takeIf { interpreting } ?: "en"
            // Han with no kana reads as Chinese, and in Japanese that is a short line like a station's name.
            script == "zh" && other == "ja" -> "ja"
            else -> script
        }
        val noPan = "PAN's voice is not loaded"
        if (panActive && (interpreting || script != null) && speaks(lang)) return ForLine(Engine.PAN, lang, if (interpreting) lineVoice else null, null)
        if (script != null && androidReady) return ForLine(Engine.ANDROID_OTHER_LANGUAGE, script, null, if (panActive) "PAN's voice cannot read $script" else noPan)
        // A language in Latin letters that ΠAN's voice cannot read: the Android voice for that language, not the English one.
        if (interpreting && said != null && said != "en" && androidReady) return ForLine(Engine.ANDROID_OTHER_LANGUAGE, said, null, if (panActive) "PAN's voice cannot read $said" else noPan)
        if (panActive && interpreting && androidReady) return ForLine(Engine.ANDROID_ENGLISH, "en", null, "PAN's voice cannot read $lang")
        if (panActive) return ForLine(Engine.PAN, "en", null, null)
        if (!androidReady) return ForLine(Engine.NOTHING, lang, null, "no voice is ready")
        return ForLine(Engine.ANDROID_ENGLISH, "en", null, noPan)
    }
}
