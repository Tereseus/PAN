package dev.pan.app.ui.people

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.pan.app.network.PanServerClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import org.json.JSONObject
import javax.inject.Inject

/**
 * A message from someone on this ΠAN just reached this device (the service saw it among the
 * notes it asks for). The People tab reads this so its list and its mark are fresh at once,
 * with no asking of its own while the tab is closed.
 */
object PeopleSignal {
    val arrived = MutableStateFlow(0)
    fun bump() { arrived.value = arrived.value + 1 }
}

/** One person on this ΠAN as the list shows them. */
data class PersonLine(
    val id: Int, val name: String, val role: String,
    val last: String?, val lastFromMe: Boolean, val lastAt: Long,
    val unread: Int, val devices: List<String>,
)

/** One message in a conversation. said: their device has it (read out unless muted). opened: they have seen it here. */
data class TalkLine(val id: Long, val fromMe: Boolean, val body: String, val at: Long, val said: Boolean, val opened: Boolean)

/**
 * People tab: the others on this ΠAN, the conversation with each, and (the owner only) adding
 * and removing them. The hub decides everything (person-messages.js, people.js): who is listed,
 * which conversation this device may open, whether it may send. This holds what the screen shows.
 */
@HiltViewModel
class PeopleViewModel @Inject constructor(
    private val serverClient: PanServerClient,
) : ViewModel() {

    /** null until the hub has answered once. */
    private val _people = MutableStateFlow<List<PersonLine>?>(null)
    val people: StateFlow<List<PersonLine>?> = _people
    private val _failed = MutableStateFlow(false)
    val failed: StateFlow<Boolean> = _failed
    private val _owner = MutableStateFlow(false)
    val owner: StateFlow<Boolean> = _owner
    private val _canSend = MutableStateFlow(true)
    val canSend: StateFlow<Boolean> = _canSend
    private val _unread = MutableStateFlow(0)
    val unread: StateFlow<Int> = _unread
    /** On a child's device: the owner's name, who can read these conversations. null: nobody else can. */
    private val _readBy = MutableStateFlow<String?>(null)
    val readBy: StateFlow<String?> = _readBy

    /** The owner reading a child's conversations: whose, and who that child has talked with. */
    private val _watching = MutableStateFlow<PersonLine?>(null)
    val watching: StateFlow<PersonLine?> = _watching
    private val _watchPeople = MutableStateFlow<List<PersonLine>?>(null)
    val watchPeople: StateFlow<List<PersonLine>?> = _watchPeople

    private val _open = MutableStateFlow<PersonLine?>(null)
    val open: StateFlow<PersonLine?> = _open
    private val _talk = MutableStateFlow<List<TalkLine>>(emptyList())
    val talk: StateFlow<List<TalkLine>> = _talk
    private val _more = MutableStateFlow(false)
    val more: StateFlow<Boolean> = _more
    private val _sending = MutableStateFlow(false)
    val sending: StateFlow<Boolean> = _sending
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    private var devices: Map<Int, List<String>> = emptyMap()

    init {
        viewModelScope.launch {
            // At launch the link to the hub is often not up yet: ask until it answers once, so
            // the tab's mark is right without the tab being opened.
            repeat(20) {
                load(withDevices = false)
                if (_people.value != null) return@launch
                kotlinx.coroutines.delay(3000)
            }
        }
        viewModelScope.launch {
            PeopleSignal.arrived.drop(1).collect { tick() }
        }
    }

    fun clearMessage() { _message.value = null }

    /** Whatever is on screen, fresh: the open conversation, the child's list, or the list. */
    suspend fun tick() {
        when {
            _open.value != null -> loadTalk()
            _watching.value != null -> loadWatch()
            else -> load(withDevices = false)
        }
    }

    private fun rows(j: JSONObject, withDevices: Boolean): List<PersonLine> {
        val out = ArrayList<PersonLine>()
        val list = j.optJSONArray("people") ?: return out
        for (i in 0 until list.length()) {
            val p = list.optJSONObject(i) ?: continue
            val last = p.optJSONObject("last")
            out.add(PersonLine(
                id = p.optInt("id"), name = p.optString("name"), role = p.optString("role"),
                last = last?.optString("body"), lastFromMe = last?.optBoolean("from_me") == true, lastAt = last?.optLong("at") ?: 0L,
                unread = p.optInt("unread"), devices = if (withDevices) devices[p.optInt("id")] ?: emptyList() else emptyList(),
            ))
        }
        return out
    }

    /** The owner opens a child's conversations to read. The hub refuses it for anyone who is not a child. */
    fun watch(child: PersonLine) {
        _watching.value = child
        _watchPeople.value = null
        viewModelScope.launch { loadWatch() }
    }

    fun stopWatching() {
        _watching.value = null
        _watchPeople.value = null
    }

    suspend fun loadWatch() {
        val child = _watching.value ?: return
        val r = hub("GET", "/api/v1/people?of=${child.id}")
        if (_watching.value?.id != child.id) return
        if (r == null || r.first != 200) {
            if (r?.first == 403) { _message.value = "ΠAN does not let you read ${child.name}'s messages."; stopWatching() }
            return
        }
        // Only the people this child has a message with.
        _watchPeople.value = rows(r.second, withDevices = false).filter { it.last != null }
    }
    suspend fun hub(method: String, path: String, body: JSONObject? = null) = serverClient.hubJson(method, path, body)

    /** The list. withDevices: also whose device is whose, which only the owner's device may ask. */
    suspend fun load(withDevices: Boolean) {
        val r = hub("GET", "/api/v1/people")
        if (r == null || r.first != 200) { _failed.value = _people.value == null; return }
        _failed.value = false
        val isOwner = r.second.optJSONObject("me")?.optBoolean("owner") == true
        _owner.value = isOwner
        _canSend.value = r.second.optBoolean("can_send", true)
        _readBy.value = r.second.optJSONObject("me")?.optString("read_by")?.takeIf { it.isNotBlank() && it != "null" }
        if (isOwner && (withDevices || devices.isEmpty())) {
            val list = hub("GET", "/api/v1/link/people")?.takeIf { it.first == 200 }?.second?.optJSONArray("devices")
            if (list != null) {
                val byUser = HashMap<Int, MutableList<String>>()
                for (i in 0 until list.length()) {
                    val d = list.optJSONObject(i) ?: continue
                    byUser.getOrPut(d.optInt("user_id")) { mutableListOf() }.add(d.optString("link_device_id"))
                }
                devices = byUser
            }
        }
        val rows = rows(r.second, withDevices = true)
        _people.value = rows
        _unread.value = r.second.optInt("unread")
        if (_watching.value == null) _open.value?.let { was -> rows.firstOrNull { it.id == was.id }?.let { _open.value = it } }
    }

    fun refresh(withDevices: Boolean = false) { viewModelScope.launch { load(withDevices) } }

    fun openTalk(person: PersonLine) {
        _open.value = person
        _talk.value = emptyList()
        _more.value = false
        viewModelScope.launch { loadTalk() }
    }

    fun closeTalk() {
        _open.value = null
        _talk.value = emptyList()
        viewModelScope.launch { tick() }
    }

    private fun lines(j: JSONObject): List<TalkLine> {
        val out = ArrayList<TalkLine>()
        val list = j.optJSONArray("messages") ?: return out
        for (i in 0 until list.length()) {
            val m = list.optJSONObject(i) ?: continue
            out.add(TalkLine(m.optLong("id"), m.optBoolean("from_me"), m.optString("body"), m.optLong("at"), m.optBoolean("said"), m.optBoolean("opened")))
        }
        return out
    }

    /** The newest page, kept together with any earlier pages already on screen. Opening it marks it seen on the hub. */
    suspend fun loadTalk() {
        val who = _open.value ?: return
        // Reading a child's: the hub is told whose it is, and marks nothing as seen.
        val of = _watching.value?.id
        val r = hub("GET", "/api/v1/people/messages?with=${who.id}" + (if (of != null) "&of=$of" else ""))
        if (r == null || r.first != 200) return
        if (_open.value?.id != who.id) return
        val newest = lines(r.second)
        val first = newest.firstOrNull()?.id
        val earlier = if (first == null) emptyList() else _talk.value.filter { it.id < first }
        if (earlier.isEmpty()) _more.value = r.second.optBoolean("more")
        _talk.value = earlier + newest
        if (of != null) return
        _people.value = _people.value?.map { if (it.id == who.id) it.copy(unread = 0) else it }
        _unread.value = _people.value?.sumOf { it.unread } ?: 0
    }

    fun earlier() {
        val who = _open.value ?: return
        val before = _talk.value.firstOrNull()?.id ?: return
        viewModelScope.launch {
            val of = _watching.value?.id
            val r = hub("GET", "/api/v1/people/messages?with=${who.id}&before=$before" + (if (of != null) "&of=$of" else ""))
            if (r == null || r.first != 200 || _open.value?.id != who.id) return@launch
            _talk.value = lines(r.second) + _talk.value
            _more.value = r.second.optBoolean("more")
        }
    }

    /** A typed message. Their device says it as this person's words, the same as one said to ΠAN. */
    fun send(text: String, done: (Boolean) -> Unit) {
        val who = _open.value ?: return
        val body = text.trim()
        if (body.isEmpty() || _sending.value || _watching.value != null) return
        _sending.value = true
        viewModelScope.launch {
            val r = hub("POST", "/api/v1/people/messages", JSONObject().put("to", who.id).put("body", body))
            _sending.value = false
            when (r?.first) {
                200 -> { done(true); loadTalk() }
                429 -> { _message.value = "That's a lot of messages at once. Give it a minute."; done(false) }
                403 -> { _message.value = "Whoever set up this ΠAN has not opened messages for you."; done(false) }
                404 -> { _message.value = "${who.name} is no longer on this ΠAN."; done(false) }
                else -> { _message.value = "ΠAN could not send that right now."; done(false) }
            }
        }
    }
}
