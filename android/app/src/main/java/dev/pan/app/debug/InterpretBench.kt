package dev.pan.app.debug

import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsSupertonicModelConfig
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import dev.pan.app.interpret.InterpreterLoop
import dev.pan.app.translate.QuickMt
import dev.pan.app.util.CpuBoost
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * What the interpreter runs on this phone, measured. Debug builds only (TEST_INTERP_BENCH).
 *
 *   adb shell am startservice -n dev.pan.app/.service.PanForegroundService \
 *     -a TEST_INTERP_BENCH --es what sensevoice,parakeet,quickmt --es threads 2,4 --es reps 4 \
 *     --es clips interp_ja_0.wav,interp_ja_2.wav
 *
 * Reads the models from <external files>/interp, lines.json (service/src/evals/translate) from
 * <external files>/interp_bench and the clips from voicebench/. Writes <engine>.json beside
 * lines.json for score.py, and logs timings under the tag InterpBench. For quickmt, reps is the
 * beam.
 *
 * Google's translators lost here on 2026-11-05 and were taken out again: ML Kit text got 88 of
 * 104 lines' facts right against quickmt's 99, at about the same speed, and Android's own
 * translator gave our app nothing. ML Kit GenAI Speech Translation pulls Kotlin 2.4 into this build.
 */
object InterpretBench {
    private const val TAG = "InterpBench"
    private val PAIRS = listOf("en>ja", "ja>en", "en>el", "el>en")

    suspend fun run(context: Context, what: List<String>, threads: List<Int>, reps: Int, clipNames: List<String>) {
        val dir = context.getExternalFilesDir("interp_bench") ?: return
        val clipDir = context.getExternalFilesDir("voicebench") ?: return
        val clips = clipNames.map { File(clipDir, it) }.filter { it.exists() }
        for (w in what) {
            Log.i(TAG, "START $w")
            try {
                when (w) {
                    "sensevoice" -> asr(context, "sensevoice", true, clips, threads, reps)
                    "parakeet" -> asr(context, "parakeet3", false, clips, threads, reps)
                    "parakeetel" -> asr(context, "parakeetel", false, clips, threads, reps)
                    "lid" -> lid(context, clips, threads)
                    "spk" -> speaker(context, clips, threads, reps)
                    "people" -> people(context, clips)
                    "quickmt" -> quickmt(context, dir, threads, reps)
                    "synth" -> synth(context, dir)
                    "voices" -> voices(context)
                    "fresh" -> fresh(context)
                    "path" -> path(context)
                    "super" -> supertonic(context, dir)
                    "supertime" -> supertonicTime(context, threads)
                    "piecetime" -> pieceTime(context)
                    "mtlines" -> mtLines(context, clipDir)
                    "superq" -> supertonicQuality(context, dir)
                    "ab" -> listenAb(context)
                    else -> Log.i(TAG, "unknown part $w")
                }
            } catch (e: Throwable) {
                Log.e(TAG, "FAILED $w: ${e.javaClass.simpleName} ${e.message}")
            }
            Log.i(TAG, "END $w")
        }
        Log.i(TAG, "ALL DONE")
    }

    /** Whisper tiny's guess at the language of each clip, whole and at 1.5 s. */
    private fun lid(context: Context, clips: List<File>, threads: List<Int>) {
        val dir = File(context.getExternalFilesDir("interp"), "lid")
        for (n in threads) {
            val id = InterpreterLoop.buildLid(dir, n)
            for (clip in clips) {
                val pcm = TestAudio.readWav(clip)
                val samples = FloatArray(pcm.size) { pcm[it] / 32768f }
                CpuBoost.burst(context)
                val a = SystemClock.elapsedRealtime()
                val s = id.createStream()
                s.acceptWaveform(samples, 16000)
                val lang = id.compute(s)
                s.release()
                val ms = SystemClock.elapsedRealtime() - a
                CpuBoost.done(ms)
                Log.i(TAG, "LID threads=$n clip=${clip.name} sec=${"%.1f".format(pcm.size / 16000f)} ms=$ms lang=$lang")
            }
            id.release()
        }
    }

    /** Who is talking: time for one voice print per clip. Model at <external files>/interp/spk/model.onnx. */
    private fun speaker(context: Context, clips: List<File>, threads: List<Int>, reps: Int) {
        val model = File(context.getExternalFilesDir("interp"), "spk/model.onnx").absolutePath
        for (n in threads) {
            val t0 = SystemClock.elapsedRealtime()
            val ext = SpeakerEmbeddingExtractor(config = SpeakerEmbeddingExtractorConfig(model = model, numThreads = n))
            Log.i(TAG, "SPK load threads=$n ms=${SystemClock.elapsedRealtime() - t0} dim=${ext.dim()}")
            for (clip in clips) {
                val pcm = TestAudio.readWav(clip)
                val samples = FloatArray(pcm.size) { pcm[it] / 32768f }
                val times = (0 until maxOf(reps, 3)).map {
                    CpuBoost.burst(context)
                    val a = SystemClock.elapsedRealtime()
                    val s = ext.createStream()
                    s.acceptWaveform(samples, 16000)
                    s.inputFinished()
                    ext.compute(s)
                    s.release()
                    val ms = SystemClock.elapsedRealtime() - a
                    CpuBoost.done(ms)
                    ms
                }.sorted()
                Log.i(TAG, "SPK threads=$n clip=${clip.name} sec=${"%.1f".format(pcm.size / 16000f)} median=${times[times.size / 2]} worst=${times.last()}")
            }
            ext.release()
        }
    }

    /** The clips as one talk, in order: who VoiceBook says each line is. No mic, no sound. */
    private fun people(context: Context, clips: List<File>) {
        val book = dev.pan.app.interpret.VoiceBook.build(File(context.getExternalFilesDir("interp"), "spk/model.onnx"), 4)
        for (clip in clips) {
            val pcm = TestAudio.readWav(clip)
            val a = SystemClock.elapsedRealtime()
            val p = book.pick(FloatArray(pcm.size) { pcm[it] / 32768f })
            val ms = SystemClock.elapsedRealtime() - a
            book.keep(p)
            Log.i(TAG, "PEOPLE clip=${clip.name} sec=${"%.1f".format(pcm.size / 16000f)} person=${p.person} likeness=${"%.2f".format(p.likeness)} ms=$ms")
        }
        book.release()
        Log.i(TAG, "PEOPLE done")
    }

    private fun asr(context: Context, name: String, sense: Boolean, clips: List<File>, threads: List<Int>, reps: Int) {
        val dir = File(context.getExternalFilesDir("interp"), name)
        for (n in threads) {
            val t0 = SystemClock.elapsedRealtime()
            val rec = InterpreterLoop.buildEar(dir, sense, n)
            Log.i(TAG, "ASR $name load threads=$n ms=${SystemClock.elapsedRealtime() - t0}")
            for (clip in clips) {
                val pcm = TestAudio.readWav(clip)
                val samples = FloatArray(pcm.size) { pcm[it] / 32768f }
                var text = ""
                var lang = ""
                val ms = (0..reps).map {
                    CpuBoost.burst(context)
                    val a = SystemClock.elapsedRealtime()
                    val s = rec.createStream()
                    s.acceptWaveform(samples, 16000)
                    rec.decode(s)
                    val r = rec.getResult(s)
                    s.release()
                    text = r.text
                    lang = r.lang
                    (SystemClock.elapsedRealtime() - a).also { CpuBoost.done(it) }
                }.drop(1).sorted()
                Log.i(TAG, "ASR $name threads=$n clip=${clip.name} sec=${"%.1f".format(pcm.size / 16000f)} " +
                    "median=${ms[ms.size / 2]} min=${ms.first()} max=${ms.last()} lang=$lang text=$text")
            }
            rec.release()
        }
    }

    /**
     * The other person, for the benchmark: the phone's own voices reading lines.json into
     * interp_bench/synth/<lang>_<nn>.wav, at the voice's own rate. Resample them to 16 kHz into
     * voicebench/sources as tts_<lang>_<nn>.wav.
     */
    private fun synth(context: Context, dir: File) {
        val all = lines(dir)
        val out = File(dir, "synth").apply { mkdirs() }
        val ready = CountDownLatch(1)
        val tts = TextToSpeech(context) { ready.countDown() }
        ready.await(10, TimeUnit.SECONDS)
        val waiting = ConcurrentHashMap<String, CountDownLatch>()
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) { waiting[id]?.countDown() }
            @Deprecated("Deprecated in Java")
            override fun onError(id: String?) { Log.i(TAG, "SYNTH $id failed"); waiting[id]?.countDown() }
        })
        for ((pair, lang) in listOf("ja>en" to "ja", "el>en" to "el")) {
            Log.i(TAG, "SYNTH $lang language=${tts.setLanguage(Locale(lang))} voice=${tts.voice?.name}")
            val set = all.getJSONArray(pair)
            for (i in 0 until set.length()) {
                val id = "%s_%02d".format(lang, i)
                val done = CountDownLatch(1)
                waiting[id] = done
                tts.synthesizeToFile(set.getJSONObject(i).getString("text"), Bundle(), File(out, "$id.wav"), id)
                done.await(15, TimeUnit.SECONDS)
            }
        }
        tts.shutdown()
        Log.i(TAG, "SYNTH wrote ${out.list()?.size} files")
    }

    /**
     * What flipping languages costs the Android voice, the way a two way talk does on every line:
     * one engine changing voice each time, against one engine per language. Quiet, not silent.
     */
    /** The samples of a 16 bit wav at any rate. TestAudio.readWav only takes the mic's 16 kHz. */
    private fun pcm16(f: File): ShortArray {
        val b = f.readBytes()
        var at = 12
        while (at + 8 <= b.size) {
            val size = java.nio.ByteBuffer.wrap(b, at + 4, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).int
            if (String(b, at, 4, Charsets.US_ASCII) == "data") {
                val s = java.nio.ByteBuffer.wrap(b, at + 8, minOf(size, b.size - at - 8))
                    .order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                return ShortArray(s.remaining()).also { s.get(it) }
            }
            at += 8 + size + (size and 1)
        }
        error("no data in ${f.name}")
    }

    /** How to get the wait for the first sound down: which graphs, how many threads and steps. */
    private fun supertonicTime(context: Context, threads: List<Int>) {
        val fp = File(context.getExternalFilesDir("interp"), "st3fp")
        val lines = listOf("ja" to "この寿司は千二百円です。", "el" to "Δεν έχουμε τραπέζι απόψε.", "en" to "I often go to a ramen shop near the station.")
        for ((name, dir, suffix) in listOf(Triple("int8", File(context.filesDir, "piper-models/supertonic3"), ".int8"), Triple("fp32", fp, ""))) {
            if (!File(dir, "vector_estimator$suffix.onnx").exists()) continue
            for (n in threads) {
                val t0 = SystemClock.elapsedRealtime()
                val tts = supertonicEngine(context, n, dir, suffix)
                val load = SystemClock.elapsedRealtime() - t0
                for (steps in listOf(2, 3, 4)) for ((lang, text) in lines) {
                    val ms = (0..4).map {
                        CpuBoost.burst(context)
                        val a = SystemClock.elapsedRealtime()
                        tts.generateWithConfig(text, GenerationConfig(silenceScale = 0.2f, speed = 1.2f, sid = 9, numSteps = steps, extra = mapOf("lang" to lang)))
                        (SystemClock.elapsedRealtime() - a).also { CpuBoost.done(it) }
                    }.drop(1).sorted()
                    Log.i(TAG, "STTIME $name threads=$n steps=$steps $lang chars=${text.length} median=${ms[ms.size / 2]} min=${ms.first()} max=${ms.last()} load=$load")
                }
                tts.release()
            }
        }
    }

    /**
     * Everyday Japanese as the ear gives it, no sentence breaks: voicebench/mt_lines.tsv, meaning
     * then line. Writes mt_out.txt with the line as it comes, split, and with the line before it.
     */
    private fun mtLines(context: Context, clipDir: File) {
        val model = dev.pan.app.translate.QuickMt.load(File(context.getExternalFilesDir("interp"), "quickmt-ja-en"), 2) ?: return
        val out = StringBuilder()
        var last = ""
        for (row in File(clipDir, "mt_lines.tsv").readLines()) {
            val cols = row.split(9.toChar())
            if (cols.size < 2) continue
            val line = cols[1]
            val whole = model.translate(line, 4)
            val split = dev.pan.app.interpret.JaSentences.split(line).mapNotNull { s ->
                dev.pan.app.interpret.JaPhrases.translate(s) { model.translate(it, 4) } }.joinToString(" ")
            val context2 = if (last.isEmpty()) "" else model.translate(last + "。" + line, 4)
            out.append(cols[0]).append(" | WHOLE ").append(whole).append(" | SPLIT ").append(split).append(" | CONTEXT ").append(context2).append(10.toChar())
            last = line
        }
        File(clipDir, "mt_out.txt").writeText(out.toString())
        model.close()
        Log.i(TAG, "MTLINES done")
    }

    /** How long a piece of a line takes to build, by its length, at what interpreting uses. */
    private fun pieceTime(context: Context) {
        val tts = supertonicEngine(context, 3)
        val lines = listOf("ja" to "はい", "ja" to "この寿司は", "ja" to "駅の近くの", "ja" to "この寿司は千二百円です。",
            "ja" to "駅の近くのラーメン屋に", "ja" to "海外に住んだことはありません。", "ja" to "駅の近くのラーメン屋によく行きます。",
            "ja" to "この新しいお店のラーメンはとてもおいしいです。", "en" to "Oh", "en" to "I often go", "en" to "I often go to a ramen shop", "en" to "I often go to a ramen shop near the station.")
        for (steps in listOf(3, 4)) for ((lang, text) in lines) {
            var seconds = 0f
            val ms = (0..4).map {
                CpuBoost.burst(context)
                val a = SystemClock.elapsedRealtime()
                val out = tts.generateWithConfig(text, GenerationConfig(silenceScale = 0.2f, speed = if (lang == "ja") 0.8f else 1.0f, sid = 9, numSteps = steps, extra = mapOf("lang" to lang)))
                seconds = out.samples.size.toFloat() / out.sampleRate
                (SystemClock.elapsedRealtime() - a).also { CpuBoost.done(it) }
            }.drop(1).sorted()
            Log.i(TAG, "PIECE steps=$steps $lang chars=${text.length} audio=${"%.2f".format(seconds)} median=${ms[ms.size / 2]} min=${ms.first()} max=${ms.last()}")
        }
        tts.release()
        Log.i(TAG, "PIECE done")
    }

    private fun supertonicEngine(context: Context, threads: Int,
                                 d: File = File(context.filesDir, "piper-models/supertonic3"), s: String = ".int8"): OfflineTts {
        return OfflineTts(assetManager = null, config = OfflineTtsConfig(model = OfflineTtsModelConfig(
            supertonic = OfflineTtsSupertonicModelConfig(
                textEncoder = File(d, "text_encoder$s.onnx").absolutePath,
                durationPredictor = File(d, "duration_predictor$s.onnx").absolutePath,
                vectorEstimator = File(d, "vector_estimator$s.onnx").absolutePath,
                vocoder = File(d, "vocoder$s.onnx").absolutePath,
                voiceStyle = File(d, "voice.bin").absolutePath,
                ttsJson = File(d, "tts.json").absolutePath,
                unicodeIndexer = File(d, "unicode_indexer.bin").absolutePath),
            numThreads = threads, debug = false, provider = "cpu")))
    }

    private fun say(tts: OfflineTts, text: String, lang: String, sid: Int, steps: Int = 4) = tts.generateWithConfig(
        text, GenerationConfig(silenceScale = 0.2f, speed = 1.2f, sid = sid, numSteps = steps, extra = mapOf("lang" to lang)))

    private fun to16k(samples: FloatArray, rate: Int): FloatArray {
        val n = (samples.size.toLong() * 16000 / rate).toInt()
        return FloatArray(n) { i ->
            val x = i.toDouble() * rate / 16000
            val a = x.toInt().coerceAtMost(samples.size - 2)
            val f = (x - a).toFloat()
            samples[a] * (1 - f) + samples[a + 1] * f
        }
    }

    /** Supertonic 3 in Japanese and Greek: how long a line takes, and can our own ears read it back. */
    private fun supertonic(context: Context, dir: File) {
        val all = lines(dir)
        val tts = supertonicEngine(context, 3)
        val home = context.getExternalFilesDir("interp")
        for ((pair, lang, earName, sense) in listOf(
            listOf("ja>en", "ja", "sensevoice", true), listOf("el>en", "el", "parakeetel", false))) {
            val ear = InterpreterLoop.buildEar(File(home, earName as String), sense as Boolean, 4)
            val set = all.getJSONArray(pair as String)
            say(tts, "はい", lang as String, 9)
            for (steps in listOf(4, 3)) for (i in 0 until set.length()) {
                val text = set.getJSONObject(i).getString("text")
                CpuBoost.burst(context)
                val t0 = SystemClock.elapsedRealtime()
                val out = say(tts, text, lang, 9, steps)
                val ms = SystemClock.elapsedRealtime() - t0
                CpuBoost.done(ms)
                val st = ear.createStream()
                st.acceptWaveform(to16k(out.samples, out.sampleRate), 16000)
                ear.decode(st)
                val heard = ear.getResult(st).text
                st.release()
                Log.i(TAG, "SUPER $lang steps=$steps chars=${text.length} ms=$ms audio=${"%.1f".format(out.samples.size.toFloat() / out.sampleRate)} said=$text heard=$heard")
            }
            ear.release()
        }
        tts.release()
    }

    /**
     * Is a wrong read-back the voice or the ear? The control is the Android voice's files from
     * "synth", read by the same ear. Then Supertonic with more steps, slower, and the other voice.
     * Nothing is played.
     */
    private fun supertonicQuality(context: Context, dir: File) {
        val all = lines(dir)
        val tts = supertonicEngine(context, 3)
        val home = context.getExternalFilesDir("interp")
        for ((pair, lang, earName, sense) in listOf(
            listOf("ja>en", "ja", "sensevoice", true), listOf("el>en", "el", "parakeetel", false))) {
            val ear = InterpreterLoop.buildEar(File(home, earName as String), sense as Boolean, 4)
            val set = all.getJSONArray(pair as String)
            fun heard(samples: FloatArray): String {
                val st = ear.createStream()
                st.acceptWaveform(samples, 16000)
                ear.decode(st)
                return ear.getResult(st).text.also { st.release() }
            }
            for (i in 0 until set.length()) {
                val f = File(dir, "synth/%s_%02d.wav".format(lang, i))
                if (!f.exists()) continue
                val pcm = pcm16(f)
                val text = set.getJSONObject(i).getString("text")
                val rate = java.nio.ByteBuffer.wrap(f.readBytes(), 24, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).int
                val h = heard(to16k(FloatArray(pcm.size) { pcm[it] / 32768f }, rate))
                Log.i(TAG, "SUPERQ $lang who=android steps=0 speed=0 sid=0 ms=0 said=$text heard=$h")
            }
            for ((steps, speed, sid) in listOf(Triple(4, 1.2f, 9), Triple(4, 1.0f, 9), Triple(8, 1.2f, 9), Triple(8, 1.0f, 9), Triple(4, 1.2f, 6), Triple(8, 1.0f, 6)))
                for (i in 0 until set.length()) {
                    val text = set.getJSONObject(i).getString("text")
                    CpuBoost.burst(context)
                    val t0 = SystemClock.elapsedRealtime()
                    val out = tts.generateWithConfig(text, GenerationConfig(silenceScale = 0.2f, speed = speed, sid = sid,
                        numSteps = steps, extra = mapOf("lang" to (lang as String))))
                    val ms = SystemClock.elapsedRealtime() - t0
                    CpuBoost.done(ms)
                    val h = heard(to16k(out.samples, out.sampleRate))
                    Log.i(TAG, "SUPERQ $lang who=st steps=$steps speed=$speed sid=$sid ms=$ms said=$text heard=$h")
                }
            ear.release()
        }
        tts.release()
    }

    /**
     * For his ears: the same line five ways, at full voice, with a spoken number before each.
     * One is what PAN does now (the phone call path), two is the same voice on the normal audio
     * path, three to five are Supertonic voices on the normal path. Those are rendered ahead into
     * interp_bench/ab/<lang>_<sid>.wav at 44.1 kHz: the AAR's sherpa only lets Supertonic speak en,
     * ko, es, pt and fr.
     */
    private fun listenAb(context: Context) {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
        val ready = CountDownLatch(1)
        val t = TextToSpeech(context) { ready.countDown() }
        ready.await(10, TimeUnit.SECONDS)
        val done = ConcurrentHashMap<String, CountDownLatch>()
        t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) { done[id]?.countDown() }
            @Deprecated("Deprecated in Java")
            override fun onError(id: String?) { done[id]?.countDown() }
        })
        t.setSpeechRate(1.1f)
        t.setPitch(0.95f)
        var seq = 0
        fun line(text: String, voice: String) {
            t.voices.firstOrNull { it.name == voice }?.let { t.voice = it }
            val id = "ab${seq++}"
            val over = CountDownLatch(1)
            done[id] = over
            t.speak(text, TextToSpeech.QUEUE_ADD, Bundle(), id)
            over.await(12, TimeUnit.SECONDS)
        }
        fun attrs(call: Boolean) {
            val a = android.media.AudioAttributes.Builder()
                .setUsage(if (call) android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION else android.media.AudioAttributes.USAGE_ASSISTANT)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build()
            t.setAudioAttributes(a)
            if (call) {
                am.mode = android.media.AudioManager.MODE_IN_COMMUNICATION
                am.availableCommunicationDevices.firstOrNull { it.type == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                    ?.let { am.setCommunicationDevice(it) }
            } else {
                am.mode = android.media.AudioManager.MODE_NORMAL
                am.clearCommunicationDevice()
            }
        }
        val en = "en-us-x-iom-local"
        val ab = File(context.getExternalFilesDir("interp_bench"), "ab")
        val sets = listOf(
            Triple("en", en, "This sushi is twelve hundred yen, and it comes with green tea."),
            Triple("ja", "ja-jp-x-star04-local", "この寿司は千二百円で、お茶が付いています。"),
            Triple("el", "el-gr-x-vfz-local", "Το λεωφορείο για το κέντρο φεύγει στις οκτώ το βράδυ."))
        for ((lang, voice, text) in sets) {
            attrs(true)
            line("One.", en)
            line(text, voice)
            Thread.sleep(700)
            attrs(false)
            line("Two.", en)
            line(text, voice)
            Thread.sleep(700)
            for ((word, sid) in listOf("Three." to 9, "Four." to 2, "Five." to 6)) {
                line(word, en)
                val pcm = pcm16(File(ab, "${lang}_$sid.wav"))
                val track = android.media.AudioTrack.Builder()
                    .setAudioAttributes(android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setAudioFormat(android.media.AudioFormat.Builder()
                        .setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(44100)
                        .setChannelMask(android.media.AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(pcm.size * 2)
                    .setTransferMode(android.media.AudioTrack.MODE_STATIC).build()
                track.write(pcm, 0, pcm.size)
                track.play()
                Thread.sleep(pcm.size * 1000L / 44100 + 300)
                track.release()
                Thread.sleep(500)
            }
            Thread.sleep(1200)
        }
        am.mode = android.media.AudioManager.MODE_NORMAL
        t.shutdown()
    }

    /**
     * Which voices this phone has, and what the audio path does to them. Speaks quietly for 12 s
     * on the phone call path PAN uses, then 12 s on the plain media path: read
     * `dumpsys media.audio_flinger` during each.
     */
    private fun path(context: Context) {
        val ready = CountDownLatch(1)
        val t = TextToSpeech(context) { ready.countDown() }
        ready.await(10, TimeUnit.SECONDS)
        for (lang in listOf("en", "ja", "el", "ko", "zh")) {
            val mine = t.voices.filter { it.locale.language == lang }
            Log.i(TAG, "VOICELIST $lang ${mine.size}: " + mine.groupBy { it.isNetworkConnectionRequired }.map { (net, v) ->
                (if (net) "network " else "local ") + v.size + " " + v.take(14).joinToString(",") { "${it.name}:${it.quality}" }
            }.joinToString(" | "))
        }
        val am = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
        val line = "This is a long quiet test line, said only to look at how the audio is carried, and it goes on for a while so that there is time to read the state of the phone while it plays. "
        for (call in listOf(true, false)) {
            t.setAudioAttributes(android.media.AudioAttributes.Builder()
                .setUsage(if (call) android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION else android.media.AudioAttributes.USAGE_ASSISTANT)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
            if (call) {
                am.mode = android.media.AudioManager.MODE_IN_COMMUNICATION
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = true
            }
            Log.i(TAG, "PATH ${if (call) "call" else "media"} start")
            val p = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 0.03f) }
            t.speak(line + line, TextToSpeech.QUEUE_FLUSH, p, "path")
            Thread.sleep(12_000)
            t.stop()
            am.mode = android.media.AudioManager.MODE_NORMAL
            Log.i(TAG, "PATH ${if (call) "call" else "media"} end")
            Thread.sleep(1500)
        }
        t.shutdown()
    }

    /**
     * What a line nobody has said before costs. The voices part said the same lines again and
     * again, and Google's voice seems to keep what it has said: a line it knew started in 3 ms,
     * a new one in about 470. A real talk has only new lines, so every line here has new numbers.
     */
    private fun fresh(context: Context) {
        fun engine(): TextToSpeech {
            val ready = CountDownLatch(1)
            val t = TextToSpeech(context) { ready.countDown() }
            ready.await(10, TimeUnit.SECONDS)
            return t
        }
        val started = ConcurrentHashMap<String, Long>()
        val audio = ConcurrentHashMap<String, Long>()
        val ended = ConcurrentHashMap<String, CountDownLatch>()
        val listen = object : UtteranceProgressListener() {
            override fun onStart(id: String?) { if (id != null) started.putIfAbsent(id, SystemClock.elapsedRealtime()) }
            override fun onAudioAvailable(id: String?, bytes: ByteArray?) { if (id != null) audio.putIfAbsent(id, SystemClock.elapsedRealtime()) }
            override fun onDone(id: String?) { ended[id]?.countDown() }
            @Deprecated("Deprecated in Java")
            override fun onError(id: String?) { ended[id]?.countDown() }
        }
        val a = engine().apply { setOnUtteranceProgressListener(listen); setSpeechRate(1.1f); setPitch(0.95f) }
        val b = engine().apply { setOnUtteranceProgressListener(listen); setSpeechRate(1.1f); setPitch(0.95f) }
        fun best(t: TextToSpeech, lang: String) = t.voices.filter { it.locale.language == lang && !it.isNetworkConnectionRequired }
            .sortedByDescending { it.quality }.first()
        val en = a.voices.firstOrNull { it.name == "en-us-x-iom-local" } ?: best(a, "en")
        val rnd = java.util.Random()
        fun n() = 1000 + rnd.nextInt(8999)
        fun short(lang: String) = when (lang) {
            "ja" -> "${n()}円です。"
            "el" -> "Κοστίζει ${n()} ευρώ."
            else -> "It costs ${n()} euros."
        }
        fun long(lang: String) = when (lang) {
            "ja" -> "${n()}番のバスは駅の前から${rnd.nextInt(12) + 1}時${rnd.nextInt(50) + 10}分に出発します。"
            "el" -> "Το λεωφορείο ${n()} φεύγει από τον σταθμό στις ${rnd.nextInt(12) + 1} και ${rnd.nextInt(50) + 10} το βράδυ."
            else -> "Bus number ${n()} leaves from the front of the station at ${rnd.nextInt(12) + 1} ${rnd.nextInt(50) + 10} tonight."
        }
        var seq = 0
        val stamp = SystemClock.elapsedRealtime()
        fun say(t: TextToSpeech, text: String): Pair<Long, Long> {
            val id = "f$stamp-${seq++}"
            val over = CountDownLatch(1)
            ended[id] = over
            val p = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 0.05f) }
            val t0 = SystemClock.elapsedRealtime()
            t.speak(text, TextToSpeech.QUEUE_ADD, p, id)
            over.await(10, TimeUnit.SECONDS)
            return ((started[id] ?: t0) - t0) to ((audio[id] ?: t0) - t0)
        }
        fun report(name: String, all: List<Pair<Long, Long>>) =
            Log.i(TAG, "FRESH $name start=${all.map { it.first }} audio=${all.map { it.second }}")
        a.voice = en
        // How long a voice stays ready while the other one does all the talking, or nobody does.
        for (lang in listOf("ja", "el")) {
            b.voice = best(a, lang)
            repeat(2) {
                say(a, n().toString())
                say(b, n().toString())
            }
            report("$lang after warming, flipping", (0 until 4).map { i -> if (i % 2 == 0) say(a, short("en")) else say(b, short(lang)) })
            for (lines in listOf(3, 6, 10)) {
                repeat(lines) { say(b, short(lang)) }
                report("$lang en after $lines other lines", listOf(say(a, short("en"))))
            }
            for (idle in listOf(20L, 60L)) {
                Thread.sleep(idle * 1000)
                report("$lang after $idle s idle", listOf(say(b, short(lang)), say(a, short("en"))))
            }
        }
        say(a, "Yes.")
        report("en short", (0 until 6).map { say(a, short("en")) })
        report("en long", (0 until 6).map { say(a, long("en")) })
        val same = short("en")
        report("en same line again", (0 until 4).map { say(a, same) })
        for (lang in listOf("ja", "el")) {
            val v = best(a, lang)
            b.voice = v
            say(b, if (lang == "ja") "はい" else "Ναι")
            report("$lang short", (0 until 6).map { say(b, short(lang)) })
            report("$lang long", (0 until 6).map { say(b, long(lang)) })
            report("$lang two engines, flipping", (0 until 8).map { i -> if (i % 2 == 0) say(b, short(lang)) else say(a, short("en")) })
            report("$lang one engine, flipping", (0 until 8).map { i ->
                val t0 = SystemClock.elapsedRealtime()
                a.voice = if (i % 2 == 0) v else en
                val set = SystemClock.elapsedRealtime() - t0
                val r = say(a, short(if (i % 2 == 0) lang else "en"))
                (r.first + set) to (r.second + set)
            })
            a.voice = en
        }
        a.shutdown()
        b.shutdown()
    }

    private fun voices(context: Context) {
        fun engine(): TextToSpeech {
            val ready = CountDownLatch(1)
            val t = TextToSpeech(context) { ready.countDown() }
            ready.await(10, TimeUnit.SECONDS)
            return t
        }
        val started = ConcurrentHashMap<String, CountDownLatch>()
        val ended = ConcurrentHashMap<String, CountDownLatch>()
        val listen = object : UtteranceProgressListener() {
            override fun onStart(id: String?) { started[id]?.countDown() }
            override fun onDone(id: String?) { ended[id]?.countDown() }
            @Deprecated("Deprecated in Java")
            override fun onError(id: String?) { started[id]?.countDown(); ended[id]?.countDown() }
        }
        val a = engine().apply { setOnUtteranceProgressListener(listen) }
        val b = engine().apply { setOnUtteranceProgressListener(listen) }
        fun best(t: TextToSpeech, lang: String) = t.voices.filter { it.locale.language == lang && !it.isNetworkConnectionRequired }
            .sortedByDescending { it.quality }.first()
        val en = best(a, "en")
        val other = listOf("ja", "el").associateWith { best(a, it) }
        val lines = mapOf("en" to "This sushi is twelve hundred yen.", "ja" to "海外に住んでいたことがありますか?",
            "el" to "Πόσο καιρό μένεις εδώ;")
        var seq = 0
        fun say(t: TextToSpeech, text: String): Long {
            val id = "b${seq++}"
            val go = CountDownLatch(1)
            val over = CountDownLatch(1)
            started[id] = go
            ended[id] = over
            val p = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 0.05f) }
            val t0 = SystemClock.elapsedRealtime()
            t.speak(text, TextToSpeech.QUEUE_ADD, p, id)
            go.await(5, TimeUnit.SECONDS)
            val ms = SystemClock.elapsedRealtime() - t0
            over.await(8, TimeUnit.SECONDS)
            return ms
        }
        for (lang in listOf("ja", "el")) {
            val v = other.getValue(lang)
            val one = (0 until 8).map { i ->
                val t0 = SystemClock.elapsedRealtime()
                a.voice = if (i % 2 == 0) v else en
                val set = SystemClock.elapsedRealtime() - t0
                say(a, lines.getValue(if (i % 2 == 0) lang else "en")) + set
            }
            Log.i(TAG, "VOICES one engine, flipping en/$lang voice=${v.name}: $one")
            a.voice = en
            b.voice = v
            say(a, lines.getValue("en"))
            say(b, lines.getValue(lang))
            val two = (0 until 8).map { i -> if (i % 2 == 0) say(b, lines.getValue(lang)) else say(a, lines.getValue("en")) }
            Log.i(TAG, "VOICES two engines, en/$lang: $two")
        }
        a.shutdown()
        b.shutdown()
    }

    /** Every line through quickmt, by threads and beam (reps = beam here). */
    private fun quickmt(context: Context, dir: File, threads: List<Int>, beam: Int) {
        val all = lines(dir)
        val home = context.getExternalFilesDir("interp") ?: return
        for (n in threads) {
            val rows = JSONArray()
            for (pair in PAIRS) {
                val (src, tgt) = pair.split(">")
                val t0 = SystemClock.elapsedRealtime()
                val model = QuickMt.load(File(home, "quickmt-$src-$tgt"), n)
                if (model == null) { Log.i(TAG, "QUICKMT $pair not on the phone"); continue }
                Log.i(TAG, "QUICKMT $pair threads=$n loaded in ${SystemClock.elapsedRealtime() - t0} ms")
                val set = all.getJSONArray(pair)
                val ms = ArrayList<Long>()
                model.translate(set.getJSONObject(0).getString("text"), beam)
                for (i in 0 until set.length()) {
                    val text = set.getJSONObject(i).getString("text")
                    CpuBoost.burst(context)
                    val a = SystemClock.elapsedRealtime()
                    val out = model.translate(text, beam).orEmpty()
                    val took = SystemClock.elapsedRealtime() - a
                    CpuBoost.done(took)
                    ms.add(took)
                    rows.put(JSONObject().put("pair", pair).put("text", text).put("out", out).put("ms", took))
                }
                ms.sort()
                Log.i(TAG, "QUICKMT $pair threads=$n beam=$beam median=${ms[ms.size / 2]} max=${ms.last()}")
                model.close()
            }
            write(dir, "quickmt-phone-t$n-b$beam", rows)
        }
    }

    private fun lines(dir: File): JSONObject = JSONObject(File(dir, "lines.json").readText())

    private fun write(dir: File, engine: String, rows: JSONArray) {
        File(dir, "$engine.json").writeText(JSONObject().put("engine", engine).put("rows", rows).toString(1))
        Log.i(TAG, "wrote $engine.json (${rows.length()} rows)")
    }

}
