package dev.pan.app.ui.hub

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.pan.app.network.PanServerClient
import dev.pan.app.tts.PiperTtsEngine
import dev.pan.app.tts.TtsManager
import dev.pan.app.tts.VoicePace
import dev.pan.app.tts.VoiceTiming
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import javax.inject.Inject

/** One thing running on the hub, as `GET /dashboard/api/services` gives it. status: up, down, unknown. */
data class HubService(val category: String, val name: String, val status: String, val role: String, val detail: String)

/** One line of what ΠAN reads about the owner right now: what it is, the reading, and why (may be empty). */
data class ReadLine(val label: String, val value: String, val why: String = "")

/** `GET /api/v1/intuition/current`, as lines to show. at: when the hub last read it (ms). */
data class IntuitionView(val at: Long, val trigger: String, val confidence: Int?, val now: List<ReadLine>, val from: List<ReadLine>, val next: List<String>, val note: String)

/** A model the hub uses for every device: its settings key, what it is now, what it can be. */
data class ModelPick(val key: String, val value: String, val choices: List<String>)

/** How long this person's turns took on one device, from the hub's own record. ms. */
data class DeviceTimes(val device: String, val turns: Int, val avgMs: Long, val medianMs: Long, val slowestMs: Long)

/** `GET /api/v1/voice/picks`. */
data class HubPicks(val hubModel: ModelPick?, val readerModel: ModelPick?, val hubAsr: String, val devices: List<DeviceTimes>)

/** A model loaded on a machine now: its size and how much of it is on the graphics card. */
data class LoadedModel(val name: String, val gb: Double, val onCardPct: Int)

/** A job ΠAN runs on a machine now (answer model, voice reader); note says where it goes otherwise. */
data class MachineRun(val what: String, val model: String, val note: String)

/**
 * A machine ΠAN can run models on (`GET /api/v1/compute`, the owner 2026-11-22): its chips as one
 * line, its measured speed, what runs there, and his switch. Speed is tokens a second, 0 = not tested.
 */
data class Machine(val id: String, val name: String, val hub: Boolean, val online: Boolean, val chips: String,
    val ollama: Boolean, val loaded: List<LoadedModel>, val tokS: Double, val speedModel: String, val speedAt: String,
    val allowed: Boolean, val sharesCard: Boolean, val runs: List<MachineRun>)

/** This device's own side: its voice, the pace it talks at, how fast it builds lines, its ear. */
data class DeviceVoice(val voice: String, val pace: VoicePace.Pick?, val liveSpeed: Float, val timing: VoiceTiming.Stats, val ear: String)

/**
 * The hub, seen from the phone (the owner, 2026-11-18): what is running on it, and what ΠAN
 * reads about him right now. The app's own screens in place of the hub's web page. Read only.
 */
@HiltViewModel
class HubViewModel @Inject constructor(
    private val serverClient: PanServerClient,
    @ApplicationContext private val context: Context,
    private val tts: TtsManager,
) : ViewModel() {

    /** null until the hub has answered once. */
    private val _picks = MutableStateFlow<HubPicks?>(null)
    val picks: StateFlow<HubPicks?> = _picks
    /** The hub answered but has no picks list (an older hub): 404. */
    private val _noPicks = MutableStateFlow(false)
    val noPicks: StateFlow<Boolean> = _noPicks
    /** null until the hub has answered; empty on an older hub with no machine list. */
    private val _machines = MutableStateFlow<List<Machine>?>(null)
    val machines: StateFlow<List<Machine>?> = _machines
    /** The machine whose speed test is running ("" none). */
    private val _timing = MutableStateFlow("")
    val timing: StateFlow<String> = _timing
    private val _device = MutableStateFlow(deviceVoice())
    val device: StateFlow<DeviceVoice> = _device

    /** null until the hub has answered once. */
    private val _services = MutableStateFlow<List<HubService>?>(null)
    val services: StateFlow<List<HubService>?> = _services
    private val _intuition = MutableStateFlow<IntuitionView?>(null)
    val intuition: StateFlow<IntuitionView?> = _intuition
    /** "" fine; else why nothing shows: the hub cannot be reached, or this device is not the owner's. */
    private val _trouble = MutableStateFlow("")
    val trouble: StateFlow<String> = _trouble
    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading

    fun refresh() { viewModelScope.launch { load() } }

    suspend fun load() {
        _loading.value = true
        val s = serverClient.hubJson("GET", "/dashboard/api/services")
        val i = serverClient.hubJson("GET", "/api/v1/intuition/current")
        _loading.value = false
        _trouble.value = when {
            s == null && i == null -> "ΠAN could not be reached."
            s?.first == 403 || i?.first == 403 -> "Only the owner's devices can see this."
            else -> ""
        }
        if (s != null && s.first == 200) _services.value = services(s.second.optJSONArray("services"))
        if (i != null && i.first == 200) i.second.optJSONObject("snapshot")?.let { _intuition.value = intuition(it) }
        loadPicks()
    }

    private suspend fun loadPicks() {
        _device.value = deviceVoice()
        val p = serverClient.hubJson("GET", "/api/v1/voice/picks") ?: return
        _noPicks.value = p.first == 404
        if (p.first == 200) _picks.value = picks(p.second)
        loadMachines()
    }

    private suspend fun loadMachines() {
        val m = serverClient.hubJson("GET", "/api/v1/compute") ?: return
        _machines.value = if (m.first == 200) machines(m.second.optJSONArray("machines")) else emptyList()
    }

    /** Change a model the hub uses, for every device, then read the list again. */
    fun setHubModel(key: String, value: String) {
        viewModelScope.launch {
            val r = serverClient.hubJson("PUT", "/api/v1/settings", JSONObject().put(key, value))
            _trouble.value = when {
                r == null -> "ΠAN could not be reached."
                r.first == 403 -> "Only the owner's devices can change this."
                r.first !in 200..299 -> "The hub did not take it (${r.first})."
                else -> ""
            }
            loadPicks()
        }
    }

    /** His switch for one machine: ΠAN may use it. Off sends its models to the hub. */
    fun setAllowed(id: String, allowed: Boolean) {
        viewModelScope.launch {
            val r = serverClient.hubJson("PUT", "/api/v1/compute/allow", JSONObject().put("id", id).put("allowed", allowed))
            _trouble.value = said(r)
            loadMachines()
        }
    }

    /** Time one machine: a short reply from a model ΠAN uses there. Takes a few seconds, longer on a processor. */
    fun testSpeed(id: String) {
        if (_timing.value.isNotEmpty()) return
        viewModelScope.launch {
            _timing.value = id
            val r = serverClient.hubJson("POST", "/api/v1/compute/speed", JSONObject().put("id", id))
            _timing.value = ""
            _trouble.value = if (r != null && r.first in 400..499 && r.first != 403) r.second.optString("error") else said(r)
            loadMachines()
        }
    }

    private fun said(r: Pair<Int, JSONObject>?): String = when {
        r == null -> "ΠAN could not be reached."
        r.first == 403 -> "Only the owner's devices can change this."
        r.first !in 200..299 -> "The hub did not take it (${r.first})."
        else -> ""
    }

    /** Voice pace on this device: null speed = Auto. Saved; the next line uses it. */
    fun setPace(speed: Float?) {
        VoicePace.save(context, speed)
        _device.value = deviceVoice()
    }

    private fun deviceVoice(): DeviceVoice {
        val q = tts.voiceQuality
        val voice = PiperTtsEngine.VOICES[q]?.takeIf { tts.piper.isFullyReady(q) }
        // The ear the service starts (PanForegroundService.sttEngine): the same saved choice.
        val ear = if ((context.getSharedPreferences("pan_stt_prefs", Context.MODE_PRIVATE).getString("engine", "sherpa") ?: "sherpa") == "sherpa")
            "Zipformer (sherpa-onnx), on this device" else "Android speech recognition"
        return DeviceVoice(
            voice = voice?.let { if (it.id == "supertonic3") "Supertonic 3" else it.name } ?: "The Android voice",
            pace = voice?.let { VoicePace.current(context, it) },
            liveSpeed = tts.piper.speedOverride,
            timing = VoiceTiming.stats(context),
            ear = ear,
        )
    }

    private fun picks(o: JSONObject): HubPicks {
        val choices = o.optJSONObject("choices")
        fun list(key: String): List<String> = choices?.optJSONArray(key)?.let { a -> (0 until a.length()).map { a.optString(it) }.filter { it.isNotBlank() } } ?: emptyList()
        fun pick(name: String): ModelPick? = o.optJSONObject(name)?.let {
            val key = it.optString("key")
            if (key.isBlank()) null else ModelPick(key, said(it, "value"), list(key))
        }
        val devices = o.optJSONArray("devices")?.let { a ->
            (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map {
                DeviceTimes(it.optString("device"), it.optInt("turns"), it.optLong("avg_total_ms"), it.optLong("median_total_ms"), it.optLong("slowest_ms"))
            }
        } ?: emptyList()
        return HubPicks(pick("hub_model"), pick("reader_model"), said(o, "hub_asr"), devices)
    }

    private fun machines(a: JSONArray?): List<Machine> = a?.let { (0 until it.length()).mapNotNull { i -> it.optJSONObject(i) } }.orEmpty().map { m ->
        val speed = m.optJSONObject("speed")
        fun objs(key: String) = m.optJSONArray(key)?.let { l -> (0 until l.length()).mapNotNull { l.optJSONObject(it) } }.orEmpty()
        Machine(
            id = m.optString("id"), name = m.optString("name"), hub = m.optBoolean("hub"), online = m.optBoolean("online"),
            chips = m.optString("chips"), ollama = m.optBoolean("ollama"),
            loaded = objs("loaded").map { LoadedModel(it.optString("name"), it.optDouble("gb", 0.0), it.optInt("on_card_pct")) },
            tokS = speed?.optDouble("tok_s", 0.0) ?: 0.0, speedModel = speed?.optString("model").orEmpty(), speedAt = speed?.optString("at").orEmpty(),
            allowed = m.optBoolean("allowed", true), sharesCard = m.optBoolean("shares_card"),
            runs = objs("runs").map { MachineRun(it.optString("what"), it.optString("model"), it.optString("note")) },
        )
    }

    private fun services(list: JSONArray?): List<HubService> {
        if (list == null) return emptyList()
        return (0 until list.length()).mapNotNull { list.optJSONObject(it) }
            // The devices have their own place in the app.
            .filter { it.optString("category") != "Devices" }
            .map { HubService(it.optString("category"), it.optString("name"), it.optString("status"), it.optString("role"), it.optString("detail")) }
    }

    // The hub writes "None" (or leaves it out) for what it has no reading of.
    private fun said(o: JSONObject?, key: String): String {
        val v = o?.opt(key) ?: return ""
        if (v == JSONObject.NULL) return ""
        if (v is JSONArray) return (0 until v.length()).map { v.optString(it) }.filter { it.isNotBlank() }.joinToString(", ")
        val s = v.toString().trim()
        return if (s.isEmpty() || s.equals("none", true) || s.equals("null", true) || s.equals("none active", true) || s.equals("none detected", true)) "" else s
    }

    private fun intuition(snap: JSONObject): IntuitionView {
        val now = snap.optJSONObject("now")
        val read = snap.optJSONObject("read")
        val signals = snap.optJSONObject("signals")
        val pan = snap.optJSONObject("pan")
        fun line(label: String, value: String, why: String = "") = if (value.isBlank()) null else ReadLine(label, value, why)
        val lines = listOfNotNull(
            line("Where", said(now, "where")),
            line("Doing", said(now, "activity")),
            line("With", said(now, "social")),
            line("Focus", said(now, "focus")),
            line("Needs", said(now, "need")),
            line("Mood", said(now, "mood"), said(now, "mood_detail")),
            line("Wellbeing", said(now, "assumption"), said(now, "assumption_detail")),
            line("Pace", said(now, "urgency"), said(read, "urgency_detail")),
            line("Engagement", said(now, "engagement")),
            line("Complexity", said(now, "complexity")),
            line("Awake", said(now, "awake")),
            line("Recent topics", said(now, "recent_topics")),
            line("Last heard", said(now, "last_heard")),
            line("ΠAN is", said(pan, "status")),
        )
        val from = listOfNotNull(
            line("Source", said(signals, "device_source")),
            line("Events read", said(signals, "events_sampled")),
            line("Chat lines read", said(signals, "wrap_messages_sampled")),
            line("Terminal lines read", said(signals, "terminal_messages_sampled")),
            line("Apps", said(signals, "active_apps")),
            line("Sensors", said(signals, "sensors_active")),
            line("Screen", said(signals, "screen_context")),
            line("Camera", said(signals, "webcam_context")),
        )
        val next = pan?.optJSONArray("predictions")?.let { a ->
            (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map {
                val c = it.optDouble("confidence", Double.NaN)
                it.optString("what") + if (c.isNaN()) "" else " (${(c * 100).toInt()}%)"
            }.filter { it.isNotBlank() }
        } ?: emptyList()
        val conf = signals?.optDouble("confidence", Double.NaN)?.takeIf { !it.isNaN() }?.let { (it * 100).toInt() }
        return IntuitionView(snap.optLong("as_of"), said(snap, "trigger"), conf, lines, from, next, said(snap.optJSONObject("meta"), "disclaimer"))
    }
}
