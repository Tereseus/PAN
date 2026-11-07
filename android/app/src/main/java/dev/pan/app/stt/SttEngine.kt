package dev.pan.app.stt

/**
 * The surface PanForegroundService drives on whichever engine is active.
 *
 * The bottom five members used to live only on GoogleStreamingStt, so the
 * service injected that CONCRETE class to reach them. That is what made the
 * engine unswappable, and why VoskSttEngine sat in the build for months
 * implementing this interface but wired to nothing. They belong here.
 */
interface SttEngine {
    fun startListening(onResult: (String, Boolean) -> Unit) // text, isFinal
    fun stopListening()
    val isListening: Boolean

    var enabled: Boolean
    var onLog: ((String) -> Unit)?
    var isTtsSpeaking: (() -> Boolean)?
    /** PAN's voice just reached the speaker. isTtsSpeaking is true a second before that on a long line. */
    fun onTtsSound() {}
    var onInterrupt: (() -> Unit)?
    /** True while a server query is in flight, so STT does not treat TTS as input. */
    var queryPending: Boolean
    /** Tell the engine what PAN just said, so it can subtract its own echo. */
    fun registerTtsOutput(text: String)
    fun destroy()

    /** Runs when he starts talking while PAN is quiet. Only an engine with a VAD ever calls it. */
    fun onSpeechStart(listener: () -> Unit) {}

    /**
     * 16kHz PCM16 audio of the turn whose final text was [text], for the hub to transcribe
     * again with a bigger model. Null when the engine has none for it. Hands it over once.
     */
    fun takeTurnAudio(text: String): ShortArray? = null

    /**
     * True if the turn whose final text was [text] went out because he stopped mid-sentence and
     * the wait for the rest ran out, not because it sounded finished. The hub uses it to tell a
     * word search ("that movie with the dreams inside dreams, the...") from a question.
     */
    fun turnUnfinished(text: String): Boolean = false

    /**
     * True if every word of the turn whose final text was [text] was heard before PAN last started
     * talking. Such a turn cannot hold PAN's own voice, so the post-TTS echo cooldown must not
     * drop it: a turn PAN talked over is only decided once PAN stops, which always landed inside
     * the cooldown ("thank you, [pause] that is very kind of you" lost its second half,
     * voicebench interp_ja, 2026-11-03).
     */
    fun turnHeardBeforePan(text: String): Boolean = false

    /**
     * True while he is talking right now: the VAD heard him (not PAN) a moment ago. A reply
     * waits for this to clear before PAN starts speaking (PanForegroundService.speakReply).
     */
    fun stillTalking(): Boolean = false

    /**
     * True if he has spoken since the last commit and that turn is not decided yet, pause or no
     * pause. stillTalking() clears 300 ms after his last word, before the turn commits.
     */
    fun turnOpen(): Boolean = false

    /**
     * PAN is interpreting: a turn ends sooner, and on the sound of it, not on the words. An unsure
     * pause cost 1.4 s on 3 of 7 live lines (2026-11-05), and a sentence said in two halves is
     * cheaper than that much silence in the middle of a conversation. The recogniser only knows
     * English, so its words mean nothing when the other person talks.
     */
    var interpreting: Boolean
        get() = false
        set(_) {}

    /** While set, turns go here and not to the callback (interpret/InterpreterLoop). */
    var ear: TurnEar?
        get() = null
        set(_) {}

    /** The moment he last spoke in the turn that went out (currentTimeMillis), or 0. */
    fun lastStopAt(): Long = 0L

    /**
     * True if the engine is meant to keep the microphone open while PAN speaks.
     *
     * A turn-based recogniser has to be stopped before TTS or it transcribes
     * PAN and fights it for audio focus, which is why panSpeak stops it and why
     * BargeInMonitor exists at all: something still has to notice an
     * interruption, so it watches raw energy instead. A continuous engine
     * listens straight through and reports the interruption as WORDS, so the
     * energy monitor is not just redundant, it is a second AudioRecord
     * competing for the same microphone.
     */
    val listensThroughTts: Boolean
}

/** Takes a turn's audio straight from the read loop. */
interface TurnEar {
    /** First silence after speech. The turn may be over: start on it, nobody has heard anything. */
    fun onPause(pcm: FloatArray, stoppedAt: Long)

    /** The turn is over. True if this ear has it. */
    fun onCommit(pcm: FloatArray, stoppedAt: Long): Boolean
}
