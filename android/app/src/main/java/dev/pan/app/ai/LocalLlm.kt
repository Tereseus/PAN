package dev.pan.app.ai

import android.app.ActivityManager
import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import java.io.File
import java.net.URL

/**
 * PAN Local LLM — runs a conversational model directly on the phone.
 *
 * Auto-selects model based on available RAM:
 * - 4GB: Llama 3.2 1B Q4 (~700MB, basic understanding)
 * - 6-8GB: Llama 3.2 3B Q4 (~2GB, good conversation)
 * - 12GB+: Phi-3.5 mini Q4 (~2.2GB, strong reasoning)
 *
 * Used as the first-pass intent classifier and local conversation handler.
 * Falls back to server (Claude) for complex tasks or when model isn't downloaded yet.
 */
class LocalLlm(private val context: Context) {
    private val TAG = "PAN-LocalLLM"
    private val prefs: SharedPreferences = context.getSharedPreferences("pan_llm", Context.MODE_PRIVATE)
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val modelsDir = File(context.filesDir, "models")

    // Model definitions
    data class ModelInfo(
        val id: String,
        val name: String,
        val filename: String,
        val url: String,
        val sizeBytes: Long,
        val minRamMb: Int,
        val description: String
    )

    companion object {
        val AVAILABLE_MODELS = listOf(
            ModelInfo(
                id = "llama-3.2-1b",
                name = "Llama 3.2 1B",
                filename = "llama-3.2-1b-q4_k_m.gguf",
                url = "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
                sizeBytes = 776_000_000,
                minRamMb = 4096,
                description = "Fast, basic understanding. Works on all phones."
            ),
            ModelInfo(
                id = "llama-3.2-3b",
                name = "Llama 3.2 3B",
                filename = "llama-3.2-3b-q4_k_m.gguf",
                url = "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
                sizeBytes = 2_020_000_000,
                minRamMb = 6144,
                description = "Good conversation quality. Recommended for most phones."
            ),
            ModelInfo(
                id = "phi-3.5-mini",
                name = "Phi 3.5 Mini",
                filename = "phi-3.5-mini-q4_k_m.gguf",
                url = "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf",
                sizeBytes = 2_300_000_000,
                minRamMb = 8192,
                description = "Strong reasoning. Best for phones with 8GB+ RAM."
            ),
        )
    }

    // State
    private var engine: com.arm.aichat.InferenceEngine? = null
    private var isLoaded = false
    private var currentModel: ModelInfo? = null

    // Get total device RAM in MB
    fun getDeviceRamMb(): Int {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        return (memInfo.totalMem / (1024 * 1024)).toInt()
    }

    // Recommend best model for this device
    // Prioritize speed — use 1B until GPU acceleration is confirmed working
    fun getRecommendedModel(): ModelInfo {
        val ram = getDeviceRamMb()
        Log.d(TAG, "Device RAM: ${ram}MB")
        // Use 1B for speed until GPU backend is available
        return AVAILABLE_MODELS.first() // llama-3.2-1b
    }

    // Get currently selected model
    fun getSelectedModel(): ModelInfo {
        val selectedId = prefs.getString("selected_model", null)
        if (selectedId != null) {
            return AVAILABLE_MODELS.find { it.id == selectedId } ?: getRecommendedModel()
        }
        return getRecommendedModel()
    }

    // Set model preference
    fun selectModel(modelId: String) {
        prefs.edit().putString("selected_model", modelId).apply()
    }

    // Check if model file is downloaded
    fun isModelDownloaded(model: ModelInfo = getSelectedModel()): Boolean {
        val file = File(modelsDir, model.filename)
        return file.exists() && file.length() > model.sizeBytes * 0.9 // allow 10% variance
    }

    // Download model (call from coroutine)
    suspend fun downloadModel(
        model: ModelInfo = getSelectedModel(),
        onProgress: (Float) -> Unit = {}
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            modelsDir.mkdirs()
            val file = File(modelsDir, model.filename)
            val tempFile = File(modelsDir, "${model.filename}.tmp")

            Log.d(TAG, "Downloading ${model.name} (${model.sizeBytes / 1_000_000}MB)...")

            val connection = URL(model.url).openConnection()
            connection.connectTimeout = 15000
            val totalBytes = connection.contentLengthLong.takeIf { it > 0 } ?: model.sizeBytes

            connection.getInputStream().use { input ->
                tempFile.outputStream().use { output ->
                    val buffer = ByteArray(8192)
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
            Log.d(TAG, "Download complete: ${file.absolutePath}")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Download failed: ${e.message}")
            false
        }
    }

    // Get download progress file info
    fun getModelStatus(model: ModelInfo = getSelectedModel()): String {
        val file = File(modelsDir, model.filename)
        return when {
            !file.exists() -> "not_downloaded"
            file.length() < model.sizeBytes * 0.9 -> "incomplete"
            !isLoaded -> "downloaded"
            else -> "loaded"
        }
    }

    // Classify intent from user text — fast, used for routing
    suspend fun classifyIntent(text: String): IntentResult = withContext(Dispatchers.IO) {
        if (!isLoaded) {
            return@withContext IntentResult("unknown", text, null, false)
        }

        try {
            val prompt = buildIntentPrompt(text)
            val startTime = System.currentTimeMillis()
            val response = infer(prompt, maxTokens = 100)
            val elapsed = System.currentTimeMillis() - startTime

            Log.d(TAG, "Intent classified in ${elapsed}ms: ${response.take(100)}")
            parseIntentResponse(response, text, elapsed)
        } catch (e: Exception) {
            Log.e(TAG, "Classify failed: ${e.message}")
            IntentResult("unknown", text, null, false)
        }
    }

    // Full conversation response — used when handling locally
    suspend fun chat(text: String, context: String = ""): String = withContext(Dispatchers.IO) {
        if (!isLoaded) return@withContext ""

        try {
            val prompt = buildChatPrompt(text, context)
            infer(prompt, maxTokens = 200)
        } catch (e: Exception) {
            Log.e(TAG, "Chat failed: ${e.message}")
            ""
        }
    }

    // Load the model into memory — call once after download
    suspend fun loadModel(): Boolean {
        val model = getSelectedModel()
        val modelFile = File(modelsDir, model.filename)
        if (!modelFile.exists()) {
            Log.w(TAG, "Model file not found: ${modelFile.absolutePath}")
            return false
        }

        return try {
            val startTime = System.currentTimeMillis()
            Log.d(TAG, "Loading model: ${model.name}...")

            val eng = com.arm.aichat.AiChat.getInferenceEngine(context)
            eng.loadModel(modelFile.absolutePath)
            eng.setSystemPrompt("You are PAN's intent classifier. Classify user requests into JSON. Categories: play_music, send_message, navigate, open_app, search, calendar, camera, system, query, ambient. Always respond with only JSON.")

            engine = eng
            isLoaded = true
            currentModel = model

            val elapsed = System.currentTimeMillis() - startTime
            Log.d(TAG, "Model loaded in ${elapsed}ms")
            true
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to load model: ${e.message}")
            isLoaded = false
            false
        }
    }

    // Low-level inference — calls llama.cpp via JNI (ARM64 native)
    private suspend fun infer(prompt: String, maxTokens: Int = 150): String {
        val eng = engine ?: return ""

        return try {
            val sb = StringBuilder()
            eng.sendUserPrompt(prompt, maxTokens).collect { token ->
                sb.append(token)
            }
            sb.toString().trim()
        } catch (e: Throwable) {
            Log.e(TAG, "Inference failed: ${e.message}")
            ""
        }
    }

    private fun buildIntentPrompt(text: String): String {
        return """<|begin_of_text|><|start_header_id|>system<|end_header_id|>
You are PAN's intent classifier. Classify the user's request into exactly one category and extract the key parameters. Respond in JSON only.

Categories: play_music, send_message, navigate, open_app, search, calendar, camera, system, query, ambient

Example outputs:
{"intent":"play_music","query":"bohemian rhapsody","service":"youtube"}
{"intent":"send_message","recipient":"Marcus","message":"I'm running late"}
{"intent":"navigate","destination":"nearest gas station"}
{"intent":"query","question":"what was that restaurant my friend mentioned"}
{"intent":"ambient"}
<|eot_id|><|start_header_id|>user<|end_header_id|>
$text<|eot_id|><|start_header_id|>assistant<|end_header_id|>
"""
    }

    private fun buildChatPrompt(text: String, conversationContext: String): String {
        return """<|begin_of_text|><|start_header_id|>system<|end_header_id|>
You are PAN, a personal AI assistant. Be concise and helpful. Respond in 1-3 sentences.
$conversationContext<|eot_id|><|start_header_id|>user<|end_header_id|>
$text<|eot_id|><|start_header_id|>assistant<|end_header_id|>
"""
    }

    private fun parseIntentResponse(response: String, originalText: String, elapsedMs: Long): IntentResult {
        return try {
            // Try to parse JSON response
            val json = org.json.JSONObject(response.trim())
            IntentResult(
                intent = json.getString("intent"),
                query = json.optString("query", originalText),
                service = json.optString("service", null),
                local = true,
                elapsedMs = elapsedMs,
                raw = response
            )
        } catch (_: Exception) {
            IntentResult("unknown", originalText, null, false, elapsedMs, response)
        }
    }

    fun cleanup() {
        scope.cancel()
        // Release native resources when implemented
    }

    data class IntentResult(
        val intent: String,
        val query: String,
        val service: String?,
        val local: Boolean,
        val elapsedMs: Long = 0,
        val raw: String? = null
    )
}
