package dev.pan.app.network

import android.util.Log
import dev.pan.app.data.DataRepository
import dev.pan.app.util.Constants
import kotlinx.coroutines.*
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SyncManager @Inject constructor(
    private val dataRepository: DataRepository,
    private val serverClient: PanServerClient
) {
    companion object {
        private const val TAG = "SyncManager"
    }

    private var syncJob: Job? = null

    fun start() {
        syncJob = CoroutineScope(Dispatchers.IO).launch {
            Log.i(TAG, "Sync manager started")
            while (isActive) {
                try {
                    sync()
                } catch (e: Exception) {
                    Log.e(TAG, "Sync error: ${e.message}")
                }
                delay(Constants.SYNC_INTERVAL_MS)
            }
        }
    }

    fun stop() {
        syncJob?.cancel()
        syncJob = null
    }

    private suspend fun sync() {
        // Check server connectivity first
        if (!serverClient.checkHealth()) return

        // Drain pending uploads
        val pending = dataRepository.getPendingUploads()
        if (pending.isEmpty()) return

        Log.d(TAG, "Syncing ${pending.size} pending items")

        for (item in pending) {
            val success = when (item.type) {
                "audio" -> {
                    val upload = dataRepository.deserializeAudioUpload(item.payload)
                    upload?.let { serverClient.sendAudio(it) } ?: false
                }
                "photo" -> {
                    val upload = dataRepository.deserializePhotoUpload(item.payload)
                    upload?.let { serverClient.sendPhoto(it) } ?: false
                }
                "sensor" -> {
                    val upload = dataRepository.deserializeSensorUpload(item.payload)
                    upload?.let { serverClient.sendSensor(it) } ?: false
                }
                else -> false
            }

            if (success) {
                dataRepository.markSynced(item.id)
            }
        }
    }
}
