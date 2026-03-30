package dev.pan.app.ai

import android.content.Context

/**
 * MediaPipe LLM REMOVED — all AI goes through server (Cerebras/Gemini via Tailscale).
 * This stub exists so other code that references MediaPipeLlm compiles.
 */
class MediaPipeLlm {
    fun isLoaded(): Boolean = false
    fun isDownloaded(context: Context): Boolean = false
    suspend fun download(context: Context, onProgress: (Float) -> Unit = {}) {}
    suspend fun load(context: Context): Boolean = false
    suspend fun generate(prompt: String): String = ""
    fun close() {}
}
