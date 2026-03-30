package dev.pan.app.ai

import android.content.Context
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Local LLM REMOVED — all AI goes through server (Cerebras/Gemini via Tailscale).
 * This stub keeps the IntentResult data class and minimal interface so existing code compiles.
 * Offline fallback: "I can't reach the server right now."
 */
@Singleton
class LocalLlm @Inject constructor(private val context: Context) {

    fun chat(text: String, historyContext: String): String {
        return "" // No local model — server handles all AI
    }

    fun isModelDownloaded(): Boolean = false

    data class IntentResult(
        val intent: String,
        val query: String,
        val service: String?,
        val local: Boolean,
        val elapsedMs: Long = 0,
        val raw: String? = null
    )
}
