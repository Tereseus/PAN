package dev.pan.app.network

import android.os.Build
import android.util.Log
import dev.pan.app.network.dto.LogEntry
import kotlinx.coroutines.*
import java.util.concurrent.ConcurrentLinkedQueue
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Batches log entries and ships them to PAN server's /api/v1/logs endpoint.
 * Thread-safe, non-blocking. Flushes every 5s or when buffer hits 50 entries.
 */
@Singleton
class LogShipper @Inject constructor(
    private val api: PanServerApi
) {
    companion object {
        private const val TAG = "LogShipper"
        private const val FLUSH_INTERVAL_MS = 5000L
        private const val MAX_BUFFER = 50
        private const val MAX_MSG_LEN = 2000
    }

    private val buffer = ConcurrentLinkedQueue<LogEntry>()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val deviceId = "phone-${Build.MODEL.lowercase().replace(" ", "-")}"
    private var flushJob: Job? = null

    fun start() {
        if (flushJob?.isActive == true) return
        flushJob = scope.launch {
            while (isActive) {
                delay(FLUSH_INTERVAL_MS)
                flush()
            }
        }
    }

    fun stop() {
        // Best-effort final flush
        scope.launch { flush() }
        flushJob?.cancel()
        flushJob = null
    }

    fun log(level: String, source: String, message: String, meta: Map<String, String>? = null) {
        buffer.add(LogEntry(
            device_id = deviceId,
            device_type = "phone",
            level = level,
            source = source,
            message = message.take(MAX_MSG_LEN),
            meta = meta
        ))
        if (buffer.size >= MAX_BUFFER) {
            scope.launch { flush() }
        }
    }

    // Convenience methods
    fun info(source: String, message: String, meta: Map<String, String>? = null) = log("info", source, message, meta)
    fun warn(source: String, message: String, meta: Map<String, String>? = null) = log("warn", source, message, meta)
    fun error(source: String, message: String, meta: Map<String, String>? = null) = log("error", source, message, meta)

    private suspend fun flush() {
        if (buffer.isEmpty()) return
        val batch = mutableListOf<LogEntry>()
        while (batch.size < 100) {
            val entry = buffer.poll() ?: break
            batch.add(entry)
        }
        if (batch.isEmpty()) return
        try {
            val response = api.shipLogs(batch)
            if (!response.isSuccessful) {
                Log.w(TAG, "Ship failed (${response.code()}), re-queuing ${batch.size} entries")
                // Re-queue on failure (drop if buffer is huge to prevent OOM)
                if (buffer.size < 500) {
                    buffer.addAll(batch)
                }
            }
        } catch (e: Exception) {
            // Network down — re-queue if not too backed up
            if (buffer.size < 500) {
                buffer.addAll(batch)
            }
        }
    }
}
