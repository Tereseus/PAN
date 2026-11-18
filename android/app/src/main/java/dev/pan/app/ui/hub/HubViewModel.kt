package dev.pan.app.ui.hub

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.pan.app.network.PanServerClient
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

/**
 * The hub, seen from the phone (the owner, 2026-11-18): what is running on it, and what ΠAN
 * reads about him right now. The app's own screens in place of the hub's web page. Read only.
 */
@HiltViewModel
class HubViewModel @Inject constructor(
    private val serverClient: PanServerClient,
) : ViewModel() {

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
