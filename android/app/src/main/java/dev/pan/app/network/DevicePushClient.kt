package dev.pan.app.network

import android.util.Log
import kotlinx.coroutines.*
import okhttp3.*
import org.json.JSONObject
import dev.pan.app.vpn.RemoteAccessManager
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Persistent WebSocket client for server-initiated action delivery.
 *
 * Connects to ws://SERVER/api/v1/device/push?device_id=X&device_type=phone
 * and dispatches incoming action envelopes to [onActions].
 *
 * Auto-reconnects on failure with a 5-second backoff. Sends a heartbeat
 * ping every 30 seconds to keep the connection alive through NAT/firewalls.
 */
@Singleton
class DevicePushClient @Inject constructor(
    private val okHttpClient: OkHttpClient,
    private val remoteAccessManager: RemoteAccessManager
) {
    private val TAG = "DevicePushClient"
    private var webSocket: WebSocket? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** Callback invoked on the IO dispatcher with a list of raw action maps. */
    var onActions: ((List<Map<String, Any?>>) -> Unit)? = null

    fun connect(deviceId: String) {
        scope.launch {
            while (isActive) {
                try {
                    val base = remoteAccessManager.getTailscaleBaseUrl()
                        ?: "http://192.168.1.248:7777"
                    val wsUrl = base
                        .replace("https://", "wss://")
                        .replace("http://", "ws://") +
                        "/api/v1/device/push?device_id=${deviceId}&device_type=phone"

                    val request = Request.Builder()
                        .url(wsUrl)
                        .addHeader("X-Device-Id", deviceId)
                        .build()

                    val connected = CompletableDeferred<Boolean>()
                    webSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {
                        override fun onOpen(ws: WebSocket, response: Response) {
                            Log.i(TAG, "Push channel connected: $wsUrl")
                            connected.complete(true)
                        }

                        override fun onMessage(ws: WebSocket, text: String) {
                            handleMessage(text)
                        }

                        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                            Log.w(TAG, "Push channel error: ${t.message}")
                            if (!connected.isCompleted) connected.complete(false)
                        }

                        override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                            Log.i(TAG, "Push channel closed: $reason")
                        }
                    })

                    if (!connected.await()) {
                        // Connection failed immediately — skip heartbeat, go to reconnect delay
                        webSocket = null
                        delay(5_000)
                        continue
                    }

                    // Heartbeat loop — keeps the socket alive and detects silent drops
                    while (isActive && webSocket != null) {
                        delay(30_000)
                        val sent = webSocket?.send("""{"type":"ping"}""") ?: false
                        if (!sent) {
                            Log.w(TAG, "Heartbeat send failed — reconnecting")
                            break
                        }
                    }

                } catch (e: Exception) {
                    Log.w(TAG, "Push channel exception: ${e.message}")
                }

                webSocket = null
                delay(5_000) // reconnect backoff
            }
        }
    }

    private fun handleMessage(text: String) {
        try {
            val json = JSONObject(text)
            when (json.optString("type")) {
                "actions" -> {
                    val actionsArr = json.optJSONArray("actions") ?: return
                    val actions = mutableListOf<Map<String, Any?>>()
                    for (i in 0 until actionsArr.length()) {
                        val a = actionsArr.getJSONObject(i)
                        val argsObj = a.optJSONObject("args")
                        val argsMap: Map<String, String>? = argsObj?.let { obj ->
                            buildMap {
                                obj.keys().forEach { key -> put(key, obj.optString(key)) }
                            }
                        }
                        actions.add(
                            mapOf(
                                "target" to a.optString("target"),
                                "device_id" to a.optString("device_id").takeIf { it.isNotEmpty() },
                                "device_type" to a.optString("device_type").takeIf { it.isNotEmpty() },
                                "type" to a.optString("type"),
                                "args" to argsMap
                            )
                        )
                    }
                    onActions?.invoke(actions)
                }
                "pong" -> { /* heartbeat acknowledged */ }
                else -> Log.d(TAG, "Unknown push message type: ${json.optString("type")}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Push message parse error: ${e.message} | raw: $text")
        }
    }

    fun disconnect() {
        webSocket?.close(1000, "disconnect")
        webSocket = null
        scope.cancel()
    }
}
