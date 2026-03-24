package dev.pan.app.network.dto

data class AudioUpload(
    val transcript: String,
    val timestamp: Long,
    val duration_ms: Long,
    val source: String = "phone_mic" // or "Pandant_mic"
)

data class PhotoUpload(
    val jpeg_base64: String,
    val timestamp: Long,
    val source: String = "Pandant_camera"
)

data class SensorUpload(
    val sensor_type: String,
    val values: Map<String, Double>,
    val timestamp: Long
)

data class QueryRequest(
    val text: String,
    val context: String? = null,
    val intent_hint: String? = null
)

data class QueryResponse(
    val response_text: String,
    val audio_url: String? = null,
    val route: String? = null,
    val query: String? = null,
    val response_time_ms: Long? = null
)

data class SyncBatch(
    val uploads: List<PendingItem>
)

data class PendingItem(
    val type: String, // "audio", "photo", "sensor"
    val payload: String // JSON string
)

data class ServerStatus(
    val status: String,
    val timestamp: String
)

data class VisionRequest(
    val image_base64: String,
    val question: String
)

data class VisionResponse(
    val description: String
)

data class ConversationSearchResponse(
    val conversations: List<ConversationItem>,
    val total: Int
)

data class ConversationItem(
    val id: Long,
    val event_type: String,
    val created_at: String,
    val transcript: String,
    val response: String,
    val route: String
)

data class TerminalSendRequest(
    val text: String,
    val session_id: String? = null
)

data class TerminalSendResponse(
    val ok: Boolean,
    val session: String? = null
)

data class PermissionsResponse(
    val permissions: List<PermissionPrompt>
)

data class PermissionPrompt(
    val id: Long,
    val session_id: String,
    val project: String?,
    val prompt: String,
    val timestamp: String
)

data class PermissionRespondRequest(
    val response: String,
    val perm_id: Long
)
