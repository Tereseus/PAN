package dev.pan.app.ai

import android.content.Context
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class GeminiBrain @Inject constructor(
    @ApplicationContext private val context: Context
) {
    companion object {
        private const val TAG = "GeminiBrain"
    }

    private var mediaPipe: MediaPipeLlm? = null
    private var available = false
    var onLog: ((String) -> Unit)? = null

    private fun log(msg: String) {
        Log.i(TAG, msg)
        onLog?.invoke("[Gemini] $msg")
    }

    suspend fun initialize(): Boolean = withContext(Dispatchers.IO) {
        try {
            log("INIT: Loading Gemma 3n via MediaPipe GPU...")
            val mp = MediaPipeLlm(context)
            if (!mp.isModelDownloaded()) {
                log("INIT: Model not downloaded")
                mediaPipe = mp; available = false; return@withContext false
            }
            val loaded = mp.loadModel()
            if (loaded) { mediaPipe = mp; available = true; log("INIT: READY"); true }
            else { mediaPipe = mp; available = false; false }
        } catch (e: Exception) { log("INIT: ${e.message}"); false }
    }

    fun isAvailable() = available

    suspend fun evaluate(text: String, conversationHistory: String): Decision = withContext(Dispatchers.IO) {
        val mp = mediaPipe
        if (!available || mp == null || !mp.isReady()) return@withContext Decision(Action.SERVER, intent = "query")
        val lower = text.lowercase()
        if (lower.contains("on my computer") || lower.contains("on my pc") || lower.contains("on the computer") ||
            lower.contains("project") || lower.contains("terminal")) return@withContext Decision(Action.SERVER, intent = "system")
        if ((lower.contains("open ") || lower.contains("launch ")) && !lower.contains("computer")) {
            val m = Regex("(?:open|launch)\\s+(.+?)(?:\\s+on.*)?$", RegexOption.IGNORE_CASE).find(lower)
            val app = m?.groupValues?.get(1)?.trim()?.replace(Regex("^(up|the|my|a)\\s+"), "")?.trim()
            if (app != null && app.length in 2..25) return@withContext Decision(Action.PHONE_COMMAND, response = "open:$app")
        }
        try {
            val t0 = System.currentTimeMillis()
            val hist = if (conversationHistory.isNotBlank()) "\nRecent:\n$conversationHistory\n" else ""
            val answer = mp.generate("You are PAN, a personal AI assistant. Answer in 1-2 short sentences.$hist\n\nUser: $text\nAnswer:")
            val ms = System.currentTimeMillis() - t0
            log("EVAL: ${ms}ms: ${answer.take(80)}")
            val trimmed = answer.trim().replace("[AMBIENT]","").replace("[RECALL]","").replace("Answer:","").trim()
            if (trimmed.length > 2) Decision(Action.RESPOND, response = trimmed)
            else Decision(Action.SERVER, intent = "query")
        } catch (e: Exception) { log("EVAL: ${e.message}"); Decision(Action.SERVER, intent = "query") }
    }

    fun close() { mediaPipe?.close(); mediaPipe = null; available = false }

    enum class Action { AMBIENT, RESPOND, PHONE_COMMAND, SERVER }
    data class Decision(val action: Action, val response: String? = null, val intent: String? = null)
}
