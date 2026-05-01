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
