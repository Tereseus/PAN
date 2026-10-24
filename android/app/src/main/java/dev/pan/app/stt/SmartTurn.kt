package dev.pan.app.stt

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.io.Closeable
import java.io.File
import java.nio.FloatBuffer

/**
 * Pipecat Smart Turn v3.2 - "has he finished talking, or is he just pausing?"
 *
 * The model LISTENS rather than reads: it takes the last 8 s of raw audio and
 * judges from tone, pace and grammar together, which a silence timer cannot and a
 * transcript alone cannot either. "I think we should move the meeting because"
 * scored 0.006 (keep listening); "What is the capital of Peru?" scored 0.983.
 *
 * WHY THE fp32 BUILD, NOT THE int8 ONE PIPECAT DEFAULTS TO ON CPU. Pipecat ships
 * both; "-gpu" only means fp32 and it runs on a CPU fine. Measured on IDENTICAL
 * input features, the int8 build's answer moves with the runtime version and the
 * CPU's int8 kernels - "I want you to" came out 0.63, 0.49 and 0.25 on onnxruntime
 * 1.24, 1.30 and 1.18. That is a coin toss on exactly the hesitant fragments this
 * exists to catch, and the phone's ARM kernels are different again. The fp32 build
 * gave the same answer to four decimals on every runtime tried (0.43 on that clip -
 * correctly unfinished) and was more confident on the clear cases. Cost: 32 MB
 * instead of 8.7 MB, downloaded once, and ~20 ms more per pause on a laptop.
 *
 * BSD-2, a Whisper-tiny encoder plus a classifier. Downloaded on first use next to
 * the ASR model, so the APK does not carry it.
 *
 * The graph's output is named `logits` but already has the sigmoid applied:
 * checked against the reference on five clips, every value landed in (0, 1).
 * Pipecat thresholds it at 0.5.
 *
 * NATIVE LIFETIME: an OrtSession is a native handle. Whoever creates it closes it,
 * and only after every call into it has returned - the same rule that fixed the
 * Vad_compute use-after-free in SherpaStreamingStt.
 *
 * Deliberately free of Android imports so SmartTurnModelTest can run this exact
 * class on the desktop build of onnxruntime.
 */
class SmartTurn(modelFile: File, intraOpThreads: Int = 4) : Closeable {

    companion object {
        const val MODEL_FILE = "smart-turn-v3.2-gpu.onnx"
        const val MODEL_URL = "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/$MODEL_FILE"
        // Verified size, so a truncated download cannot pass for the model.
        const val MODEL_BYTES = 32_411_198L
        const val THRESHOLD = 0.5f
    }

    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private val session: OrtSession = OrtSession.SessionOptions().use { opts ->
        // Pipecat's own settings (inference.py build_session).
        opts.setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL)
        opts.setInterOpNumThreads(1)
        opts.setIntraOpNumThreads(intraOpThreads)
        opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        env.createSession(modelFile.absolutePath, opts)
    }
    private val shape = longArrayOf(1, WhisperLogMel.N_MELS.toLong(), WhisperLogMel.FRAMES.toLong())

    /** Probability (0..1) that the speaker has finished. Uses the last 8 s of [audio]. */
    fun probability(audio: FloatArray, length: Int = audio.size): Float {
        val features = WhisperLogMel.compute(audio, length)
        OnnxTensor.createTensor(env, FloatBuffer.wrap(features), shape).use { input ->
            session.run(mapOf("input_features" to input)).use { result ->
                @Suppress("UNCHECKED_CAST")
                val out = result.get(0).value as Array<FloatArray>
                return out[0][0]
            }
        }
    }

    override fun close() = session.close()
}
