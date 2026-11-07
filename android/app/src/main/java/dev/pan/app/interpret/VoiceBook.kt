package dev.pan.app.interpret

import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import java.io.File
import kotlin.math.sqrt

/**
 * Who said a line, for one interpreted talk, so each person comes out in their own voice. Nobody
 * signs up: the first voice heard is person one, and a line that sounds like nobody yet is a new
 * person. Voice prints live here in memory and go when the talk ends. Nothing is saved or sent.
 *
 * pick() only looks, because a line can be read at a pause and then run on. keep() is for a line
 * that was really said.
 */
class VoiceBook(private val extractor: SpeakerEmbeddingExtractor) {

    companion object {
        private const val SAMPLE_RATE = 16000
        // Random talks between real voices, 24 lines of 1 to 5 s (spk_sort.py on the hub,
        // 2026-11-06). Lines given the right person at 0.4: 2 people 99%, 3 people 97%, 4 people
        // 95%, the right number of people in 86 of 90 talks. Under noise 97, 96, 91, and it splits
        // a person in two more often, 73 of 90. 0.3 merges people, 0.5 splits them.
        const val SAME_PERSON = 0.4f
        // A voice that is new on a line shorter than this is more likely a short line than a person.
        private const val NEW_PERSON_SAMPLES = SAMPLE_RATE * 3 / 2
        private const val MAX_PEOPLE = 4

        fun build(model: File, threads: Int) = VoiceBook(SpeakerEmbeddingExtractor(
            config = SpeakerEmbeddingExtractorConfig(model = model.absolutePath, numThreads = threads)))
    }

    /** A person for a line. [person] is past the end of the book when it is someone new. */
    class Pick(val person: Int, val likeness: Float, internal val print: FloatArray, internal val keeps: Boolean)

    private val people = ArrayList<FloatArray>()

    private fun print(pcm: FloatArray): FloatArray {
        val s = extractor.createStream()
        s.acceptWaveform(pcm, SAMPLE_RATE)
        s.inputFinished()
        val v = extractor.compute(s)
        s.release()
        return unit(v)
    }

    private fun unit(v: FloatArray): FloatArray {
        val n = sqrt(v.fold(0f) { a, x -> a + x * x }) + 1e-9f
        return FloatArray(v.size) { v[it] / n }
    }

    private fun likeness(a: FloatArray, b: FloatArray): Float {
        val u = unit(b)
        var d = 0f
        for (i in a.indices) d += a[i] * u[i]
        return d
    }

    fun pick(pcm: FloatArray): Pick {
        val p = print(pcm)
        var best = -1
        var score = -1f
        people.forEachIndexed { i, sum ->
            val l = likeness(p, sum)
            if (l > score) { score = l; best = i }
        }
        return when {
            best >= 0 && score >= SAME_PERSON -> Pick(best, score, p, true)
            best < 0 -> Pick(0, score, p, true)
            pcm.size < NEW_PERSON_SAMPLES -> Pick(best, score, p, false)
            people.size < MAX_PEOPLE -> Pick(people.size, score, p, true)
            else -> Pick(best, score, p, true)
        }
    }

    /** The line was said. Their print gets better with every line. */
    fun keep(pick: Pick) {
        if (!pick.keeps) return
        if (pick.person >= people.size) {
            people.add(pick.print.copyOf())
            return
        }
        val sum = people[pick.person]
        for (i in sum.indices) sum[i] += pick.print[i]
    }

    fun release() = extractor.release()
}
