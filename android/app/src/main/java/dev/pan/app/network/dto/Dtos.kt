package dev.pan.app.network.dto

// Tier 0: /api/v1/auth/me response
data class OrgInfo(
    val id: String,
    val slug: String,
    val name: String,
    val color_primary: String? = null,
    val color_secondary: String? = null,
    val logo_url: String? = null,
)

data class MeResponse(
    val id: Int,
    val email: String,
    val display_name: String,
    val display_nickname: String? = null,
    val role: String? = null,
    val org: OrgInfo? = null,
)

// Tier 0 Phase 4: /api/v1/org/policy response
data class OrgPolicyResponse(
    val org_id: String,
    val org_slug: String,
    val org_name: String,
    val incognito_allowed: Boolean = true,
    val blackout_allowed: Boolean = true,
    val data_retention_days: Int? = null,
)

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
    val intent_hint: String? = null,
    val sensors: String? = null  // JSON string of sensor envelope
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

data class TerminalWaitResponse(
    val ok: Boolean,
    val response: String?,
    val error: String?
)

// Sensor config DTOs
data class SensorDefinition(
    val id: String,
    val name: String,
    val category: String,
    val description: String?,
    val icon: String?,
    val sort_order: Int = 0
)

data class DeviceSensorConfig(
    val id: String,
    val name: String,
    val category: String,
    val description: String?,
    val icon: String?,
    val available: Int,
    val muted: Int,
    val enabled: Boolean = true,
    val policy: String? = null,        // null=user control, "force_on", "force_off"
    val policy_reason: String? = null,
    val locked: Boolean = false,       // true if org policy overrides user toggle
    val attachments: Map<String, Boolean> = emptyMap()
)

data class DeviceSensorsResponse(
    val device: DeviceSensorDevice,
    val sensors: List<DeviceSensorConfig>
)

data class DeviceSensorDevice(
    val id: Int,
    val name: String,
    val device_type: String
)

data class SensorUpdateRequest(
    val enabled: Boolean
)

data class SensorAttachRequest(
    val enabled: Boolean
)

// Telemetry log entry — matches server's /api/v1/logs schema
data class LogEntry(
    val device_id: String,
    val device_type: String = "phone",
    val level: String = "info",
    val source: String = "app",
    val message: String,
    val meta: Map<String, String>? = null
)

data class LogInsertResponse(
    val ok: Boolean,
    val inserted: Int
)

// Intuition snapshot DTOs — /api/v1/intuition/current
data class IntuitionNow(
    val where: String? = null,
    val activity: String? = null,
    val social: List<String>? = null,
    val focus: String? = null,
    val mood: String? = null,
    val mood_detail: String? = null,
    val urgency: String? = null,
    val direction: String? = null,
    val need: String? = null,
    val engagement: String? = null,
    val complexity: String? = null,
    val recent_topics: List<String>? = null,
    val last_heard: String? = null,
    val last_seen: String? = null
)

data class IntuitionPanService(
    val name: String,
    val status: String
)

data class IntuitionPan(
    val services: List<IntuitionPanService>? = null,
    val status: String? = null
)

data class IntuitionSnapshot(
    val commander: String? = null,
    val as_of: Long? = null,
    val now: IntuitionNow? = null,
    val pan: IntuitionPan? = null
)

data class IntuitionResponse(
    val ok: Boolean,
    val snapshot: IntuitionSnapshot? = null,
    val as_of: Long? = null
)
