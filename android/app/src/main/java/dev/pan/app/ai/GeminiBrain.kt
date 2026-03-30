package dev.pan.app.ai

import javax.inject.Inject
import javax.inject.Singleton

/**
 * GeminiBrain REMOVED — all AI goes through server (Cerebras/Gemini via Tailscale).
 * Stub only — keeps Hilt injection working.
 */
@Singleton
class GeminiBrain @Inject constructor() {
    var onLog: ((String) -> Unit)? = null
    fun isAvailable(): Boolean = false
    suspend fun initialize(): Boolean = false
    enum class Action { AMBIENT, RESPOND, PHONE_COMMAND, SERVER }
    data class Decision(val action: Action, val response: String?)
    suspend fun evaluate(text: String, history: String): Decision = Decision(Action.SERVER, null)
}
