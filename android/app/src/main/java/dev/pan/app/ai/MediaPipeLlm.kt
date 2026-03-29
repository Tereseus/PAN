package dev.pan.app.ai

import android.content.Context
import android.util.Log
import com.google.mediapipe.tasks.genai.llminference.LlmInference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.URL

/**
 * MediaPipe-based LLM inference for Gemma 3n.
 * Uses GPU acceleration for ~2-3 second response times on phone.
 * Replaces llama.cpp which was CPU-only and too slow (~18 seconds).
 */
class MediaPipeLlm(private val context: Context) {
    companion object {
        private const val TAG = "PAN-MediaPipe"

        // Gemma 3n E2B — fastest on-device model with GPU
        // ~2.4s time to first token, 23 tok/s decode on GPU
        const val MODEL_NAME = "Gemma 3n E2B"
        const val MODEL_FILENAME = "gemma-3n-E2B-it-int4.task"
        const val MODEL_SIZE_BYTES = 3_136_000_000L

        // Ungated community repo — no auth required, no license gate
        const val MODEL_URL = "https://huggingface.co/realbyte/gemma-3n-E2B-it-int4-mediapipe/resolve/main/gemma-3n-E2B-it-int4.task"
    }

    private var inference: LlmInference? = null
    private var isLoaded = false
    private val modelsDir = File(context.filesDir, "mediapipe-models")

    fun getModelFile(): File = File(modelsDir, MODEL_FILENAME)

    fun isModelDownloaded(): Boolean {
        val file = getModelFile()
        return file.exists() && file.length() > MODEL_SIZE_BYTES * 0.8
    }

    fun isReady(): Boolean = isLoaded && inference != null

    suspend fun downloadModel(onProgress: (Float) -> Unit = {}): Boolean = withContext(Dispatchers.IO) {
        try {
            modelsDir.mkdirs()
            val file = getModelFile()
            val tempFile = File(modelsDir, "$MODEL_FILENAME.tmp")

            Log.d(TAG, "Downloading $MODEL_NAME from $MODEL_URL")
            val connection = URL(MODEL_URL).openConnection()
            connection.connectTimeout = 15000
            val totalBytes = connection.contentLengthLong.takeIf { it > 0 } ?: MODEL_SIZE_BYTES

            connection.getInputStream().use { input ->
                tempFile.outputStream().use { output ->
                    val buffer = ByteArray(65536)
                    var downloaded = 0L
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        downloaded += read
                        onProgress(downloaded.toFloat() / totalBytes)
                    }
                }
            }

            tempFile.renameTo(file)
            Log.d(TAG, "Download complete: ${file.absolutePath} (${file.length()} bytes)")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Download failed: ${e.message}")
            false
        }
    }

    suspend fun loadModel(): Boolean = withContext(Dispatchers.IO) {
        try {
            val modelPath = getModelFile().absolutePath
            if (!File(modelPath).exists()) {
                Log.e(TAG, "Model file not found: $modelPath")
                return@withContext false
            }

            Log.d(TAG, "Loading model with GPU backend...")
            val startTime = System.currentTimeMillis()

            val options = LlmInference.LlmInferenceOptions.builder()
                .setModelPath(modelPath)
                .setMaxTokens(512)
                .setPreferredBackend(LlmInference.Backend.GPU)
                .build()

            inference = LlmInference.createFromOptions(context, options)
            isLoaded = true

            val elapsed = System.currentTimeMillis() - startTime
            Log.d(TAG, "Model loaded in ${elapsed}ms with GPU backend")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load with GPU, trying CPU: ${e.message}")
            // Fallback to CPU if GPU fails
            try {
                val options = LlmInference.LlmInferenceOptions.builder()
                    .setModelPath(getModelFile().absolutePath)
                    .setMaxTokens(512)
                    .setPreferredBackend(LlmInference.Backend.CPU)
                    .build()

                inference = LlmInference.createFromOptions(context, options)
                isLoaded = true
                Log.d(TAG, "Model loaded with CPU fallback")
                true
            } catch (e2: Exception) {
                Log.e(TAG, "Failed to load on CPU too: ${e2.message}")
                isLoaded = false
                false
            }
        }
    }

    /**
     * Generate a response synchronously.
     * Returns the full response text.
     */
    suspend fun generate(prompt: String, maxTokens: Int = 200): String = withContext(Dispatchers.IO) {
        val engine = inference ?: return@withContext ""
        try {
            val startTime = System.currentTimeMillis()
            val response = engine.generateResponse(prompt)
            val elapsed = System.currentTimeMillis() - startTime
            Log.d(TAG, "Generated in ${elapsed}ms: ${response.take(80)}")
            response
        } catch (e: Exception) {
            Log.e(TAG, "Generation failed: ${e.message}")
            ""
        }
    }

    fun close() {
        try {
            inference?.close()
        } catch (e: Exception) {
            Log.w(TAG, "Close error: ${e.message}")
        }
        inference = null
        isLoaded = false
    }

    fun getStatus(): String {
        return when {
            isLoaded -> "loaded"
            isModelDownloaded() -> "downloaded"
            else -> "not_downloaded"
        }
    }
}
