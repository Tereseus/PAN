package dev.pan.app.ai

import android.app.ActivityManager
import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
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
        val description: String,
        val role: String = "conversation" // "classifier" or "conversation"
    )

    companion object {
        val AVAILABLE_MODELS = mutableListOf(
            ModelInfo(
                id = "qwen3-0.6b",
                name = "Qwen 3 0.6B",
                filename = "Qwen3-0.6B-Q4_K_M.gguf",
                url = "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf",
                sizeBytes = 397_000_000,
                minRamMb = 2048,
                description = "Ultra-fast intent classifier. Best for routing.",
                role = "classifier"
            ),
            ModelInfo(
                id = "gemma-3-1b",
                name = "Gemma 3 1B",
                filename = "gemma-3-1b-it-Q4_K_M.gguf",
                url = "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q4_K_M.gguf",
                sizeBytes = 806_000_000,
                minRamMb = 4096,
                description = "Fast conversation. Optimized for Pixel GPUs.",
                role = "conversation"
            ),
            ModelInfo(
                id = "llama-3.2-1b",
                name = "Llama 3.2 1B",
                filename = "llama-3.2-1b-q4_k_m.gguf",
                url = "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
                sizeBytes = 776_000_000,
                minRamMb = 4096,
                description = "Basic conversation. Works on all phones."
            ),
            ModelInfo(
                id = "llama-3.2-3b",
                name = "Llama 3.2 3B",
                filename = "llama-3.2-3b-q4_k_m.gguf",
                url = "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
                sizeBytes = 2_020_000_000,
                minRamMb = 6144,
                description = "Good conversation quality. Needs 6GB+ RAM."
            ),
            ModelInfo(
                id = "phi-3.5-mini",
                name = "Phi 3.5 Mini",
                filename = "phi-3.5-mini-q4_k_m.gguf",
                url = "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf",
                sizeBytes = 2_300_000_000,
                minRamMb = 8192,
                description = "Strong reasoning. Needs 8GB+ RAM."
            ),
        )

        // Add a custom model from a GGUF URL
        fun addCustomModel(id: String, name: String, url: String, sizeBytes: Long, role: String = "conversation") {
            val filename = url.substringAfterLast("/")
            AVAILABLE_MODELS.add(ModelInfo(
                id = id,
                name = name,
                filename = filename,
                url = url,
                sizeBytes = sizeBytes,
                minRamMb = 2048,
                description = "Custom model",
                role = role
            ))
        }
    }

    // State
    private var engine: com.arm.aichat.InferenceEngine? = null
    private var isLoaded = false
    private var currentModel: ModelInfo? = null
    private var loadedModelId: String? = null

    // Get total device RAM in MB
    fun getDeviceRamMb(): Int {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        return (memInfo.totalMem / (1024 * 1024)).toInt()
    }

    // Recommend best model for this device — prioritize speed
    fun getRecommendedModel(): ModelInfo {
        val ram = getDeviceRamMb()
        Log.d(TAG, "Device RAM: ${ram}MB")
        // Default to Qwen 3 0.6B — fastest classifier
        return AVAILABLE_MODELS.first { it.id == "qwen3-0.6b" }
    }

    // Get currently selected model (for backward compat — returns classifier)
    fun getSelectedModel(): ModelInfo {
        val selectedId = prefs.getString("selected_model", null)
            ?: prefs.getString("classifier_model", null)
        if (selectedId != null) {
            return AVAILABLE_MODELS.find { it.id == selectedId } ?: getRecommendedModel()
        }
        return getRecommendedModel()
    }

    fun getClassifierModel(): ModelInfo {
        val id = prefs.getString("classifier_model", null)
        return if (id != null) AVAILABLE_MODELS.find { it.id == id } ?: getRecommendedModel()
        else getRecommendedModel()
    }

    fun getConversationModel(): ModelInfo? {
        val id = prefs.getString("conversation_model", null) ?: return null
        return AVAILABLE_MODELS.find { it.id == id }
    }

    // Set model preference
    fun selectModel(modelId: String) {
        prefs.edit().putString("selected_model", modelId).apply()
    }

    fun selectClassifierModel(modelId: String) {
        prefs.edit().putString("classifier_model", modelId).apply()
    }

    fun selectConversationModel(modelId: String) {
        prefs.edit().putString("conversation_model", modelId).apply()
    }

    // Delete a downloaded model file
    fun deleteModel(model: ModelInfo): Boolean {
        val file = File(modelsDir, model.filename)
        if (currentModel?.id == model.id && isLoaded) {
            // Can't delete the active model — unload first
            engine?.cleanUp()
            engine = null
            isLoaded = false
            currentModel = null
        }
        return if (file.exists()) file.delete() else true
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

    // Classify intent from user text — uses classifier model
    suspend fun classifyIntent(text: String): IntentResult = withContext(Dispatchers.IO) {
        // Ensure classifier model is loaded
        if (!ensureClassifier()) {
            return@withContext IntentResult("unknown", text, null, false)
        }

        try {
            val prompt = buildIntentPrompt(text)
            val startTime = System.currentTimeMillis()
            val response = infer(prompt, maxTokens = 80)
            val elapsed = System.currentTimeMillis() - startTime

            Log.d(TAG, "Intent classified in ${elapsed}ms: ${response.take(100)}")
            parseIntentResponse(response, text, elapsed)
        } catch (e: Exception) {
            Log.e(TAG, "Classify failed: ${e.message}")
            IntentResult("unknown", text, null, false)
        }
    }

    // Full conversation response — swaps to conversation model if available
    suspend fun chat(text: String, context: String = ""): String = withContext(Dispatchers.IO) {
        // Swap to conversation model if one is configured
        if (!ensureConversation()) return@withContext ""

        try {
            val prompt = buildChatPrompt(text, context)
            infer(prompt, maxTokens = 200)
        } catch (e: Exception) {
            Log.e(TAG, "Chat failed: ${e.message}")
            ""
        }
    }

    // Load a specific model into memory
    suspend fun loadModel(model: ModelInfo? = null): Boolean {
        val target = model ?: getClassifierModel()
        val modelFile = File(modelsDir, target.filename)
        if (!modelFile.exists()) {
            Log.w(TAG, "Model file not found: ${modelFile.absolutePath}")
            return false
        }

        // If a different model is already loaded, unload first
        if (isLoaded && loadedModelId != target.id) {
            Log.d(TAG, "Swapping model: ${loadedModelId} → ${target.id}")
            engine?.cleanUp()
            isLoaded = false
            loadedModelId = null
            currentModel = null
        }

        // Already loaded
        if (isLoaded && loadedModelId == target.id) return true

        return try {
            val startTime = System.currentTimeMillis()
            Log.d(TAG, "Loading model: ${target.name}...")

            val eng = com.arm.aichat.AiChat.getInferenceEngine(context)

            // Wait for native library init to complete (it's async in the constructor)
            Log.d(TAG, "Waiting for engine init (state: ${eng.state.value})...")
            eng.state.first { it is com.arm.aichat.InferenceEngine.State.Initialized
                    || it is com.arm.aichat.InferenceEngine.State.ModelReady
                    || it is com.arm.aichat.InferenceEngine.State.Error }
            if (eng.state.value is com.arm.aichat.InferenceEngine.State.Error) {
                Log.e(TAG, "Engine init failed, cannot load model")
                return false
            }
            Log.d(TAG, "Engine ready, loading model file...")

            eng.loadModel(modelFile.absolutePath)

            // Set system prompt based on model role
            val systemPrompt = if (target.role == "classifier") {
                "/no_think Classify user requests. Output ONLY a JSON object. Valid intents: play_music, send_message, navigate, open_app, search, calendar, camera, system, query, recall, terminal, ambient. recall = searching past conversations or history. Output format: {\"intent\":\"X\",\"query\":\"Y\"}"
            } else {
                "You are PAN, a personal AI assistant. Be concise and helpful. Respond in 1-3 sentences."
            }
            eng.setSystemPrompt(systemPrompt)

            engine = eng
            isLoaded = true
            currentModel = target
            loadedModelId = target.id

            val elapsed = System.currentTimeMillis() - startTime
            Log.d(TAG, "Model loaded in ${elapsed}ms: ${target.name}")
            true
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to load model: ${e.message}")
            isLoaded = false
            loadedModelId = null
            false
        }
    }

    // Ensure the classifier model is loaded (swap if needed)
    suspend fun ensureClassifier(): Boolean {
        val classifier = getClassifierModel()
        if (loadedModelId == classifier.id && isLoaded) return true
        return loadModel(classifier)
    }

    // Ensure the conversation model is loaded (swap if needed)
    // Falls back to classifier if no conversation model is set
    suspend fun ensureConversation(): Boolean {
        val convo = getConversationModel() ?: getClassifierModel()
        if (loadedModelId == convo.id && isLoaded) return true
        return loadModel(convo)
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
        return text
    }

    private fun buildChatPrompt(text: String, conversationContext: String): String {
        return text
    }

    private fun parseIntentResponse(response: String, originalText: String, elapsedMs: Long): IntentResult {
        return try {
            // Strip <think>...</think> blocks if present (Qwen 3 reasoning mode)
            var cleaned = response.trim()
            val thinkEnd = cleaned.indexOf("</think>")
            if (thinkEnd >= 0) {
                cleaned = cleaned.substring(thinkEnd + "</think>".length).trim()
            }
            // Extract JSON object from response
            val jsonStart = cleaned.indexOf("{")
            val jsonEnd = cleaned.lastIndexOf("}") + 1
            if (jsonStart >= 0 && jsonEnd > jsonStart) {
                cleaned = cleaned.substring(jsonStart, jsonEnd)
            }
            val json = org.json.JSONObject(cleaned)
            // Accept "intent" or "category" key (Qwen sometimes uses "category")
            val intent = json.optString("intent", "") .ifEmpty { json.optString("category", "") }.ifEmpty { "unknown" }
            IntentResult(
                intent = intent,
                query = json.optString("query", json.optString("question", originalText)),
                service = json.optString("service", null),
                local = true,
                elapsedMs = elapsedMs,
                raw = response
            )
        } catch (_: Exception) {
            Log.w(TAG, "Failed to parse intent response: ${response.take(200)}")
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
