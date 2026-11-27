package dev.pan.app.ui.memory

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.pan.app.data.DataRepository
import dev.pan.app.network.PanServerApi
import dev.pan.app.network.dto.ForgetRequest
import dev.pan.app.network.dto.MemoryItem
import dev.pan.app.util.Constants
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.time.LocalDate
import java.time.ZoneId
import javax.inject.Inject

/**
 * Memory tab: what PAN kept, one day or one search at a time, and forgetting it.
 * The hub does the work (/dashboard/api/mem); this holds what the screen shows.
 */
@HiltViewModel
class MemoryViewModel @Inject constructor(
    private val api: PanServerApi,
    private val okHttpClient: OkHttpClient,
    private val dataRepository: DataRepository,
    private val serverClient: dev.pan.app.network.PanServerClient,
) : ViewModel() {

    /** Memory > Reports and Memory > Data Dividend read the hub with this (MemoryParts.kt). */
    suspend fun hub(method: String, path: String, body: org.json.JSONObject? = null) = serverClient.hubJson(method, path, body)

    private val _day = MutableStateFlow(LocalDate.now())
    val day: StateFlow<LocalDate> = _day
    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query
    private val _items = MutableStateFlow<List<MemoryItem>>(emptyList())
    val items: StateFlow<List<MemoryItem>> = _items
    /** How many the hub found (a search can find more than it shows). */
    private val _total = MutableStateFlow(0)
    val total: StateFlow<Int> = _total
    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    private var job: Job? = null
    private val thumbs = HashMap<String, Bitmap?>()

    fun clearMessage() { _message.value = null }

    fun setDay(d: LocalDate) { _day.value = d; _query.value = ""; load() }
    fun setQuery(q: String) { _query.value = q }
    fun search() { load() }
    fun clearSearch() { _query.value = ""; load() }

    /** Shows the search if there is one, else the day. */
    fun load() {
        job?.cancel()
        job = viewModelScope.launch {
            _loading.value = true
            val q = _query.value.trim()
            try {
                val res = if (q.isNotEmpty()) api.getMemory(q = q)
                          else api.getMemory(date = _day.value.toString(), tz = tzMinutes(_day.value))
                val body = res.body()
                if (res.isSuccessful && body != null) {
                    _items.value = body.items
                    _total.value = body.total
                } else {
                    _items.value = emptyList(); _total.value = 0
                    _message.value = "Could not read your memory (${res.code()})"
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                _items.value = emptyList(); _total.value = 0
                _message.value = "Your computer is not answering"
            }
            _loading.value = false
        }
    }

    /** Hides what the screen shows. Called when the tab is left, so nothing stays readable behind the lock. */
    fun hide() {
        job?.cancel()
        _items.value = emptyList(); _total.value = 0; _query.value = ""
        thumbs.clear()
    }

    fun forgetOne(item: MemoryItem) = forget(ForgetRequest(ids = listOf(item.id))) {
        item.heard?.takeIf { it.length >= 4 }?.let { dataRepository.forgetTalkContaining(it) }
        item.said?.takeIf { it.length >= 8 }?.let { dataRepository.forgetTalkContaining(it) }
    }

    /** This phone's minutes east of UTC on that day: the hub's clock may be in another time zone. */
    private fun tzMinutes(d: LocalDate): Int =
        d.atStartOfDay(ZoneId.systemDefault()).offset.totalSeconds / 60

    /** Everything the search found, on the hub, not just the lines on screen. */
    fun forgetSearch() {
        val q = _query.value.trim()
        if (q.isEmpty()) return
        forget(ForgetRequest(q = q)) { dataRepository.forgetTalkContaining(q) }
    }

    fun forgetDay() {
        val d = _day.value
        forget(ForgetRequest(date = d.toString(), tz = tzMinutes(d))) {
            val from = d.atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
            dataRepository.forgetTalkBetween(from, from + 86_400_000L)
        }
    }

    private fun forget(request: ForgetRequest, alsoOnPhone: suspend () -> Unit) {
        viewModelScope.launch {
            try {
                val res = api.forgetMemory(request)
                val body = res.body()
                if (res.isSuccessful && body?.ok == true) {
                    runCatching { alsoOnPhone() }
                    _message.value = when (body.forgotten) {
                        0 -> "Nothing to delete"
                        1 -> "Deleted 1 thing"
                        else -> "Deleted ${body.forgotten} things"
                    }
                    if (request.q != null) _query.value = ""
                    load()
                } else {
                    _message.value = "Could not delete (${res.code()})"
                }
            } catch (e: Exception) {
                _message.value = "Your computer is not answering. Nothing was deleted."
            }
        }
    }

    /** A small copy of a picture on the hub, through the same route as everything else. */
    suspend fun thumb(path: String): Bitmap? {
        if (thumbs.containsKey(path)) return thumbs[path]
        val bmp = withContext(Dispatchers.IO) {
            runCatching {
                val req = Request.Builder().url("${Constants.PLACEHOLDER_BASE_URL}$path").build()
                okHttpClient.newCall(req).execute().use { r ->
                    if (!r.isSuccessful) return@use null
                    val bytes = r.body?.bytes() ?: return@use null
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = 2 })
                }
            }.getOrNull()
        }
        thumbs[path] = bmp
        return bmp
    }
}
