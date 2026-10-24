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
    var onInterrupt: (() -> Unit)?
    /** True while a server query is in flight, so STT does not treat TTS as input. */
    var queryPending: Boolean
    /** Tell the engine what PAN just said, so it can subtract its own echo. */
    fun registerTtsOutput(text: String)
    fun destroy()

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
