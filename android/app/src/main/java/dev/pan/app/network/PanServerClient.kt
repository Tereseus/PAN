package dev.pan.app.network

import android.util.Log
import dev.pan.app.network.dto.*
import dev.pan.app.network.dto.TerminalSendRequest
import dev.pan.app.util.Constants
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class PanServerClient @Inject constructor(
    internal val api: PanServerApi,
    private val okHttpClient: OkHttpClient
) {
    companion object {
        private const val TAG = "PanServer"
    }

    private val _isConnected = MutableStateFlow(false)
    val isConnected: StateFlow<Boolean> = _isConnected

    // Prevent connection flapping — only flip to disconnected after 3 consecutive failures
    private var consecutiveFailures = 0

    suspend fun checkHealth(): Boolean {
        return try {
            val response = api.health()
            if (response.isSuccessful) {
                consecutiveFailures = 0
                _isConnected.value = true
            } else {
                consecutiveFailures++
                if (consecutiveFailures >= 3) {
                    _isConnected.value = false
                }
            }
            response.isSuccessful
        } catch (e: Exception) {
            consecutiveFailures++
            if (consecutiveFailures >= 3) {
                _isConnected.value = false
            }
            false
        }
    }

    suspend fun sendAudio(upload: AudioUpload): Boolean {
        return try {
            api.uploadAudio(upload).isSuccessful
        } catch (e: Exception) {
            Log.e(TAG, "Failed to send audio: ${e.message}")
            false
        }
    }

    suspend fun sendPhoto(upload: PhotoUpload): Boolean {
        return try {
            api.uploadPhoto(upload).isSuccessful
        } catch (e: Exception) {
            Log.e(TAG, "Failed to send photo: ${e.message}")
            false
        }
    }

    suspend fun sendSensor(upload: SensorUpload): Boolean {
        return try {
            api.uploadSensor(upload).isSuccessful
        } catch (e: Exception) {
            Log.e(TAG, "Failed to send sensor data: ${e.message}")
            false
        }
    }

    suspend fun askPan(text: String, intentHint: String? = null): QueryResponse? {
        return try {
            val response = api.query(QueryRequest(text, null, intentHint))
            if (response.isSuccessful) response.body() else null
        } catch (e: Exception) {
            Log.e(TAG, "Query failed: ${e.message}")
            null
        }
    }

    suspend fun analyzeImage(imageBase64: String, question: String): String? {
        return try {
            val response = api.vision(VisionRequest(imageBase64, question))
            if (response.isSuccessful) {
                response.body()?.description
            } else {
                Log.e(TAG, "Vision API failed: ${response.code()}")
                null
            }
        } catch (e: Exception) {
            Log.e(TAG, "Vision request failed: ${e.message}")
            null
        }
    }

    /**
     * Capture pipe — upload the actual photo bytes (not just the spoken
     * description) so the IMAGE reaches the desktop: POSTs base64 JSON to
     * /api/v1/capture, which writes public/captures/cap_<ts>.jpg and posts an
     * image message to the Π thread. Best-effort: catch + log, never throw —
     * a failed upload must not delay or break the voice reply.
     */
    suspend fun uploadCapture(imageBytes: ByteArray, caption: String?, question: String?, onDevice: Boolean = false) = withContext(Dispatchers.IO) {
        try {
            val deviceId = android.os.Build.MODEL.lowercase().replace(" ", "-")
            val base64 = android.util.Base64.encodeToString(imageBytes, android.util.Base64.NO_WRAP)
            val body = JSONObject().apply {
                put("image_base64", base64)
                if (!caption.isNullOrBlank()) put("caption", caption)
                if (!question.isNullOrBlank()) put("question", question)
                put("device_id", deviceId)
                // Tells the server this was analyzed on-device (Nano), so it writes
                // the VisionAnalysis memory event that /vision would have written.
                put("on_device", onDevice)
            }.toString().toRequestBody("application/json".toMediaType())

            // Same base-URL machinery as the streaming calls — the OkHttp
            // interceptor rewrites to Tailscale when active.
            val request = Request.Builder()
                .url("${Constants.DEFAULT_SERVER_URL}/api/v1/capture")
                .post(body)
                .build()

            okHttpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w("Capture", "Upload failed: ${response.code}")
                }
            }
        } catch (e: Exception) {
            Log.w("Capture", "Upload failed: ${e.message}")
        }
    }

    /**
     * Slack bridge reply — POST {channelId, text} to /api/v1/slack/reply.
     * The hub relays it to the scoped work-pc client which posts it to Slack
     * as the user. Raw-OkHttp style (same as uploadCapture) so the OkHttp
     * interceptor rewrites the base URL to Tailscale when active. Returns true
     * only when the hub reports the reply was accepted (HTTP 2xx + {ok:true}).
     */
    suspend fun sendSlackReply(channelId: String, text: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val body = JSONObject().apply {
                put("channelId", channelId)
                put("text", text)
            }.toString().toRequestBody("application/json".toMediaType())

            val request = Request.Builder()
                .url("${Constants.DEFAULT_SERVER_URL}/api/v1/slack/reply")
                .post(body)
                .build()

            okHttpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "Slack reply failed: HTTP ${response.code}")
                    return@withContext false
                }
                val ok = try {
                    JSONObject(response.body?.string() ?: "{}").optBoolean("ok", true)
                } catch (_: Exception) { true }
                ok
            }
        } catch (e: Exception) {
            Log.e(TAG, "Slack reply failed: ${e.message}")
            false
        }
    }

    suspend fun recall(text: String): String? {
        return try {
            val response = api.recall(QueryRequest(text))
            if (response.isSuccessful) response.body()?.response_text else null
        } catch (e: Exception) {
            Log.e(TAG, "Recall failed: ${e.message}")
            null
        }
    }

    suspend fun searchConversations(query: String, limit: Int = 5): List<dev.pan.app.network.dto.ConversationItem> {
        return try {
            val response = api.searchConversations(query, limit)
            if (response.isSuccessful) response.body()?.conversations ?: emptyList()
            else emptyList()
        } catch (e: Exception) {
            Log.e(TAG, "Conversation search failed: ${e.message}")
            emptyList()
        }
    }

    suspend fun sendTerminalCommand(text: String, sessionId: String? = null): Boolean {
        return try {
            val response = api.sendTerminalCommand(TerminalSendRequest(text, sessionId))
            response.isSuccessful && (response.body()?.ok == true)
        } catch (e: Exception) {
            Log.e(TAG, "Terminal send failed: ${e.message}")
            false
        }
    }

    suspend fun registerDevice(deviceId: String, deviceName: String): Boolean {
        return try {
            val resp = api.registerDevice(
                dev.pan.app.network.dto.DeviceRegisterRequest(
                    device_id = deviceId,
                    device_name = deviceName,
                    device_type = "phone",
                    user_id = android.os.Build.MODEL  // placeholder — replaced by org login later
                )
            )
            resp.isSuccessful
        } catch (e: Exception) {
            Log.e(TAG, "Device registration failed: ${e.message}")
            false
        }
    }

    suspend fun askPanWithContext(
        text: String, intentHint: String?, conversationHistory: String,
        sensors: Map<String, Any?>? = null
    ): QueryResponse? {
        return try {
            val sensorJson = if (sensors != null && sensors.isNotEmpty()) {
                org.json.JSONObject(sensors).toString()
            } else null
            val response = api.query(QueryRequest(text, conversationHistory, intentHint, sensorJson))
            if (response.isSuccessful) response.body() else null
        } catch (e: Exception) {
            Log.e(TAG, "Query failed: ${e.message}")
            null
        }
    }

    /**
     * Streaming query — calls /api/v1/query/stream via SSE.
     * Invokes [onChunk] for each text chunk as it arrives, so TTS can start
     * speaking the first sentence while the rest is still generating.
     * Returns the final QueryResponse (intent, actions, etc.) when stream ends.
     */
    /** Streaming recall — FTS5 DB search + Cerebras, SSE so phone speaks immediately. */
    suspend fun recallStream(
        text: String,
        onChunk: (String) -> Unit
    ): String? = withContext(Dispatchers.IO) {
        try {
            val body = JSONObject().apply { put("text", text) }
                .toString().toRequestBody("application/json".toMediaType())

            val request = Request.Builder()
                .url("${Constants.DEFAULT_SERVER_URL}/api/v1/recall/stream")
                .post(body)
                .addHeader("Accept", "text/event-stream")
                .build()

            val response = okHttpClient.newCall(request).execute()
            if (!response.isSuccessful) {
                Log.e(TAG, "Recall stream failed: ${response.code}")
                return@withContext null
            }

            val source = response.body?.source() ?: return@withContext null
            val fullText = StringBuilder()

            while (!source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                if (!line.startsWith("data: ")) continue
                val data = line.removePrefix("data: ").trim()
                if (data.isEmpty()) continue
                try {
                    val json = JSONObject(data)
                    when (json.optString("type")) {
                        "chunk" -> {
                            val chunk = json.optString("text", "")
                            if (chunk.isNotEmpty()) { fullText.append(chunk); onChunk(chunk) }
                        }
                        "done" -> break
                    }
                } catch (e: Exception) { Log.w(TAG, "Recall SSE parse: ${e.message}") }
            }

            response.body?.close()
            fullText.toString().ifEmpty { null }
        } catch (e: Exception) {
            Log.e(TAG, "Recall stream failed: ${e.message}")
            null
        }
    }

    suspend fun askPanStream(
        text: String,
        conversationHistory: String = "",
        sensorJson: String? = null,
        onChunk: (String) -> Unit
    ): QueryResponse? = withContext(Dispatchers.IO) {
        try {
            val body = JSONObject().apply {
                put("text", text)
                if (conversationHistory.isNotEmpty()) put("context", conversationHistory)
                if (sensorJson != null) put("sensors", sensorJson)
            }.toString().toRequestBody("application/json".toMediaType())

            // Build against default URL — the OkHttp interceptor will rewrite to Tailscale if active
            val request = Request.Builder()
                .url("${Constants.DEFAULT_SERVER_URL}/api/v1/query/stream")
                .post(body)
                .addHeader("Accept", "text/event-stream")
                .build()

            val response = okHttpClient.newCall(request).execute()
            if (!response.isSuccessful) {
                Log.e(TAG, "Stream request failed: ${response.code}")
                return@withContext null
            }

            val source = response.body?.source() ?: return@withContext null
            var finalResult: QueryResponse? = null

            while (!source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                if (!line.startsWith("data: ")) continue
                val data = line.removePrefix("data: ").trim()
                if (data.isEmpty()) continue

                try {
                    val json = JSONObject(data)
                    when (json.optString("type")) {
                        "chunk" -> {
                            val chunk = json.optString("text", "")
                            if (chunk.isNotEmpty()) onChunk(chunk)
                        }
                        "ambient" -> {
                            // #462: server flagged this as ambient — silently drop, no TTS.
                            // Final 'done' will follow with empty response; we tag intent=ambient
                            // here so caller can short-circuit even if 'done' is missed.
                            finalResult = QueryResponse(
                                response_text = "",
                                intent = "ambient",
                                route = "ambient",
                                query = null,
                                actions = emptyList()
                            )
                        }
                        "done" -> {
                            val result = json.optJSONObject("result")
                            if (result != null) {
                                finalResult = QueryResponse(
                                    response_text = result.optString("response", ""),
                                    intent = result.optString("intent", "query"),
                                    route = result.optString("intent", null),
                                    query = result.optString("query", null),
                                    actions = emptyList()
                                )
                            }
                            break
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "SSE parse error: ${e.message}")
                }
            }

            response.body?.close()
            finalResult
        } catch (e: Exception) {
            Log.e(TAG, "Stream failed: ${e.message}")
            null
        }
    }
}
