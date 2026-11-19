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

    // Whose device this is at the hub. A device paired for a person other than the owner
    // (docs/PEOPLE-PLAN.md) is refused the owner's things (approvals, alerts, Intuition, the
    // device list), so the app does not keep asking for them. Asked again every minute: the
    // owner can take a device back or hand it over at any time.
    @Volatile private var person: Boolean? = null
    @Volatile private var personAskedAt = 0L

    /** False only when the hub has said this device belongs to a person other than the owner. */
    suspend fun ownersDevice(): Boolean {
        val now = android.os.SystemClock.elapsedRealtime()
        if (personAskedAt == 0L || now - personAskedAt > (if (person == null) 5_000L else 60_000L)) {
            personAskedAt = now
            try {
                val r = api.getMe()
                if (r.isSuccessful) person = r.body()?.person == true
            } catch (_: Exception) {}
        }
        return person != true
    }

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
                .url("${Constants.PLACEHOLDER_BASE_URL}/api/v1/capture")
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
                .url("${Constants.PLACEHOLDER_BASE_URL}/api/v1/slack/reply")
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

    // The stream of a call's sound stays open for as long as the call: no read timeout.
    private val streamClient by lazy { okHttpClient.newBuilder().readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS).build() }

    /** A piece of this device's microphone sound for the call its person is on (CallAudio). -> the status, 0 when the hub cannot be reached */
    suspend fun voiceSend(sound: ByteArray): Int = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder().url("${Constants.PLACEHOLDER_BASE_URL}/api/v1/people/voice")
                .post(sound.toRequestBody("application/octet-stream".toMediaType())).build()
            okHttpClient.newCall(request).execute().use { it.code }
        } catch (e: Exception) { 0 }
    }

    /** The others' sound in the call, as one open stream. The caller reads it and closes it. Blocking: call it off the main thread. */
    fun voiceStream(): okhttp3.Response? = try {
        // The same path as the sound out, with listen=1 (one rule on the hub's list for a person's device).
        streamClient.newCall(Request.Builder().url("${Constants.PLACEHOLDER_BASE_URL}/api/v1/people/voice?listen=1")
            .post(ByteArray(0).toRequestBody("application/octet-stream".toMediaType())).build()).execute()
    } catch (e: Exception) { null }

    /**
     * A plain JSON call to the hub: the status and the body, or null when the hub cannot be reached.
     * For the few screens that only show what the hub decides (People, in Settings).
     */
    suspend fun hubJson(method: String, path: String, body: JSONObject? = null): Pair<Int, JSONObject>? = withContext(Dispatchers.IO) {
        try {
            val json = (body ?: JSONObject()).toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder().url("${Constants.PLACEHOLDER_BASE_URL}$path")
                .apply { if (method == "GET") get() else method(method, json) }.build()
            okHttpClient.newCall(request).execute().use { response ->
                val text = response.body?.string() ?: ""
                response.code to (runCatching { JSONObject(text) }.getOrNull() ?: JSONObject())
            }
        } catch (e: Exception) {
            Log.w(TAG, "$method $path failed: ${e.message}")
            null
        }
    }

    /**
     * How a line in another script is said: Latin letters for the whole line and, word by word, the
     * reading and a short meaning. The hub works it out (reading.js); null when it has no reader
     * for the language or cannot be reached.
     */
    suspend fun reading(text: String, lang: String): JSONObject? = withContext(Dispatchers.IO) {
        try {
            val body = JSONObject().apply { put("text", text); put("lang", lang) }
                .toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder().url("${Constants.PLACEHOLDER_BASE_URL}/api/v1/reading").post(body).build()
            okHttpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null
                JSONObject(response.body?.string() ?: "{}").takeIf { it.optBoolean("ok") }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Reading failed: ${e.message}")
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
        // A person's device is known to the hub by its PAN Link key: it has nothing to register,
        // and the hub refuses it.
        if (!ownersDevice()) return true
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
                .url("${Constants.PLACEHOLDER_BASE_URL}/api/v1/recall/stream")
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

    /** His turn is coming: the hub reads this history now, and the turn only reads his words. */
    /** G.711 mu-law: one byte for a 16-bit sample. */
    private fun ulaw(sample: Int): Byte {
        val sign = if (sample < 0) 0x80 else 0
        var x = minOf(kotlin.math.abs(sample), 32635) + 0x84
        var exp = 7
        var mask = 0x4000
        while ((x and mask) == 0 && exp > 0) { exp--; mask = mask shr 1 }
        val man = (x shr (exp + 3)) and 0x0f
        return ((sign or (exp shl 4) or man).inv() and 0xff).toByte()
    }

    fun warm(conversationHistory: String, bench: Boolean) {
        val body = JSONObject().apply {
            if (bench) put("bench", true)
            if (conversationHistory.isNotEmpty()) put("context", conversationHistory)
        }.toString().toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url("${Constants.PLACEHOLDER_BASE_URL}/api/v1/voice/warm")
            .post(body)
            .build()
        okHttpClient.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {}
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) { response.close() }
        })
    }

    suspend fun askPanStream(
        text: String,
        conversationHistory: String = "",
        sensorJson: String? = null,
        canCamera: Boolean = false,
        audio: ShortArray? = null,
        bench: Boolean = false,
        unfinished: Boolean = false,
        sincePanMs: Long? = null,
        addressed: Boolean = false,
        musicPlaying: Boolean = false,
        onCall: ((okhttp3.Call) -> Unit)? = null,
        onHeard: ((String) -> Unit)? = null,
        onInterpreting: (() -> Unit)? = null,
        onInterpreter: ((String?) -> Unit)? = null,
        onLineLang: ((String) -> Unit)? = null,
        onChunk: (String) -> Unit
    ): QueryResponse? = withContext(Dispatchers.IO) {
        try {
            val body = JSONObject().apply {
                put("text", text)
                // Conversation benchmark turn: the hub answers it the same way and
                // persists nothing (service/src/bench-context.js).
                if (bench) put("bench", true)
                // He stopped mid-sentence (SttEngine.turnUnfinished): maybe searching for a word.
                if (unfinished) put("unfinished", true)
                // The assistant button was pressed: this line is for ΠAN (router.js addressed_now).
                if (addressed) put("addressed_now", true)
                // Music is playing on this device: the hub answers only lines that name PAN.
                if (musicPlaying) put("media_playing", true)
                // How long ago PAN last stopped talking: inside 45 s this line is part of a talk.
                if (sincePanMs != null) put("since_pan_ms", sincePanMs)
                if (conversationHistory.isNotEmpty()) put("context", conversationHistory)
                if (sensorJson != null) put("sensors", sensorJson)
                if (canCamera) put("can_camera", true)
                // The turn's audio: the hub transcribes it again with a bigger model and
                // answers what that heard (hub-asr.js). 16kHz PCM16 little-endian.
                // Sent as G.711 mu-law, half the bytes (Nov 14: on his 4G hotspot the upload was most
                // of the wait). The hub turns it back into PCM16; its speech model heard 28 of 30 test
                // lines the same both ways (the two that differed were Spanish and Japanese, garbled both ways).
                if (audio != null && audio.isNotEmpty()) {
                    val u = ByteArray(audio.size) { i -> ulaw(audio[i].toInt()) }
                    put("audio_ulaw", android.util.Base64.encodeToString(u, android.util.Base64.NO_WRAP))
                }
            }.toString().toRequestBody("application/json".toMediaType())

            // Build against default URL — the OkHttp interceptor will rewrite to Tailscale if active
            val request = Request.Builder()
                .url("${Constants.PLACEHOLDER_BASE_URL}/api/v1/query/stream")
                .post(body)
                .addHeader("Accept", "text/event-stream")
                .build()

            val call = okHttpClient.newCall(request)
            onCall?.invoke(call)
            val response = call.execute()
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
                        "heard" -> {
                            val heard = json.optString("text", "")
                            if (heard.isNotEmpty()) onHeard?.invoke(heard)
                        }
                        // Sent before any chunk while he has PAN interpreting.
                        "interpreting" -> onInterpreting?.invoke()
                        // Before the chunks of an interpreted reply: the language it is in (hub of 2026-11-18 on).
                        "line_lang" -> json.optString("lang", "").takeIf { it.isNotBlank() }?.let { onLineLang?.invoke(it) }
                        // After the reply: whether he has PAN interpreting now, and into what.
                        "interpreter" -> onInterpreter?.invoke(json.optString("lang", "").ifBlank { null })
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
                                    actions = emptyList(),
                                    addressed = if (result.has("addressed") && !result.isNull("addressed")) result.optDouble("addressed") else null,
                                    hold_ms = result.optLong("hold_ms", 0L),
                                    camera = result.optBoolean("camera", false),
                                    mute = result.optBoolean("mute", false),
                                    reason = result.optString("reason", "").ifBlank {
                                        if (result.optBoolean("to_claude", false)) "dictating" else null
                                    },
                                    timing = result.optJSONObject("timing")?.toString()
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
