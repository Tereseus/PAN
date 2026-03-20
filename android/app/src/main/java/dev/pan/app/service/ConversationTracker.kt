package dev.pan.app.service

import android.util.Log

/**
 * ConversationTracker — determines if speech is directed at PAN without requiring a trigger word.
 *
 * Every transcribed chunk runs through evaluate() which returns a Decision:
 *   COMMAND  — clearly a command for PAN, route immediately
 *   RESPOND  — PAN is being spoken to conversationally, respond
 *   AMBIENT  — not for PAN, save as context but stay quiet
 *
 * Logic:
 *   1. Direct address: mentions PAN by name → COMMAND or RESPOND
 *   2. Follow-up: last PAN interaction was recent → assume continuation
 *   3. Imperative: "open X", "create X", "do X" with no other conversation partner → COMMAND
 *   4. Question: asked while in conversation with PAN → RESPOND
 *   5. Everything else → AMBIENT
 *
 * The tracker maintains a conversation window. Once PAN is addressed, it stays
 * "in conversation" for CONVERSATION_TIMEOUT_MS. During that window, all speech
 * is assumed to be for PAN unless it's clearly not (e.g., talking to someone else).
 */
class ConversationTracker {

    companion object {
        private const val TAG = "ConvoTracker"
        // How long PAN stays "in conversation" after being addressed
        private const val CONVERSATION_TIMEOUT_MS = 30_000L
        // How long after PAN responds that follow-ups are assumed
        private const val FOLLOWUP_WINDOW_MS = 15_000L
    }

    enum class Decision {
        COMMAND,  // Execute as a command
        RESPOND,  // Respond conversationally
        AMBIENT   // Save but stay quiet
    }

    // Conversation state
    private var lastAddressedTime = 0L      // Last time PAN was directly addressed
    private var lastPanResponseTime = 0L    // Last time PAN spoke back
    private var inConversation = false       // Currently in a conversation with PAN
    private var recentContext = mutableListOf<String>() // Last few chunks for context
    private var onLog: ((String) -> Unit)? = null

    fun setLogger(logger: (String) -> Unit) {
        onLog = logger
    }

    private fun log(msg: String) {
        Log.i(TAG, msg)
        onLog?.invoke("[Convo] $msg")
    }

    // Call this when PAN responds to the user (TTS speaks)
    fun onPanResponded() {
        lastPanResponseTime = System.currentTimeMillis()
        inConversation = true
    }

    // Call this when a command is successfully executed
    fun onCommandExecuted() {
        lastPanResponseTime = System.currentTimeMillis()
        inConversation = true
    }

    fun evaluate(text: String): Decision {
        val now = System.currentTimeMillis()
        val lower = text.lowercase().trim()
        val timeSinceAddressed = now - lastAddressedTime
        val timeSinceResponse = now - lastPanResponseTime

        // Keep recent context (last 5 chunks)
        recentContext.add(lower)
        if (recentContext.size > 5) recentContext.removeAt(0)

        // 1. Direct address — mentions PAN by name
        if (isDirectAddress(lower)) {
            lastAddressedTime = now
            inConversation = true
            val decision = if (isCommand(lower)) Decision.COMMAND else Decision.RESPOND
            log("Direct address: '$lower' -> $decision")
            return decision
        }

        // 2. Follow-up — PAN just responded, this is likely continuation
        if (inConversation && timeSinceResponse < FOLLOWUP_WINDOW_MS) {
            val decision = if (isCommand(lower)) Decision.COMMAND else Decision.RESPOND
            log("Follow-up (${timeSinceResponse}ms since response): '$lower' -> $decision")
            return decision
        }

        // 3. Still in conversation window but no recent response
        if (inConversation && timeSinceAddressed < CONVERSATION_TIMEOUT_MS) {
            // Check if this looks like it's still directed at PAN
            if (isCommand(lower) || isQuestion(lower)) {
                val decision = if (isCommand(lower)) Decision.COMMAND else Decision.RESPOND
                log("In conversation window: '$lower' -> $decision")
                return decision
            }
        }

        // 4. Not in conversation — check for standalone commands without "hey pan"
        //    These are strong imperatives that are clearly meant for an assistant
        if (isStrongCommand(lower)) {
            lastAddressedTime = now
            inConversation = true
            log("Strong command (no address): '$lower' -> COMMAND")
            return Decision.COMMAND
        }

        // 5. Conversation timed out
        if (inConversation && timeSinceAddressed >= CONVERSATION_TIMEOUT_MS) {
            inConversation = false
            log("Conversation timed out")
        }

        // 6. Ambient — not for PAN
        log("Ambient: '${lower.take(50)}...'")
        return Decision.AMBIENT
    }

    // Check if PAN is addressed by name (handles Whisper mishearings)
    private fun isDirectAddress(lower: String): Boolean {
        val panNames = listOf(
            "hey pan", "hey pam", "hey pen", "hey ben",  // common mishearings
            "hi pan", "hi pam",
            "okay pan", "ok pan", "ok pam",
            "pan,", "pan ", "pam,", "pam ",  // "Pan, can you..."
            "yo pan", "yo pam",
        )
        // Check start of text or after a pause marker
        return panNames.any { lower.startsWith(it) || lower.contains(". $it") || lower.contains(", $it") }
    }

    // Check if text contains a command pattern
    private fun isCommand(lower: String): Boolean {
        val commandPatterns = listOf(
            Regex("(open|launch|start|close|stop)\\s+"),
            Regex("(create|make|delete|remove)\\s+"),
            Regex("(add|put|save|remember)\\s+"),
            Regex("(set|change|turn|switch)\\s+"),
            Regex("(send|email|text|call|message)\\s+"),
            Regex("(play|pause|skip|next|previous)\\s+"),
            Regex("(search|find|look up|google)\\s+"),
            Regex("(schedule|remind|timer|alarm)\\s+"),
            Regex("(what time|what's the time|what date|what day)"),
            Regex("(how much battery|battery level)"),
        )
        return commandPatterns.any { it.containsMatchIn(lower) }
    }

    // Strong commands that are clearly for an AI assistant even without "hey pan"
    // These should NOT trigger on normal conversation fragments
    private fun isStrongCommand(lower: String): Boolean {
        // Only trigger on clear, unambiguous assistant commands
        // Must start with an imperative verb (not buried in a sentence)
        val strongPatterns = listOf(
            Regex("^(open|launch)\\s+(the\\s+)?\\w+"),           // "open YouTube"
            Regex("^(create|make)\\s+(a\\s+)?(folder|file)"),    // "create a folder"
            Regex("^(delete|remove)\\s+(the\\s+)?(folder|file)"), // "delete the folder"
            Regex("^(remind me|set a reminder|set a timer)"),     // "remind me to..."
            Regex("^(what time|what's the time|what day)"),       // "what time is it"
            Regex("^(how much battery|battery level)"),           // "how much battery"
        )
        return strongPatterns.any { it.containsMatchIn(lower) }
    }

    // Check if text is a question
    private fun isQuestion(lower: String): Boolean {
        return lower.contains("?") ||
            lower.startsWith("what ") || lower.startsWith("how ") ||
            lower.startsWith("where ") || lower.startsWith("when ") ||
            lower.startsWith("why ") || lower.startsWith("can you ") ||
            lower.startsWith("could you ") || lower.startsWith("do you ") ||
            lower.startsWith("is there ") || lower.startsWith("are there ")
    }
}
