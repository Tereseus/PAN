package dev.pan.app.ai

import android.content.Context
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * GeminiBrain — on-device AI using Gemini Nano.
 * Tries AI Edge SDK first (direct AICore), falls back to ML Kit.
 * If neither works, falls back to server.
 */
@Singleton
class GeminiBrain @Inject constructor(
    @ApplicationContext private val context: Context
) {
    companion object {
        private const val TAG = "GeminiBrain"
    }

    // AI Edge SDK model
    private var aiEdgeModel: com.google.ai.edge.aicore.GenerativeModel? = null
    private var available = false
    var onLog: ((String) -> Unit)? = null

    private fun log(msg: String) {
        Log.i(TAG, msg)
        onLog?.invoke("[Gemini] $msg")
    }

    suspend fun initialize(): Boolean {
        return withContext(Dispatchers.IO) {
            // Try AI Edge SDK (direct AICore)
            try {
                log("INIT: Trying AI Edge SDK...")
                val config = com.google.ai.edge.aicore.generationConfig {
                    this.context = this@GeminiBrain.context
                    temperature = 0.7f
                    topK = 16
                    maxOutputTokens = 256
                }
                val model = com.google.ai.edge.aicore.GenerativeModel(config)
                aiEdgeModel = model
                available = true
                log("INIT: AI Edge SDK READY")
                return@withContext true
            } catch (e: Exception) {
                log("INIT: AI Edge SDK failed: ${e::class.simpleName} ${e.message}")
            }

            // Try ML Kit as fallback
            try {
                log("INIT: Trying ML Kit...")
                val client = com.google.mlkit.genai.prompt.Generation.getClient()
                log("INIT: ML Kit client obtained, checking status...")
                val status = client.checkStatus()
                log("INIT: ML Kit status=$status")

                if (status == 0 || status == 1) {
                    // Wrap ML Kit in a simple adapter
                    available = true
                    log("INIT: ML Kit READY")
                    return@withContext true
                }
            } catch (e: Exception) {
                log("INIT: ML Kit failed: ${e::class.simpleName} ${e.message}")
            }

            log("INIT: No local AI available, using server fallback")
            available = false
            false
        }
    }

    fun isAvailable() = available

    suspend fun evaluate(
        text: String,
        conversationHistory: String
    ): Decision = withContext(Dispatchers.IO) {
        if (!available || aiEdgeModel == null) {
            log("EVAL: Not available, falling back to server")
            return@withContext Decision(Action.SERVER, intent = "query")
        }

        val lower = text.lowercase()
        log("EVAL: Processing '$text'")

        // Quick local checks — skip AI for obvious cases
        if (lower.contains("on my computer") || lower.contains("on my pc") ||
            lower.contains("on the computer") || lower.contains("on my desktop") ||
            lower.contains("project") || lower.contains("terminal") ||
            lower.contains("make a folder") || lower.contains("create a folder") ||
            lower.contains("delete a folder") || lower.contains("create a file")) {
            log("EVAL: PC command → server")
            return@withContext Decision(Action.SERVER, intent = "system")
        }

        // Phone app launch
        if ((lower.contains("open ") || lower.contains("launch ")) &&
            !lower.contains("computer") && !lower.contains("project")) {
            val appMatch = Regex("(?:open|launch)\\s+(.+?)(?:\\s+on.*)?$", RegexOption.IGNORE_CASE).find(lower)
            val appName = appMatch?.groupValues?.get(1)?.trim()
                ?.replace(Regex("^(up|the|my|a)\\s+", RegexOption.IGNORE_CASE), "")?.trim()
            if (appName != null && appName.length in 2..25) {
                log("EVAL: Phone app → $appName")
                return@withContext Decision(Action.PHONE_COMMAND, response = "open:$appName")
            }
        }

        // Use Gemini Nano for classification + answer
        try {
            // Step 1: Is this for PAN?
            val classifyResult = aiEdgeModel!!.generateContent(
                "Is this speech directed at an AI assistant or is it ambient background noise? Reply DIRECTED or AMBIENT only.\n\nSpeech: \"$text\""
            )
            val classification = classifyResult.text?.trim()?.uppercase() ?: ""
            log("EVAL: Classification = $classification")

            if (classification.contains("AMBIENT")) {
                return@withContext Decision(Action.AMBIENT)
            }

            // Step 2: Answer directly
            val historyBlock = if (conversationHistory.isNotBlank()) {
                "\nRecent conversation:\n$conversationHistory\n"
            } else ""

            val answerResult = aiEdgeModel!!.generateContent(
                "You are PAN, a helpful AI assistant. Answer naturally in 1-2 short sentences (spoken aloud via TTS).$historyBlock\n\nUser: $text\n\nAnswer:"
            )
            val answer = answerResult.text?.trim() ?: ""
            log("EVAL: Answer = $answer")

            if (answer.isNotBlank()) {
                Decision(Action.RESPOND, response = answer)
            } else {
                Decision(Action.SERVER, intent = "query")
            }
        } catch (e: Exception) {
            log("EVAL: Gemini error: ${e::class.simpleName} ${e.message}")
            Decision(Action.SERVER, intent = "query")
        }
    }

    enum class Action {
        AMBIENT,
        RESPOND,
        PHONE_COMMAND,
        SERVER
    }

    data class Decision(
        val action: Action,
        val response: String? = null,
        val intent: String? = null
    )
}
