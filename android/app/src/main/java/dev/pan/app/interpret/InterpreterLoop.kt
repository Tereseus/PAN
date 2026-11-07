package dev.pan.app.interpret

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig
import com.k2fsa.sherpa.onnx.SpokenLanguageIdentification
import com.k2fsa.sherpa.onnx.SpokenLanguageIdentificationConfig
import com.k2fsa.sherpa.onnx.SpokenLanguageIdentificationWhisperConfig
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.pan.app.debug.VoiceEvents
import dev.pan.app.stt.TurnEar
import dev.pan.app.translate.QuickMt
import dev.pan.app.util.CpuBoost
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.CompletableFuture
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The interpreter's own loop: hear, translate, speak, all on the phone. No hub, no language
 * model, no prompt. In a live test the hub path took 3.0 s from his last word to the voice: 0.86 s
 * deciding he had finished, 0.75 s to upload and read the words, 1.23 s for the cloud, 0.15 s for
 * the voice (2026-11-05). Here reading a line takes about 60 ms and translating it about 100 ms,
 * and both start at the first silence, while the end of turn is still being decided, so what is
 * left is the decision and the voice. If he carries on, the work is thrown away and nobody has
 * heard anything. Nothing here fills the gap: PAN speaks when it has the translation.
 *
 * The ear decides the direction: the other language goes into English for him, his English goes
 * into the other language. SenseVoice names the language it heard, for its five. A language with
 * an ear of its own (OWN_EAR) can only write that language, so there Whisper tiny says whether a
 * line was English, while the ear reads it as if it were not. A line the loop cannot do alone goes
 * to the hub as a normal turn: "stop translating", "ask them how much this costs", anything with
 * PAN's name on it.
 *
 * Each person comes out in their own voice (VoiceBook). A phone without the voice print model
 * still interprets, in one voice.
 *
 * The hub still decides when interpreting starts and stops, and tells the phone (the "interpreter"
 * event). If the models are not on the phone begin() says no, and the hub path carries on.
 */
@Singleton
class InterpreterLoop @Inject constructor(
    @ApplicationContext private val context: Context
) : TurnEar {

    companion object {
        private const val TAG = "Interpreter"
        // Measured on the Pixel 10 Pro: 4 threads read 1.4 to 3.6 s of speech in 47 to 83 ms, 6
        // threads took 68 to 129 ms: the two slow cores hold the rest back.
        private const val EAR_THREADS = 4
        // A line in about 130 ms either way, but 4 threads had a worst line of 758 ms against 328.
        private const val MT_THREADS = 2
        private const val BEAM = 4
        private const val SAMPLE_RATE = 16000
        private val SENSEVOICE = setOf("ja", "zh", "ko", "yue")
        private val NO_SPACES = setOf("ja", "zh", "yue")
        private val OTHER_SCRIPTS = setOf("ja", "zh", "yue", "ko", "el")
        // A piece of a line goes to the other person's PAN at a pause, if it can stand alone.
        private const val PIECE_MIN_WORDS = 4
        private val PIECE_CANNOT_END = setOf("a", "an", "the", "my", "your", "our", "their", "his", "her", "to", "of",
            "in", "on", "at", "for", "with", "from", "by", "and", "or", "but", "so", "because", "that", "if", "when", "i", "you",
            "we", "they", "he", "she", "it", "is", "are", "was", "were", "am", "do", "does", "did", "have", "has", "will", "would")
        // A language with its own ear, by folder. Parakeet v3 itself got 45% of real Greek words
        // wrong on the phone (FLEURS, 2026-11-05): it has no final sigma, so it drops the letter,
        // and it wandered into Latin and Cyrillic letters on short lines. The Greek fine-tune
        // (myned-ai, CC-BY-4.0) cannot.
        private val OWN_EAR = mapOf("el" to "parakeetel")
        // Whisper tiny's language guess: 93 ms for any line, because it always reads 30 s. It said
        // "en" for 11 of 11 English lines and for none of 30 real Greek ones.
        private const val LID_THREADS = 4
        // Beside the translator, which takes longer: 42 ms for 2 s of speech, 94 for 5 s on 2 threads.
        private const val PRINT_THREADS = 2
        // Supertonic voices, in the order people turn up. The owner picked 9 and 6 by ear
        // (2026-11-06). 3 and 1 are the furthest from those two by voice print: not heard yet.
        private val VOICES = intArrayOf(9, 6, 3, 1)

        // The Greek ear keeps these two in float: they are small, and they are its whole vocabulary.
        private fun either(dir: File, name: String) =
            File(dir, "$name.int8.onnx").takeIf { it.exists() } ?: File(dir, "$name.onnx")

        fun buildLid(dir: File, threads: Int) = SpokenLanguageIdentification(null, SpokenLanguageIdentificationConfig(
            whisper = SpokenLanguageIdentificationWhisperConfig(
                encoder = File(dir, "tiny-encoder.int8.onnx").absolutePath,
                decoder = File(dir, "tiny-decoder.int8.onnx").absolutePath),
            numThreads = threads, debug = false, provider = "cpu"))

        /** One of the two ears, for this phone's cores. Also used by InterpretBench. */
        fun buildEar(dir: File, sense: Boolean, threads: Int): OfflineRecognizer = OfflineRecognizer(
            config = OfflineRecognizerConfig(
                featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
                modelConfig = if (sense) OfflineModelConfig(
                    senseVoice = OfflineSenseVoiceModelConfig(
                        model = File(dir, "model.int8.onnx").absolutePath,
                        language = "", useInverseTextNormalization = true),
                    tokens = File(dir, "tokens.txt").absolutePath,
                    numThreads = threads, debug = false, provider = "cpu")
                else OfflineModelConfig(
                    transducer = OfflineTransducerModelConfig(
                        encoder = File(dir, "encoder.int8.onnx").absolutePath,
                        decoder = either(dir, "decoder").absolutePath,
                        joiner = either(dir, "joiner").absolutePath),
                    tokens = File(dir, "tokens.txt").absolutePath, modelType = "nemo_transducer",
                    numThreads = threads, debug = false, provider = "cpu")))
        // Shorter than any real line, with its pre-roll. 0.22 s of the end of a clip, after PAN
        // had talked over the rest of it, came back as "Yeah." and PAN said it (2026-11-05).
        private const val MIN_SAMPLES = SAMPLE_RATE * 2 / 5
        // Under this, a line in a language its speaker has not been using is the ear's mistake:
        // the start of a Japanese line came back as "Thank you for' do that." (2026-11-06). Longer
        // than this, they really have switched.
        private const val SURE_OF_LANGUAGE_SAMPLES = SAMPLE_RATE * 3
        // PAN's own last line coming back through the microphone, as heard within this long.
        private const val ECHO_WINDOW_MS = 8000L

        private val STOP = Regex("\\b(?:stop|quit|end|cancel|enough)\\b.*\\b(?:translat|interpret)", RegexOption.IGNORE_CASE)
        private val TO_THEM = Regex("^\\W*(?:(?:so|okay|ok|now|please|and|just)\\W+)*(?:ask|tell|let)\\s+(?:them|her|him|the \\w+)\\b", RegexOption.IGNORE_CASE)
        private val TO_PAN = Regex("^\\W*(?:(?:hey|hi|ok|okay)\\W+)?(?:pan|pam)\\b", RegexOption.IGNORE_CASE)
        private val SAY_AGAIN = Regex("^\\W*(?:(?:so|okay|ok|now|please|and|just|can you|could you)\\s+)*(?:say|repeat)\\s+(?:that|it)(?:\\s+(?:again|one more time))?\\W*$", RegexOption.IGNORE_CASE)
        private val LETTERS = Regex("[^\\p{L}\\p{N}]+")
        private val SENTENCE_END = Regex("(?<=[.!?;。！？])\\s*")
        private val WARM_LINES = mapOf("ja" to "こんにちは、お元気ですか?", "el" to "Γεια σου, τι κάνεις;",
            "zh" to "你好,你好吗?", "ko" to "안녕하세요, 잘 지내세요?", "yue" to "你好,你好嗎?")
    }

    /** What was said, what to say, and the moment he stopped, for the card. */
    data class Line(val heard: String, val lang: String, val say: String, val stoppedAt: Long, val voice: Int? = null)

    var onLine: ((Line) -> Unit)? = null
    /** A translation, before anyone knows the turn is over. It may never be said. */
    var onDraft: ((String, Int?) -> Unit)? = null
    var onHandOver: ((String) -> Unit)? = null

    private class Heard(val text: String, val lang: String, val say: String?, val handOver: Boolean,
                        val who: VoiceBook.Pick? = null, val voice: Int? = null)

    // One thread: the models are not safe to close during a call, and two lines at once would
    // only slow each other down.
    @OptIn(ExperimentalCoroutinesApi::class)
    private val worker = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(worker + SupervisorJob())

    @Volatile private var language: String? = null
    private var ear: OfflineRecognizer? = null
    // Only for a language with its own ear: his English, and what tells it apart.
    private var english: OfflineRecognizer? = null
    private var lid: SpokenLanguageIdentification? = null
    private var book: VoiceBook? = null
    // The language each person last spoke in this talk. Only the worker touches it.
    private val usual = HashMap<Int, String>()
    private val models = HashMap<String, QuickMt.Model>()

    @Volatile private var pending: Pair<Long, Deferred<Heard?>>? = null
    // The newest pause. Set before its job starts, so a job can tell it has been overtaken.
    @Volatile private var latest = 0L
    @Volatile private var lastSaid = ""
    @Volatile private var lastSaidAt = 0L
    @Volatile private var lastVoice: Int? = null
    // What of the line being said has gone to the other person's PAN. Only the worker touches it.
    private var sentOfLine = ""
    // The turn that has been committed, so a late piece cannot follow its own end.
    @Volatile private var committed = 0L

    private val home: File? get() = context.getExternalFilesDir("interp")

    private fun modelDir(src: String, tgt: String) = File(home, "quickmt-$src-$tgt")

    private val senseDir: File? get() = File(home, "sensevoice").takeIf { File(it, "model.int8.onnx").exists() }
    private val lidDir: File? get() = File(home, "lid").takeIf { File(it, "tiny-encoder.int8.onnx").exists() }
    private val printModel: File? get() = File(home, "spk/model.onnx").takeIf { it.exists() }

    private fun earDir(lang: String): File? = when (lang) {
        in SENSEVOICE -> senseDir
        in OWN_EAR -> File(home, OWN_EAR[lang]!!).takeIf { File(it, "encoder.int8.onnx").exists() && senseDir != null && lidDir != null }
        else -> null
    }

    /** Whether this phone can do a language alone. */
    fun canDo(lang: String): Boolean =
        earDir(lang) != null && QuickMt.exists(modelDir("en", lang)) && QuickMt.exists(modelDir(lang, "en"))

    /** Loads the models for a language. True when the loop can take turns. */
    suspend fun begin(lang: String): Boolean = withContext(worker) {
        if (language == lang) return@withContext true
        release()
        if (!canDo(lang)) return@withContext false
        val t0 = SystemClock.elapsedRealtime()
        try {
            // At once: one after the other took 8 s, and the first lines went to the hub meanwhile.
            coroutineScope {
                val heard = async(Dispatchers.IO) { buildEar(earDir(lang)!!, lang in SENSEVOICE, EAR_THREADS) }
                val his = if (lang in OWN_EAR) async(Dispatchers.IO) { buildEar(senseDir!!, true, EAR_THREADS) } else null
                val which = if (lang in OWN_EAR) async(Dispatchers.IO) { buildLid(lidDir!!, LID_THREADS) } else null
                val out = async(Dispatchers.IO) { QuickMt.load(modelDir("en", lang), MT_THREADS) }
                val back = async(Dispatchers.IO) { QuickMt.load(modelDir(lang, "en"), MT_THREADS) }
                val prints = printModel?.let { async(Dispatchers.IO) { VoiceBook.build(it, PRINT_THREADS) } }
                ear = heard.await()
                english = his?.await()
                lid = which?.await()
                models["en>$lang"] = out.await() ?: error("no model en>$lang")
                models["$lang>en"] = back.await() ?: error("no model $lang>en")
                book = prints?.await()
            }
        } catch (e: Exception) {
            Log.e(TAG, "begin $lang failed: ${e.message}")
            release()
            return@withContext false
        }
        // The first line through each model is the slow one: 501 ms against about 150 (2026-11-05).
        // Better spent here than on the first thing he says.
        language = lang
        runCatching {
            hear(FloatArray(SAMPLE_RATE))
            english?.let { words(it, FloatArray(SAMPLE_RATE)) }
            models["en>$lang"]?.translate("Hello, how are you?", BEAM)
            models["$lang>en"]?.translate(WARM_LINES[lang] ?: "Hello.", BEAM)
            book?.pick(FloatArray(SAMPLE_RATE))
        }
        val ms = SystemClock.elapsedRealtime() - t0
        Log.i(TAG, "interpreting $lang on the phone, loaded in $ms ms")
        VoiceEvents.emit("interp_begin", "lang" to lang, "ms" to ms)
        true
    }

    fun end() {
        pending = null
        scope.launch { release() }
    }

    private fun release() {
        language = null
        runCatching { ear?.release() }
        ear = null
        runCatching { english?.release() }
        english = null
        runCatching { lid?.release() }
        lid = null
        runCatching { book?.release() }
        book = null
        usual.clear()
        lastVoice = null
        models.values.forEach { runCatching { it.close() } }
        models.clear()
    }

    /** What one ear made of it, and the language it says it heard. Null if nothing was said. */
    private fun words(rec: OfflineRecognizer, pcm: FloatArray): Pair<String, String>? {
        val s = rec.createStream()
        s.acceptWaveform(pcm, SAMPLE_RATE)
        rec.decode(s)
        val r = rec.getResult(s)
        s.release()
        val said = r.text.replace("<unk>", "").trim()
        if (said.none { it.isLetterOrDigit() }) return null
        val lang = r.lang.trim('<', '|', '>', ' ')
        // SenseVoice writes Japanese with spaces between the words, which nobody else does, and
        // the translator was trained on what people write.
        return (if (lang in NO_SPACES) said.replace(" ", "") else said) to lang
    }

    private fun heardEnglish(id: SpokenLanguageIdentification, pcm: FloatArray): Boolean {
        val s = id.createStream()
        s.acceptWaveform(pcm, SAMPLE_RATE)
        val lang = id.compute(s)
        s.release()
        return lang == "en"
    }

    private fun hear(pcm: FloatArray): Pair<String, String>? {
        val rec = ear ?: return null
        val id = lid
        val his = english
        if (id == null || his == null) return words(rec, pcm)
        val target = language ?: return null
        // One after the other. Side by side both slowed down: 340 to 610 ms for the pair, where
        // alone the check takes 120 and the ear 170, and this phone has few fast cores.
        if (heardEnglish(id, pcm)) return words(his, pcm)?.let { it.first to "en" }
        // The Greek ear writes questions with a Latin question mark.
        return words(rec, pcm)?.let { it.first.replace('?', ';') to target }
    }

    private fun mostlyLatin(s: String): Boolean {
        val latin = s.count { it in 'a'..'z' || it in 'A'..'Z' }
        return latin > s.count { it.isLetter() } - latin
    }

    private fun letters(s: String) = s.replace(LETTERS, "").lowercase()

    /** PAN's own line coming back: the same words, just after it said them. */
    private fun isEcho(text: String): Boolean {
        if (System.currentTimeMillis() - lastSaidAt > ECHO_WINDOW_MS) return false
        val a = letters(text)
        val b = letters(lastSaid)
        return a.length >= 2 && (b.contains(a) || a.contains(b))
    }

    private fun work(pcm: FloatArray, id: Long): Heard? {
        val target = language ?: return null
        // Queued behind a line that took a while, and he has talked on since: not worth starting.
        if (latest != id) return null
        if (pcm.size < MIN_SAMPLES) return Heard("", "", null, false)
        CpuBoost.burst(context)
        val t0 = SystemClock.elapsedRealtime()
        val (text, lang) = hear(pcm) ?: return Heard("", "", null, false)
        val t1 = SystemClock.elapsedRealtime()
        if (lang == "nospeech") return Heard("", "", null, false)
        // With a PAN on the other side, their words arrive as text. What the mic picks up of them
        // here is the same line again.
        if (PeerLink.on && lang != "en") return Heard("", "", null, false)
        if (isEcho(text)) {
            VoiceEvents.emit("interp_echo", "text" to text)
            return Heard("", "", null, false)
        }
        if (lang == "en" && (STOP.containsMatchIn(text) || TO_THEM.containsMatchIn(text) || TO_PAN.containsMatchIn(text)))
            return Heard(text, lang, null, true)
        if (lang == "en" && SAY_AGAIN.containsMatchIn(text)) return Heard(text, lang, lastSaid.ifBlank { null }, false, voice = lastVoice)
        // Anything but his English goes into English. A third language this phone has no model
        // for is the hub's: it has more ears.
        val key = if (lang == "en") "en>$target" else "$lang>en"
        val model = models[key]
        if (model == null) {
            // The ear can call mumbled English Chinese ("那个itch那个那个。", 2026-11-06), and the hub
            // then answers it in English. Someone already heard speaking English gets no such line.
            val who = book?.let { b -> runCatching { b.pick(pcm) }.getOrNull() }
            if (who != null && usual[who.person] == "en") {
                VoiceEvents.emit("interp_unsure", "lang" to lang, "text" to text, "person" to who.person)
                return Heard("", "", null, false)
            }
            return Heard(text, lang, null, true)
        }
        // Who said it needs only the sound, so it runs while the words are translated. Waited for
        // before this returns, so the book is never read while the worker changes it.
        val whoJob = book?.let { b -> CompletableFuture.supplyAsync { runCatching { b.pick(pcm) }.getOrNull() } }
        // One sentence at a time: that is what these models were trained on.
        val joiner = if (target in setOf("ja", "zh", "yue") && lang == "en") "" else " "
        val say = sentences(text, lang).mapNotNull { one(model, it.trim(), lang) }.joinToString(joiner)
        val tp = SystemClock.elapsedRealtime()
        val who = whoJob?.join()
        val voice = who?.let { VOICES[it.person.coerceAtMost(VOICES.size - 1)] }
        val t2 = SystemClock.elapsedRealtime()
        val theirs = who?.let { usual[it.person] }
        if (theirs != null && theirs != lang && pcm.size < SURE_OF_LANGUAGE_SAMPLES) {
            VoiceEvents.emit("interp_unsure", "lang" to lang, "usual" to theirs, "text" to text, "person" to who.person)
            return Heard("", "", null, false)
        }
        CpuBoost.done(t2 - t0)
        VoiceEvents.emit("interp_work", "ear_ms" to (t1 - t0), "mt_ms" to (tp - t1), "print_wait_ms" to (t2 - tp), "lang" to lang,
            "text" to text, "say" to say, "person" to who?.person, "likeness" to who?.likeness, "voice" to voice)
        // A word the translator does not know comes back in English letters, with junk after it
        // (a mangled greeting, 2026-11-06). The hub's model can do better.
        if (lang == "en" && target in OTHER_SCRIPTS && mostlyLatin(say)) return Heard(text, lang, null, true, who, voice)
        if (say.isNotBlank() && latest == id && !PeerLink.on) onDraft?.invoke(say, voice)
        return Heard(text, lang, say.ifBlank { null }, say.isBlank(), who, voice)
    }

    private fun bareEnd(s: String) = s.trimEnd { !it.isLetterOrDigit() }

    /** What he has said since the last piece went, or null if the ear changed what came before. */
    private fun unsent(text: String): String? =
        if (text.startsWith(sentOfLine, ignoreCase = true)) text.substring(sentOfLine.length).trimStart { !it.isLetterOrDigit() } else null

    /** He paused. If what is new can stand alone it goes now, while he carries on. */
    private fun sendPiece(h: Heard) {
        val target = language ?: return
        // Keeps its full stop: without one the translator wrote web page junk and dates
        // ("返信する WEB より: 2017年4月13日"), or gave the English back (2026-11-07).
        val piece = unsent(h.text) ?: return
        val words = bareEnd(piece).split(' ').filter { it.isNotBlank() }
        if (words.size < PIECE_MIN_WORDS || words.last().lowercase() in PIECE_CANNOT_END) return
        val say = (if (sentOfLine.isEmpty()) h.say else models["en>$target"]?.translate(piece, BEAM)?.trim()) ?: return
        if (target in OTHER_SCRIPTS && mostlyLatin(say)) return
        sentOfLine = bareEnd(h.text)
        VoiceEvents.emit("peer_piece", "piece" to piece, "say" to say)
        PeerLink.send(h.text, say, final = false)
    }

    /** The line is over: send what has not gone yet. */
    private fun finishPieces(h: Heard) {
        val target = language
        val first = sentOfLine.isEmpty()
        val rest = unsent(h.text).orEmpty()
        val say = when {
            first -> h.say.orEmpty()
            bareEnd(rest).isNotEmpty() && target != null -> models["en>$target"]?.translate(rest, BEAM)?.trim().orEmpty()
            else -> ""
        }
        sentOfLine = ""
        VoiceEvents.emit("peer_sent", "text" to say, "pieces_before" to !first)
        PeerLink.send(h.text, say)
    }

    private fun one(model: QuickMt.Model, sentence: String, lang: String): String? =
        if (lang == "ja") JaPhrases.translate(sentence) { model.translate(it, BEAM) }
        else model.translate(sentence, BEAM)?.trim()

    private fun sentences(text: String, lang: String): List<String> {
        val marked = text.split(SENTENCE_END).filter { it.isNotBlank() }
        return if (lang == "ja") marked.flatMap { JaSentences.split(it) } else marked
    }

    /** A line from the other person's PAN: translate it and say it to him. */
    private fun fromPeer(text: String, lang: String) {
        scope.launch {
            val model = models["$lang>en"] ?: return@launch
            val t0 = SystemClock.elapsedRealtime()
            val say = sentences(text, lang).mapNotNull { one(model, it.trim(), lang) }.joinToString(" ")
            VoiceEvents.emit("peer_line", "text" to text, "say" to say, "mt_ms" to (SystemClock.elapsedRealtime() - t0))
            if (say.isNotBlank()) onLine?.invoke(Line(text, lang, say, System.currentTimeMillis(), VOICES[1]))
        }
    }

    init {
        PeerLink.onLine = ::fromPeer
    }

    override fun onPause(pcm: FloatArray, stoppedAt: Long) {
        if (language == null) return
        latest = stoppedAt
        val job = scope.async { work(pcm, stoppedAt) }
        pending = stoppedAt to job
        if (PeerLink.on) scope.launch {
            val h = runCatching { job.await() }.getOrNull() ?: return@launch
            if (h.lang == "en" && h.say != null && !h.handOver && latest == stoppedAt && committed != stoppedAt) sendPiece(h)
        }
        VoiceEvents.emit("interp_pause", "samples" to pcm.size)
    }

    override fun onCommit(pcm: FloatArray, stoppedAt: Long): Boolean {
        if (language == null) return false
        committed = stoppedAt
        val p = pending
        latest = stoppedAt
        val job = if (p?.first == stoppedAt) p.second else scope.async { work(pcm, stoppedAt) }
        pending = null
        scope.launch {
            val h = runCatching { job.await() }.getOrNull() ?: return@launch
            when {
                h.handOver -> onHandOver?.invoke(h.text)
                h.say != null -> {
                    h.who?.let { book?.keep(it); usual[it.person] = h.lang }
                    if (PeerLink.on && h.lang == "en") {
                        finishPieces(h)
                        return@launch
                    }
                    lastSaid = h.say
                    lastSaidAt = System.currentTimeMillis()
                    lastVoice = h.voice
                    onLine?.invoke(Line(h.text, h.lang, h.say, stoppedAt, h.voice))
                }
            }
        }
        return true
    }
}
