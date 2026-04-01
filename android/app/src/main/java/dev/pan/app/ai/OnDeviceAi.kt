package dev.pan.app.ai

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log

/**
 * Dynamic on-device AI provider detection.
 * Probes for whatever AI runtime the phone OS provides:
 * - Google AICore (Gemini Nano) — Pixel 8 Pro+, some Samsung/others via Google Play Services
 * - Samsung Galaxy AI — Galaxy S24+ (via Samsung Neural Engine)
 * - MediaPipe LLM Inference — any Android with 4GB+ RAM (requires bundled model)
 * - Fallback: regex classifier (always available, zero latency)
 *
 * Usage:
 *   val ai = OnDeviceAi(context)
 *   ai.initialize()
 *   if (ai.isAvailable()) {
 *       val result = ai.classify("open spotify")
 *       // result = "system" or "query" or "ambient" etc.
 *   }
 */
class OnDeviceAi(private val context: Context) {

    companion object {
        private const val TAG = "OnDeviceAi"
    }

    enum class Provider {
        GOOGLE_AICORE,      // Gemini Nano via Google Play Services AICore
        SAMSUNG_NEURAL,     // Samsung on-device AI
        MEDIAPIPE,          // MediaPipe LLM Inference (any Android)
        REGEX_ONLY          // Pure regex — always works, zero latency
    }

    var activeProvider: Provider = Provider.REGEX_ONLY
        private set
    var providerName: String = "Regex"
        private set
    var onLog: ((String) -> Unit)? = null

    private fun log(msg: String) {
        Log.i(TAG, msg)
        onLog?.invoke(msg)
    }

    /**
     * Probe for available AI providers in order of preference.
     * Call once on app start.
     */
    fun initialize() {
        log("Probing for on-device AI providers...")

        // 1. Google AICore (Gemini Nano)
        if (hasGoogleAiCore()) {
            activeProvider = Provider.GOOGLE_AICORE
            providerName = "Google AICore (Gemini Nano)"
            log("Found: $providerName")
            return
        }

        // 2. Samsung Neural Engine
        if (hasSamsungNeural()) {
            activeProvider = Provider.SAMSUNG_NEURAL
            providerName = "Samsung Galaxy AI"
            log("Found: $providerName")
            return
        }

        // 3. MediaPipe (requires bundled model — check if model file exists)
        if (hasMediaPipe()) {
            activeProvider = Provider.MEDIAPIPE
            providerName = "MediaPipe LLM"
            log("Found: $providerName")
            return
        }

        // 4. Fallback
        activeProvider = Provider.REGEX_ONLY
        providerName = "Regex (no on-device AI available)"
        log("No on-device AI found. Using regex classifier.")
    }

    fun isAvailable(): Boolean = activeProvider != Provider.REGEX_ONLY

    /**
     * Classify text using the best available on-device AI.
     * Returns intent string: "query", "system", "ambient", "local", etc.
     * Falls back to null if on-device AI can't classify (caller should use regex).
     */
    suspend fun classify(text: String): String? {
        return when (activeProvider) {
            Provider.GOOGLE_AICORE -> classifyWithGoogleAiCore(text)
            Provider.SAMSUNG_NEURAL -> classifyWithSamsung(text)
            Provider.MEDIAPIPE -> classifyWithMediaPipe(text)
            Provider.REGEX_ONLY -> null // Caller uses regex
        }
    }

    // === Provider Detection ===

    private fun hasGoogleAiCore(): Boolean {
        return try {
            // AICore is a Google Play Services module — check if the service exists
            val pm = context.packageManager
            val aiCoreInfo = pm.getApplicationInfo("com.google.android.aicore", 0)
            val enabled = aiCoreInfo.enabled
            log("Google AICore package found, enabled=$enabled")
            // Also check if the GenAI API class is available at runtime
            val genaiAvailable = try {
                Class.forName("com.google.ai.edge.localagents.fc.LocalAgents")
                true
            } catch (_: ClassNotFoundException) {
                try {
                    Class.forName("com.google.android.gms.genai.GenerativeModel")
                    true
                } catch (_: ClassNotFoundException) {
                    false
                }
            }
            log("Google GenAI API available=$genaiAvailable")
            enabled && genaiAvailable
        } catch (_: PackageManager.NameNotFoundException) {
            log("Google AICore not installed")
            false
        } catch (e: Exception) {
            log("Google AICore check failed: ${e.message}")
            false
        }
    }

    private fun hasSamsungNeural(): Boolean {
        return try {
            // Samsung's on-device AI SDK
            val pm = context.packageManager
            // Check for Samsung's AI service packages
            val samsungAiPackages = listOf(
                "com.samsung.android.aiplugin",
                "com.samsung.android.intelligenceservice",
                "com.samsung.android.aiagent"
            )
            val found = samsungAiPackages.any { pkg ->
                try {
                    pm.getApplicationInfo(pkg, 0)
                    true
                } catch (_: PackageManager.NameNotFoundException) {
                    false
                }
            }
            if (found) log("Samsung AI service found")
            // Also check if Samsung AI SDK classes are available
            val sdkAvailable = try {
                Class.forName("com.samsung.android.sdk.ai.SamsungAI")
                true
            } catch (_: ClassNotFoundException) {
                false
            }
            found && sdkAvailable
        } catch (e: Exception) {
            log("Samsung AI check failed: ${e.message}")
            false
        }
    }

    private fun hasMediaPipe(): Boolean {
        return try {
            // Check if MediaPipe LLM Inference classes are available
            Class.forName("com.google.mediapipe.tasks.genai.llminference.LlmInference")
            // Also need a model file in assets or internal storage
            val modelExists = context.assets.list("")?.any { it.endsWith(".bin") || it.endsWith(".task") } == true
                    || context.filesDir.resolve("models").listFiles()?.isNotEmpty() == true
            log("MediaPipe LLM available, model present=$modelExists")
            modelExists
        } catch (_: ClassNotFoundException) {
            false
        }
    }

    // === Classification Implementations ===
    // These are stubs — will be implemented when the respective SDKs are added to dependencies

    private suspend fun classifyWithGoogleAiCore(text: String): String? {
        // TODO: Implement when com.google.ai.edge:localagents dependency is added
        // val model = GenerativeModel("gemini-nano")
        // val response = model.generateContent("Classify: $text")
        log("Google AICore classify not yet implemented")
        return null
    }

    private suspend fun classifyWithSamsung(text: String): String? {
        // TODO: Implement when Samsung AI SDK dependency is added
        log("Samsung AI classify not yet implemented")
        return null
    }

    private suspend fun classifyWithMediaPipe(text: String): String? {
        // TODO: Implement when MediaPipe tasks-genai dependency is added
        log("MediaPipe classify not yet implemented")
        return null
    }

    /**
     * Returns a human-readable status for the settings page.
     */
    fun getStatus(): String {
        return when (activeProvider) {
            Provider.GOOGLE_AICORE -> "Google AICore (Gemini Nano) - Active"
            Provider.SAMSUNG_NEURAL -> "Samsung Galaxy AI - Active"
            Provider.MEDIAPIPE -> "MediaPipe LLM - Active"
            Provider.REGEX_ONLY -> "No on-device AI - Using regex classifier"
        }
    }
}
