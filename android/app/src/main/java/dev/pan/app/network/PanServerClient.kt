package dev.pan.app.network

import android.util.Log
import dev.pan.app.network.dto.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class PanServerClient @Inject constructor(
    private val api: PanServerApi
) {
    companion object {
        private const val TAG = "PanServer"
    }

    private val _isConnected = MutableStateFlow(false)
    val isConnected: StateFlow<Boolean> = _isConnected

    suspend fun checkHealth(): Boolean {
        return try {
            val response = api.health()
            _isConnected.value = response.isSuccessful
            response.isSuccessful
        } catch (e: Exception) {
            _isConnected.value = false
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

    suspend fun askPanWithContext(text: String, intentHint: String?, conversationHistory: String): QueryResponse? {
        return try {
            val response = api.query(QueryRequest(text, conversationHistory, intentHint))
            if (response.isSuccessful) response.body() else null
        } catch (e: Exception) {
            Log.e(TAG, "Query failed: ${e.message}")
            null
        }
    }
}
