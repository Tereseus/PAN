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
    val audio_url: String? = null
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
