package dev.pan.app.translate

import java.io.Closeable
import java.io.File

/**
 * JNI for libpanmt.so (android/panmt): CTranslate2 running one quickmt model. One model is one
 * direction. The folder holds model.bin, src.spm.model and tgt.spm.model, as Hugging Face has them.
 */
object QuickMt {
    private val available: Boolean by lazy { runCatching { System.loadLibrary("panmt") }.isSuccess }

    @JvmStatic private external fun nativeLoad(dir: ByteArray, threads: Int): Long
    @JvmStatic private external fun nativeTranslate(handle: Long, text: ByteArray, beam: Int): ByteArray?
    @JvmStatic private external fun nativeRelease(handle: Long)

    fun exists(dir: File): Boolean =
        File(dir, "model.bin").exists() && File(dir, "src.spm.model").exists() && File(dir, "tgt.spm.model").exists()

    /** The model, or null if it is not on the phone or will not load. */
    fun load(dir: File, threads: Int): Model? {
        if (!available || !exists(dir)) return null
        val handle = nativeLoad(dir.absolutePath.toByteArray(), threads)
        return if (handle != 0L) Model(handle) else null
    }

    class Model internal constructor(private var handle: Long) : Closeable {
        /** Not thread safe to close during a call: InterpreterLoop runs both on one thread. */
        fun translate(text: String, beam: Int): String? =
            nativeTranslate(handle, text.toByteArray(), beam)?.toString(Charsets.UTF_8)

        override fun close() {
            if (handle != 0L) nativeRelease(handle)
            handle = 0L
        }
    }
}
