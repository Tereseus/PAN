package dev.pan.app.network

import android.util.Log
import dev.pan.app.network.dto.*
import dev.pan.app.network.dto.TerminalSendRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class PanServerClient @Inject constructor(
    internal val api: PanServerApi
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
}
