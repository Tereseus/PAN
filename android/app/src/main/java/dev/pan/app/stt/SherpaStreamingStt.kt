package dev.pan.app.stt

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.util.Log
import com.k2fsa.sherpa.onnx.EndpointConfig
import com.k2fsa.sherpa.onnx.EndpointRule
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.*
import java.io.File
import java.io.FileOutputStream
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton

/**
 * SherpaStreamingStt - continuous recognition, no turns.
 *
 * WHY THIS EXISTS. GoogleStreamingStt uses Android's SpeechRecognizer, which is
 * turn-based by construction: it recognises ONE utterance and then has to be
 * restarted. Its own header says so ("Automatically restarts after each
 * utterance to stay always-listening"). That restart is a real seam in the
 * audio - it is where the first word of a sentence goes missing - and the
 * utterance boundary is decided by a silence timeout measured in SECONDS, which
 * is most of why talking to PAN feels like radio and not like a phone call.
 *
 * This engine has no seam. ONE AudioRecord and ONE OnlineStream are opened when
 * listening starts and are never torn down until it stops. Audio flows in
 * continuously; text comes out continuously.
 *
 * The recogniser, not a timeout, decides when a thought ended: isEndpoint() is
 * evaluated on the decoded stream, so "he stopped talking" is a property of what
 * was said rather than of how long the microphone was quiet. ENDPOINT_SILENCE_S
 * below is ~1s against Google's 3-4s, and it is a real dial we can turn.
 *
 * It also keeps listening while PAN is speaking. VOICE_COMMUNICATION plus the
 * hardware AEC is the same recipe BargeInMonitor already proved works on this
 * phone, but because this engine transcribes instead of measuring energy, an
 * interruption arrives as WORDS. A door slam has no words. That is a better
 * discriminator than any threshold, and it is why BargeInMonitor is not started
 * alongside this engine (see PanForegroundService) - two AudioRecords competing
 * for one microphone is also a good way to get a device-specific init failure.
 *
 * Model: sherpa-onnx streaming zipformer transducer, 20M params, int8. ~45MB,
 * downloaded once on first run. sherpa-onnx itself is NOT a new dependency - the
 * same AAR already ships for Piper TTS and has carried the streaming ASR classes
 * all along.
 */
@Singleton
class SherpaStreamingStt @Inject constructor(
    @ApplicationContext private val context: Context
) : SttEngine {

    companion object {
        private const val TAG = "SherpaSTT"
        private const val SAMPLE_RATE = 16000

        // Trailing silence that raises a CANDIDATE end-of-turn. Deliberately
        // short: it is no longer the decision, only the moment the decision is
        // made. Smart Turn (a model that LISTENS to the last 8 s) plus the
        // dangling-word rule in isTurnComplete() decide whether to commit or keep
        // listening. A fixed silence timer cannot tell "what is the capital of
        // peru" (finished) from "I want you to" (obviously not).
        private const val ENDPOINT_SILENCE_S = 0.35f
        // Ceiling for an utterance the detector thinks is INCOMPLETE. If he
        // genuinely trailed off mid-sentence we still have to answer something,
        // so this is the point where we stop waiting and commit anyway.
        private const val INCOMPLETE_MAX_WAIT_MS = 1400L

        // FLOW MODE. Another turn committed this recently means he is still
        // talking - explaining something, not asking a series of questions.
        private const val FLOW_WINDOW_MS = 2500L
        // While in flow, a grammatically complete clause is NOT enough to commit;
        // he has to actually stop. Measured need: one monologue produced eleven
        // commits and PAN answered nine of them ("Right." / "Understood." /
        // "Got it.") while he was mid-explanation, because every clause he
        // finished looked like a finished turn. A clause boundary is not a turn
        // boundary. The first utterance still commits at ENDPOINT_SILENCE_S.
        private const val FLOW_SILENCE_MS = 1100L
        // Silence with no speech in it at all. Longer, so a pause before you
        // actually start talking is not treated as a finished sentence.
        private const val ENDPOINT_SILENCE_NO_SPEECH_S = 2.4f
        // Hard ceiling on a single utterance so one long ramble still commits.
        private const val ENDPOINT_MAX_UTTERANCE_S = 20.0f

        // Smart Turn's window: it listens to the last 8 s of the current turn.
        private const val TURN_AUDIO_MAX = 8 * SAMPLE_RATE
        // Longest we wait for a verdict before deciding on the words alone. The
        // model takes tens of ms; this only fires if the phone is badly loaded,
        // and it is logged when it does, so a slow model can never go unnoticed
        // or leave him hanging.
        private const val TURN_JUDGE_TIMEOUT_MS = 800L

        // Echo window. GoogleStreamingStt needs 8000ms because its finals land
        // 4-5s after PAN speaks - it waits out its own silence timeout first.
        // Here a final lands ~1s after the audio ends, so the window to catch
        // PAN's own voice coming back through the speaker is much tighter, and a
        // tighter window is less likely to eat a genuine follow-up that happens
        // to reuse PAN's words.
        private const val TTS_ECHO_WINDOW_MS = 3000L

        // 70M zipformer, not the 20M one this started on. The small model
        // turned "what do you think I should do today" into "but do you think i
        // should do to day" and heard "'s all my computer on my honest meant"
        // out of a real sentence. 27MB more, downloaded not bundled, and the
        // APK does not grow either way.
        private const val MODEL_REPO =
            "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/main"
        // Verified sizes, so a truncated download cannot masquerade as a good one.
        private val MODEL_FILES = mapOf(
            "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx" to 71_083_163L,
            "decoder-epoch-99-avg-1-chunk-16-left-128.onnx"      to  2_092_621L,
            "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx"  to    259_335L,
            "tokens.txt"                                         to      5_048L,
            "silero_vad.onnx"                  to  1_807_522L,
        )

        // Silero speaks in 512-sample windows at 16kHz (32ms). Not a free choice.
        private const val VAD_WINDOW = 512
        private const val VAD_THRESHOLD = 0.5f
        // Keep feeding this long after speech drops. MUST exceed
        // ENDPOINT_SILENCE_S or the recogniser never sees the trailing
        // silence that tells it the thought ended, and nothing ever commits.
        private const val VAD_HANGOVER_MS = 1500L
        // Sustained speech required to call it an interruption while PAN is
        // talking. Raised from 400ms: PAN's own voice sustains far longer than
        // that, so 400 was satisfied by the echo itself.
        private const val BARGE_IN_SPEECH_MS = 700L

        // A VAD CANNOT TELL PAN'S VOICE FROM HIS. Both are speech, and Silero is
        // right to say so - the echo left after AEC is quieter, not less speechy.
        // That is why VAD-alone cut PAN off on every reply, and why BargeInMonitor
        // needed energy: he is close to the microphone and the residual is not.
        // These three numbers are BargeInMonitor's, which were tuned on this exact
        // handset after it kept interrupting itself.
        //
        // Measure the residual for this long after TTS starts, before trusting
        // any level. AEC needs time to converge; judging earlier under-measures
        // the worst-case bleed and every hard consonant then reads as a person.
        private const val CALIBRATION_MS = 1200L
        // He has to exceed the measured residual by this much.
        private const val BARGE_IN_HEADROOM = 2.2f
        // Floor, so near-silence during TTS cannot produce a tiny threshold that
        // anything clears. 500/32768 in the 16-bit units BargeInMonitor used.
        private const val BARGE_IN_MIN_RMS = 500f / 32768f
        // Pre-roll kept so the words that INTERRUPT are not lost: the
        // recogniser is not being fed while PAN speaks, so without this the
        // first half-second of the interruption would be gone.
        private const val PREROLL_MS = 600L
    }

    // Words a finished sentence does not end on. Kept deliberately small and
    // obvious - a long list starts guessing, and a wrong 'incomplete' only costs
    // INCOMPLETE_MAX_WAIT_MS while a wrong 'complete' truncates him mid-sentence.
    private val DANGLING = setOf(
        "a", "an", "the", "my", "your", "our", "their", "his", "her",
        "to", "of", "in", "on", "at", "for", "with", "from", "by", "into", "about",
        "and", "or", "but", "so", "because", "if", "when", "while", "that", "than",
        "is", "are", "was", "were", "be", "been", "am", "do", "does", "did",
        "can", "could", "will", "would", "should", "shall", "may", "might", "must",
        "have", "has", "had",
        "very", "really", "just", "uh", "um", "er",
        // NOT pronouns. "how old are you" and "what about you" end on one and are
        // finished; holding them cost 1428ms and he repeated himself, so the
        // recogniser heard "how old are you how old are you". A dangling SUBJECT
        // pronoun cannot be told from a trailing object pronoun by last word alone,
        // and a wrong "incomplete" is the more visible failure.
        // NOT "like" either - "what is it like" is a complete question.
    )

    private val modelDir = File(context.filesDir, "asr-model")

    // NO SHARED NATIVE HANDLES.
    //
    // These were fields, and rapid mute-toggling proved why that is fatal: a
    // second read loop started before the first had exited, overwrote them, and
    // then one loop released what the other was still calling into. The logs
    // showed it plainly - two "streaming (continuous...)" lines two seconds
    // apart on different threads - and the process died with
    //   Scudo ERROR: invalid chunk state when deallocating  (Vad_compute)
    // and then a SIGSEGV. Every handle now lives as a local inside the
    // coroutine that uses it, so two loops cannot see each other's memory even
    // if they briefly overlap.

    private var readJob: Job? = null

    private var callback: ((String, Boolean) -> Unit)? = null
    private var _enabled = true
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override var isListening: Boolean = false
        private set

    // The entire point of this engine.
    override val listensThroughTts = true

    override var onLog: ((String) -> Unit)? = null
    override var isTtsSpeaking: (() -> Boolean)? = null
    override var onInterrupt: (() -> Unit)? = null
    @Volatile override var queryPending: Boolean = false

    override var enabled: Boolean
        get() = _enabled
        set(value) {
            _enabled = value
            if (!value) stopListening()
            else if (!isListening && callback != null) startListening(callback!!)
        }

    /**
     * The word half of "has he finished a thought?". Smart Turn is the other half.
     *
     * This used to be the whole decision, on the assumption that the real turn
     * models were too heavy for the phone - LiveKit's is a 165MB Qwen fine-tune
     * with a BPE tokenizer. Smart Turn v3.2 turned out to be 8.7MB and to take
     * AUDIO, not text, so it now runs on every pause (see SmartTurn.kt).
     *
     * This rule is KEPT as a veto, not replaced. Hesitant fragments are exactly
     * where these models are least sure - the int8 build scored "I want you to"
     * anywhere from 0.25 to 0.63 depending on the runtime - and a sentence cannot
     * end on "to" whatever a model says. A wrong 'finished' cuts him off
     * mid-sentence; a wrong 'unfinished' only costs INCOMPLETE_MAX_WAIT_MS. So a
     * turn commits only when the model says done AND the last word is not dangling.
     */
    private fun isTurnComplete(text: String): Boolean {
        val words = text.lowercase().trim()
            .replace(Regex("[^a-z0-9' ]"), " ")
            .split(Regex("\\s+")).filter { it.isNotBlank() }
        if (words.isEmpty()) return false
        // Nothing can follow these and still be the same sentence ending here.
        if (words.last() in DANGLING) return false
        // "how much is", "i want to go" - a two-word fragment ending on a verb
        // particle is still mid-thought even though the last word is not dangling.
        if (words.size >= 2 && words[words.size - 2] in DANGLING && words.size < 4) return false
        return true
    }

    private fun log(msg: String) {
        Log.i(TAG, msg)
        onLog?.invoke("[STT] $msg")
    }

    // ---- echo bookkeeping ---------------------------------------------------
    // Same approach GoogleStreamingStt already uses and which is proven on this
    // phone: remember what PAN said, and subtract it if it comes back.
    private val recentTtsOutput = mutableListOf<String>()
    private val ttsTimestamps = mutableListOf<Long>()

    override fun registerTtsOutput(text: String) {
        val lower = text.lowercase().trim()
        recentTtsOutput.add(lower)
        ttsTimestamps.add(System.currentTimeMillis() + lower.split("\\s+".toRegex()).size * 80L)
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
                        matched.add(j); break
                    }
                }
            }
            if (matched.size > ttsWords.size * 0.8) {
                result = resultWords.filterIndexed { k, _ -> k !in matched }.joinToString(" ").trim()
            }
        }
        val remaining = result.split("\\s+".toRegex()).filter { it.length > 1 }
        return if (remaining.size < 2) "" else result
    }

    // ---- model --------------------------------------------------------------

    /** True when every model file is present AND the right size. */
    fun isModelReady(): Boolean =
        MODEL_FILES.all { (name, size) -> File(modelDir, name).length() == size }

    /**
     * Fetch the model once. Mirrors PiperTtsEngine's download: .tmp then rename,
     * so a half-finished file never looks like a usable model.
     */
    suspend fun downloadModel(onProgress: ((Float) -> Unit)? = null): Boolean =
        withContext(Dispatchers.IO) {
            if (isModelReady()) return@withContext true
            modelDir.mkdirs()
            val total = MODEL_FILES.values.sum()
            var done = 0L
            for ((name, size) in MODEL_FILES) {
                val dest = File(modelDir, name)
                if (dest.length() == size) { done += size; continue }
                log("downloading $name (${size / 1_048_576}MB)")
                try {
                    val tmp = File(modelDir, "$name.tmp")
                    URL("$MODEL_REPO/$name").openConnection().apply {
                        connectTimeout = 15000; readTimeout = 60000
                    }.getInputStream().use { input ->
                        FileOutputStream(tmp).use { output ->
                            val buf = ByteArray(8192)
                            var n: Int
                            while (input.read(buf).also { n = it } != -1) {
                                output.write(buf, 0, n)
                                done += n
                                onProgress?.invoke(done.toFloat() / total)
                            }
                        }
                    }
                    tmp.renameTo(dest)
                } catch (e: Exception) {
                    log("download FAILED for $name: ${e.message}")
                    return@withContext false
                }
            }
            val ok = isModelReady()
            log(if (ok) "model ready" else "model incomplete after download")
            ok
        }

    private val turnModelFile get() = File(modelDir, SmartTurn.MODEL_FILE)
    private val turnModelDownloading = AtomicBoolean(false)

    /**
     * Fetch Smart Turn in the background. It never blocks the recogniser: until
     * it lands, turns are judged on the words alone, exactly as before, and the
     * read loop picks the model up the moment the file is complete.
     */
    private fun ensureSmartTurnModel() {
        if (turnModelFile.length() == SmartTurn.MODEL_BYTES) return
        if (!turnModelDownloading.compareAndSet(false, true)) return
        scope.launch {
            try {
                modelDir.mkdirs()
                log("downloading smart-turn (${SmartTurn.MODEL_BYTES / 1_048_576}MB)")
                val tmp = File(modelDir, "${SmartTurn.MODEL_FILE}.tmp")
                URL(SmartTurn.MODEL_URL).openConnection().apply {
                    connectTimeout = 15000; readTimeout = 60000
                }.getInputStream().use { input -> FileOutputStream(tmp).use { input.copyTo(it) } }
                if (tmp.length() == SmartTurn.MODEL_BYTES && tmp.renameTo(turnModelFile)) {
                    log("smart-turn ready")
                } else {
                    log("smart-turn download wrong size (${tmp.length()}) - discarded")
                    tmp.delete()
                }
            } catch (e: Exception) {
                log("smart-turn download FAILED: ${e.message}")
            } finally {
                turnModelDownloading.set(false)
            }
        }
    }

    private fun buildRecognizer(): OnlineRecognizer {
        val cfg = OnlineRecognizerConfig(
            featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
            modelConfig = OnlineModelConfig(
                transducer = OnlineTransducerModelConfig(
                    encoder = File(modelDir, "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx").absolutePath,
                    decoder = File(modelDir, "decoder-epoch-99-avg-1-chunk-16-left-128.onnx").absolutePath,
                    joiner  = File(modelDir, "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx").absolutePath,
                ),
                tokens = File(modelDir, "tokens.txt").absolutePath,
                numThreads = 2,
                // Left empty on purpose: sherpa reads the model type out of the
                // encoder's own onnx metadata. Hard-coding it here is how you get
                // a runtime failure after swapping to a different checkpoint.
                modelType = "",
            ),
            endpointConfig = EndpointConfig(
                rule1 = EndpointRule(false, ENDPOINT_SILENCE_NO_SPEECH_S, 0.0f),
                rule2 = EndpointRule(true, ENDPOINT_SILENCE_S, 0.0f),
                rule3 = EndpointRule(false, 0.0f, ENDPOINT_MAX_UTTERANCE_S),
            ),
            enableEndpoint = true,
            decodingMethod = "greedy_search",
        )
        return OnlineRecognizer(config = cfg)
    }

    private fun buildVad(): Vad = Vad(
        config = VadModelConfig(
            sileroVadModelConfig = SileroVadModelConfig(
                model = File(modelDir, "silero_vad.onnx").absolutePath,
                threshold = VAD_THRESHOLD,
                minSilenceDuration = 0.25f,
                minSpeechDuration = 0.20f,
                windowSize = VAD_WINDOW,
            ),
            sampleRate = SAMPLE_RATE,
            numThreads = 1,
        )
    )

    // ---- listening ----------------------------------------------------------

    @SuppressLint("MissingPermission")
    override fun startListening(onResult: (String, Boolean) -> Unit) {
        // isListening only becomes true INSIDE the coroutine, after the model
        // loads, so it cannot guard the gap between this call and that point.
        // The previous job is the real interlock.
        if (!_enabled) return
        callback = onResult

        val previous = readJob
        readJob = scope.launch {
            // Wait out the old loop before touching audio or the models. This is
            // what makes "two loops at once" impossible rather than unlikely.
            runCatching { previous?.cancelAndJoin() }
            if (!isModelReady()) {
                log("model not present - downloading (~45MB, once)")
                if (!downloadModel()) { log("cannot start: no model"); return@launch }
            }

            ensureSmartTurnModel()

            val rec = try {
                buildRecognizer()
            } catch (e: Exception) {
                log("recognizer init FAILED: ${e.message}"); return@launch
            }
            // (rec is local; nothing outside this coroutine may see it)
            val vad = try {
                buildVad()
            } catch (e: Exception) {
                log("VAD init FAILED: ${e.message}"); return@launch
            }
            val st = rec.createStream("")
            // (st is local too)

            // VOICE_COMMUNICATION + hardware AEC: the same combination
            // BargeInMonitor already proved on this phone. It is what makes it
            // possible to leave the microphone open while the speaker is playing.
            val minBuf = AudioRecord.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
            // VOICE_COMMUNICATION. Do not change this again without a way to test
            // echo on a real device first.
            //
            // It was switched to VOICE_RECOGNITION to try to fix transcription
            // accuracy - that source applies far less processing, and the
            // telephony chain's AEC/NS/AGC does chew up consonant detail. It was
            // also immediately and completely wrong: AcousticEchoCanceler still
            // ATTACHES on VOICE_RECOGNITION, but that path does not give it the
            // speaker reference signal, so it cancels nothing. PAN heard its own
            // voice, the VAD correctly called it speech, barge-in fired, and it
            // cut itself off on every reply after the first.
            //
            // The echo cancellation is load-bearing for an always-open mic. It is
            // worth more than the accuracy it costs, so accuracy has to come from
            // somewhere else - a better acoustic model, not a rawer signal.
            val recorder = try {
                AudioRecord(
                    MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                    SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, minBuf * 4
                )
            } catch (e: Exception) {
                log("AudioRecord init FAILED: ${e.message}"); return@launch
            }
            if (recorder.state != AudioRecord.STATE_INITIALIZED) {
                log("AudioRecord not initialised"); recorder.release(); return@launch
            }
            // (recorder is local too)

            // Local, like everything else native in here.
            var aec: AcousticEchoCanceler? = null
            if (AcousticEchoCanceler.isAvailable()) {
                runCatching {
                    aec = AcousticEchoCanceler.create(recorder.audioSessionId)?.also { it.enabled = true }
                }.onSuccess { if (aec != null) log("AEC attached") }
            }
            // NoiseSuppressor deliberately NOT attached. It is tuned for making
            // speech pleasant to a listener, and it removes exactly the low-energy
            // consonant detail an acoustic model leans on. Kept as a field so it
            // can be switched back on in one line if the room turns out to need it
            // more than the model does.

            recorder.startRecording()
            isListening = true
            log("streaming (continuous, endpoint ${ENDPOINT_SILENCE_S}s)")

            // AudioRecord.read() may return FEWER samples than asked for, and
            // Silero's ONNX graph has a fixed 512-sample input - handing it a
            // short frame threw
            //   Vad_compute: Invalid input shape: {254}
            // which killed the read loop, and every later call then failed with
            // "NULL input supplied for input h" because the VAD's recurrent
            // state was left half-updated. That is the microphone dying
            // mid-conversation. So reads are accumulated and the VAD is only
            // ever given whole windows; the remainder carries to the next read.
            val shorts = ShortArray(VAD_WINDOW)
            val carry = FloatArray(VAD_WINDOW * 2)
            var carried = 0
            val window = FloatArray(VAD_WINDOW)
            var lastPartial = ""

            // Rolling pre-roll of recent audio. While PAN is speaking the
            // recogniser is NOT being fed, so without this the opening words of
            // an interruption would be gone by the time we noticed it.
            val prerollMax = (PREROLL_MS / 32).toInt().coerceAtLeast(1)
            val preroll = ArrayDeque<FloatArray>()

            var lastSpeechAt = 0L      // last window the VAD called speech
            var speechRunStart = 0L    // start of the current unbroken speech run
            var barged = false         // already interrupted this TTS turn
            var gateOpen = false       // was the recogniser being fed last window
            var heldIncomplete = false // logged the hold once for this utterance
            var lastCommitAt = 0L      // when a turn was last handed to the service
            var ttsStartedAt = 0L      // when the current TTS playback began
            var residualPeak = 0f      // loudest echo seen during calibration

            // ---- Smart Turn ----
            // The audio of the CURRENT turn - exactly what the recogniser has been
            // fed since the last commit - so the model hears what was transcribed.
            val turnAudio = FloatArray(TURN_AUDIO_MAX)
            var turnLen = 0
            fun feed(w: FloatArray) {
                st.acceptWaveform(w, SAMPLE_RATE)
                val over = turnLen + w.size - TURN_AUDIO_MAX
                if (over > 0) {
                    System.arraycopy(turnAudio, over, turnAudio, 0, turnLen - over)
                    turnLen -= over
                }
                System.arraycopy(w, 0, turnAudio, turnLen, w.size)
                turnLen += w.size
            }
            // Local like every other native handle here; closed in finally, and only
            // after any inference still running on it has returned.
            var turnModel: SmartTurn? = null
            var turnModelFailed = false
            fun turnModelOrNull(): SmartTurn? {
                if (turnModel != null || turnModelFailed) return turnModel
                if (turnModelFile.length() != SmartTurn.MODEL_BYTES) return null
                turnModel = try {
                    SmartTurn(turnModelFile).also { log("smart-turn loaded") }
                } catch (e: Exception) {
                    turnModelFailed = true
                    log("smart-turn init FAILED (${e.message}) - judging turns on words alone")
                    null
                }
                return turnModel
            }
            // One verdict per PAUSE, keyed on when he last spoke. isEndpoint() stays
            // true for every 32 ms window of a pause; running the model on each would
            // be ~30 inferences a second for the same audio. And it runs OFF this
            // thread: AudioRecord's buffer holds ~160 ms, so inference inline would
            // drop the first words he says after the pause - the exact thing this
            // engine exists to stop doing.
            var judge: Deferred<Float>? = null
            var judgeFor = -1L         // lastSpeechAt the in-flight verdict is about
            var judgeStarted = 0L
            var judgedFor = -1L        // lastSpeechAt the current verdict is about
            var verdict = -1f          // Smart Turn probability for that pause
            var slowLoggedFor = -1L    // pause we already reported a slow verdict for

            try {
                while (isActive && isListening) {
                    val n = recorder.read(shorts, 0, shorts.size)
                    if (n <= 0) continue
                    for (i in 0 until n) {
                        if (carried < carry.size) carry[carried++] = shorts[i] / 32768.0f
                    }
                    if (carried < VAD_WINDOW) continue
                    System.arraycopy(carry, 0, window, 0, VAD_WINDOW)
                    carried -= VAD_WINDOW
                    if (carried > 0) System.arraycopy(carry, VAD_WINDOW, carry, 0, carried)
                    val frame = window.copyOf()

                    // The VAD runs on EVERY window, always. It is the thing that
                    // decides whether any of this is speech at all. Feeding the
                    // recogniser ungated is what made it decode room noise into
                    // sentences like "company bone have been not a pulling".
                    val isSpeech = try {
                        (vad?.compute(frame) ?: 0f) >= VAD_THRESHOLD
                    } catch (e: Exception) {
                        // Never let one bad window take the microphone down with
                        // it - going deaf is far worse than misjudging 32ms.
                        log("VAD window failed (${e.message}) — treating as speech")
                        true
                    }
                    val now = System.currentTimeMillis()
                    if (isSpeech) {
                        if (speechRunStart == 0L) speechRunStart = now
                        lastSpeechAt = now
                    } else {
                        speechRunStart = 0L
                    }

                    preroll.addLast(frame)
                    while (preroll.size > prerollMax) preroll.removeFirst()

                    // Level of this window, used only to separate him from the echo.
                    var sumSq = 0.0
                    for (v in frame) sumSq += v.toDouble() * v
                    val rms = kotlin.math.sqrt(sumSq / frame.size).toFloat()

                    val ttsOn = isTtsSpeaking?.invoke() == true
                    if (!ttsOn) {
                        barged = false
                        ttsStartedAt = 0L
                        residualPeak = 0f
                    } else if (ttsStartedAt == 0L) {
                        ttsStartedAt = now
                        residualPeak = 0f
                    }

                    if (ttsOn && !barged) {
                        // PAN is talking. Do not transcribe - what reaches the mic
                        // here is AEC residual of PAN's own voice, and decoding it
                        // produces garbage that no echo filter can match back.
                        // Watch the VAD instead: a sustained run of confident
                        // speech through a converged AEC is a person talking over
                        // PAN. This is what BargeInMonitor did with a hand-tuned
                        // energy threshold; a neural VAD is the same idea without
                        // the four constants that had to keep being nudged.
                        // Learn how loud PAN's own bleed is, then require him to be
                        // clearly louder than it for a sustained stretch.
                        if (now - ttsStartedAt < CALIBRATION_MS) {
                            if (rms > residualPeak) residualPeak = rms
                            continue
                        }
                        val threshold = maxOf(residualPeak * BARGE_IN_HEADROOM, BARGE_IN_MIN_RMS)
                        if (rms < threshold) {
                            // Speech, but no louder than the echo already is. That is
                            // PAN, not him.
                            speechRunStart = 0L
                            continue
                        }
                        if (speechRunStart != 0L && now - speechRunStart >= BARGE_IN_SPEECH_MS) {
                            barged = true
                            log("barge-in: ${now - speechRunStart}ms of speech at rms " +
                                "%.4f over threshold %.4f (residual %.4f)".format(rms, threshold, residualPeak))
                            onInterrupt?.invoke()
                            for (w in preroll) feed(w)
                        }
                        continue
                    }

                    // Gate. Stays open through the hangover so the recogniser
                    // still sees the trailing silence that fires its endpoint.
                    val open = now - lastSpeechAt <= VAD_HANGOVER_MS
                    if (!open) { gateOpen = false; continue }

                    // FIRST WORDS. Silero will not call it speech until it has
                    // heard ~200ms of it, and the gate cannot open before that,
                    // so the opening of every sentence is already in the past by
                    // the time we start feeding. That is the "it always misses
                    // the first two or three words" symptom, and it is not the
                    // model's fault - the audio was captured, we were throwing it
                    // away. The pre-roll has it. Feed it in.
                    if (!gateOpen) {
                        gateOpen = true
                        for (w in preroll) if (w !== frame) feed(w)
                    }

                    feed(frame)
                    while (rec.isReady(st)) rec.decode(st)

                    val endpoint = rec.isEndpoint(st)
                    val text = rec.getResult(st).text.trim()

                    // Collect a finished verdict. One that finished after he started
                    // talking again is about a pause that is over - drop it.
                    judge?.let { j ->
                        if (j.isCompleted) {
                            val p = runCatching { j.getCompleted() }.getOrElse {
                                log("smart-turn inference FAILED (${it.message})"); -1f
                            }
                            // A failed call still SETTLES the pause (verdict -1 = none).
                            // Leaving it unjudged would relaunch the model on every
                            // 32 ms window of the same pause, forever.
                            if (judgeFor == lastSpeechAt) {
                                verdict = p
                                judgedFor = judgeFor
                                if (p >= 0f) log("smart-turn p=%.2f in %dms".format(p, now - judgeStarted))
                            }
                            judge = null
                        }
                    }

                    if (endpoint) {
                        // A candidate end-of-turn, not necessarily the end of a turn.
                        val waited = now - lastSpeechAt

                        // Ask the model about THIS pause, once.
                        val model = if (text.isBlank()) null else turnModelOrNull()
                        if (model != null && judgedFor != lastSpeechAt && judge == null) {
                            val snap = turnAudio.copyOf(turnLen)
                            judgeFor = lastSpeechAt
                            judgeStarted = now
                            judge = scope.async(Dispatchers.Default) { model.probability(snap) }
                        }
                        val awaiting = model != null && judgedFor != lastSpeechAt
                        // Measured from the PAUSE, not from judgeStarted: a stale call
                        // for an earlier pause may still be the one in flight.
                        val timedOut = awaiting &&
                            waited > (ENDPOINT_SILENCE_S * 1000).toLong() + TURN_JUDGE_TIMEOUT_MS
                        if (timedOut && slowLoggedFor != lastSpeechAt) {
                            slowLoggedFor = lastSpeechAt
                            log("smart-turn slow (>${TURN_JUDGE_TIMEOUT_MS}ms) - deciding on words alone")
                        }
                        val modelDone = when {
                            model == null -> true            // not downloaded yet / no text
                            judgedFor == lastSpeechAt -> verdict < 0f || verdict >= SmartTurn.THRESHOLD
                            else -> true                     // timed out
                        }
                        val complete = text.isBlank() || (isTurnComplete(text) && modelDone)
                        val pTag = when {
                            model == null || judgedFor != lastSpeechAt -> ""
                            verdict < 0f -> " p=none"
                            else -> " p=%.2f".format(verdict)
                        }

                        if (awaiting && !timedOut) {
                            // Verdict not in yet - it is tens of ms away. Keep
                            // listening; the next window decides.
                        } else {
                            // How long a pause this particular moment requires.
                            val inFlow = lastCommitAt != 0L && (now - lastCommitAt) < FLOW_WINDOW_MS
                            val needed = when {
                                !complete -> INCOMPLETE_MAX_WAIT_MS
                                inFlow    -> FLOW_SILENCE_MS
                                else      -> 0L
                            }
                            if (waited < needed) {
                                // Mid-thought pause. Do NOT reset - keep the stream open so
                                // the rest of the sentence appends to what he already said
                                // instead of arriving as a separate, headless utterance.
                                if (!heldIncomplete) {
                                    heldIncomplete = true
                                    log(if (complete) "holding, still talking$pTag: ...${text.takeLast(24)}"
                                        else "holding, sounds unfinished$pTag: ...${text.takeLast(24)}")
                                }
                            } else {
                                log("commit after ${waited}ms$pTag")
                                heldIncomplete = false
                                lastCommitAt = now
                                rec.reset(st)
                                turnLen = 0
                                lastPartial = ""
                                if (text.isNotBlank()) {
                                    val clean = stripEcho(text)
                                    if (clean.isBlank()) log("echo discarded: ${text.take(40)}")
                                    else withContext(Dispatchers.Main) { callback?.invoke(clean, true) }
                                }
                            }
                        }
                    } else if (text.isNotBlank() && text != lastPartial) {
                        heldIncomplete = false
                        lastPartial = text
                        withContext(Dispatchers.Main) { callback?.invoke(text, false) }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log("read loop error: ${e.message}")
            } finally {
                // NATIVE LIFETIME BELONGS TO THIS COROUTINE.
                //
                // stopListening() used to free these itself, right after
                // readJob?.cancel(). cancel() does not WAIT - so the loop could be
                // inside vad.compute() when the Vad was released underneath it, and
                // the process died with
                //   SIGABRT / Scudo ERROR: invalid chunk state when deallocating
                //   #07 Java_com_k2fsa_sherpa_onnx_Vad_compute
                // A use-after-free across the JNI boundary, made likely by muting,
                // which is exactly what he had been doing all afternoon.
                //
                // Releasing here means it cannot run until the loop has actually
                // left compute(). Whoever uses a native handle owns its lifetime.
                // The model may still be mid-inference on another thread. Wait for
                // that call to return before closing the session it is using.
                withContext(NonCancellable) { runCatching { judge?.join() } }
                runCatching { turnModel?.close() }
                runCatching { recorder.stop() }
                runCatching { recorder.release() }
                runCatching { aec?.release() }
                runCatching { st.release() }
                runCatching { vad.release() }
                runCatching { rec.release() }
                isListening = false
                log("released")
            }
        }
    }

    override fun destroy() {
        stopListening()
        scope.cancel()
    }

    /**
     * Signals only. Frees nothing.
     *
     * Every native handle here is freed in the read loop's finally block, because
     * cancel() returns immediately and the loop may still be inside a JNI call.
     * Freeing from this side is what crashed the process with a Scudo
     * invalid-chunk-state abort inside Vad_compute.
     */
    override fun stopListening() {
        isListening = false
        readJob?.cancel()
        readJob = null
        log("stopping")
    }
}
