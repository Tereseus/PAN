package dev.pan.app.ui.people

import android.app.Activity
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import dev.pan.app.ui.settings.qrBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * People tab: everyone else on this ΠAN, and the conversation with each (docs/PEOPLE-PLAN.md).
 *
 * A message is said to ΠAN ("ΠAN, tell Maria dinner is ready") or typed here. Either way the
 * other person's device says it and it stays in the conversation between the two. The owner also
 * adds and removes people here and gets the code for a person's device. The hub decides all of
 * it; this is only the screen. On a person's device it shows the people they can message.
 */
private val ROLES = listOf("user" to "Adult", "child" to "Child", "guest" to "Guest")
private fun roleLabel(role: String) = when (role) {
    "owner" -> "Owner"
    else -> ROLES.firstOrNull { it.first == role }?.second ?: role.replaceFirstChar { it.uppercase() }
}
private fun roleCan(role: String) = when (role) {
    "child" -> "Talks to ΠAN, uses the camera and sends messages to people here, and nothing else unless you open it."
    else -> "Talks to ΠAN, uses the camera and sends messages to people here."
}
private fun firstName(name: String) = name.trim().substringBefore(' ').ifBlank { name }

@Composable
private fun whenText(at: Long): String {
    if (at <= 0L) return ""
    val context = LocalContext.current
    val date = java.util.Date(at)
    return if (android.text.format.DateUtils.isToday(at)) android.text.format.DateFormat.getTimeFormat(context).format(date)
    else android.text.format.DateFormat.getMediumDateFormat(context).format(date)
}

@Composable
fun PeopleScreen(viewModel: PeopleViewModel) {
    val open by viewModel.open.collectAsState()
    val watching by viewModel.watching.collectAsState()
    val message by viewModel.message.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(message) { message?.let { snackbar.showSnackbar(it); viewModel.clearMessage() } }

    // Fresh while the tab is on screen and the app is in front; nothing is asked otherwise.
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(open?.id, watching?.id) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            if (viewModel.open.value == null && viewModel.watching.value == null) viewModel.load(withDevices = true)
            while (true) {
                delay(5000)
                viewModel.tick()
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        val person = open
        val child = watching
        when {
            person != null -> Conversation(viewModel, person, readingFor = child)
            child != null -> ChildMessages(viewModel, child)
            else -> PeopleList(viewModel, snackbar)
        }
        SnackbarHost(snackbar, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 72.dp))
    }
}

@Composable
private fun PeopleList(viewModel: PeopleViewModel, snackbar: SnackbarHostState) {
    val people by viewModel.people.collectAsState()
    val failed by viewModel.failed.collectAsState()
    val owner by viewModel.owner.collectAsState()
    val canSend by viewModel.canSend.collectAsState()
    val readBy by viewModel.readBy.collectAsState()
    val group by viewModel.group.collectAsState()
    val groups by viewModel.groups.collectAsState()
    val canMeet by viewModel.canMeet.collectAsState()
    val met by viewModel.met.collectAsState()
    val talkWith by viewModel.talkWith.collectAsState()
    val talkJoined by viewModel.talkJoined.collectAsState()
    val callingMe by viewModel.callingMe.collectAsState()
    val myMode by viewModel.myMode.collectAsState()
    val myModeLocked by viewModel.myModeLocked.collectAsState()
    val scope = rememberCoroutineScope()
    // The two parts of People (the owner, 2026-11-18): the organization on this hub, and Others,
    // the people with a ΠAN of their own.
    var part by rememberSaveable { mutableStateOf("group") }
    var naming by remember { mutableStateOf(false) }
    var newGroupFor by remember { mutableStateOf<Int?>(null) }           // -1: a group alone; else the person to put in it
    var moving by remember { mutableStateOf<PersonLine?>(null) }
    var renamingGroup by remember { mutableStateOf<GroupLine?>(null) }
    var alsoCalled by remember { mutableStateOf<PersonLine?>(null) }
    LaunchedEffect(Unit) { viewModel.loadMet() }

    var adding by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf<Pair<String, String>?>(null) }     // whose, the pairing link
    var removing by remember { mutableStateOf<PersonLine?>(null) }
    var renaming by remember { mutableStateOf<PersonLine?>(null) }
    var busy by remember { mutableStateOf(false) }

    suspend fun codeFor(id: Int, name: String) {
        busy = true
        val r = viewModel.hub("POST", "/api/v1/link/pair",
            JSONObject().put("name", "$name's device").put("for_user", id).put("ttl_minutes", 10))
        busy = false
        val uri = r?.takeIf { it.first == 200 }?.second?.optString("uri").orEmpty()
        if (uri.startsWith("pan://pair")) code = name to uri
        else snackbar.showSnackbar(r?.second?.optString("error")?.takeIf { it.isNotBlank() } ?: "ΠAN could not make a code right now.")
    }

    Column(modifier = Modifier.fillMaxSize().statusBarsPadding()) {
        Text("People", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 8.dp))
        val rows = people
        if (rows == null) {
            if (failed) Text("ΠAN could not be reached. The people on it show here when it can.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp))
            return@Column
        }
        // The two parts. The first carries the name the owner gave the people on this hub (a
        // family, a workplace). Others is there once this person may add people or has any.
        val showOthers = canMeet || met.isNotEmpty()
        if (showOthers) {
            Row(modifier = Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = part == "group", onClick = { part = "group" }, label = { Text(group.ifBlank { "Family" }) })
                FilterChip(selected = part == "met", onClick = { part = "met" }, label = { Text("Others") })
            }
            if (part == "met") { MetPart(viewModel); return@Column }
        }
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            // A call: who is calling, or who this person is on with.
            rows.firstOrNull { it.id == callingMe }?.let { caller ->
                item(key = "calling") {
                    CallBar("${firstName(caller.name)} wants to talk.", "Answer") { viewModel.startTalk(caller.id, firstName(caller.name)) }
                }
            }
            rows.firstOrNull { it.id == talkWith }?.let { other ->
                item(key = "oncall") {
                    CallBar(if (talkJoined) "On with ${firstName(other.name)}. Just talk." else "Calling ${firstName(other.name)}. What you say is passed on.", "End") { viewModel.endTalk() }
                }
            }
            if (!canSend) item {
                Text("Whoever set up this ΠAN has not opened messages for you.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            }
            // Said plainly on a child's own device: nothing is read behind their back.
            readBy?.let { who ->
                item {
                    Text("$who can read your messages here.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
                }
            }
            if (rows.isEmpty() && canSend) item {
                Text(if (owner) "Nobody else is on your ΠAN yet. Add family or others: each person's device talks to ΠAN as them and cannot reach your memory, your computers or your settings."
                    else "Nobody else is on this ΠAN yet.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            }
            // In no group first, then each group under its name. A group with nobody in it shows
            // to the owner only, who is the one who can fill it.
            val known = groups.map { it.id }.toSet()
            val sections = listOf<Pair<GroupLine?, List<PersonLine>>>(null to rows.filter { it.group !in known }) +
                groups.map { g -> g to rows.filter { it.group == g.id } }
            sections.forEach { (g, inIt) ->
                if (g != null && (inIt.isNotEmpty() || owner)) item(key = "group-${g.id}") {
                    GroupHeader(g, owner = owner, empty = inIt.isEmpty(), onRename = { renamingGroup = g }, onDelete = { viewModel.removeGroup(g.id) })
                }
                items(inIt, key = { it.id }) { person ->
                    PersonRow(person, owner = owner, busy = busy,
                        onOpen = { viewModel.openTalk(person) },
                        onRead = { viewModel.watch(person) },
                        onMode = { mode, locked -> viewModel.setMode(mode, person.id, locked) },
                        onAddDevice = { scope.launch { codeFor(person.id, person.name) } },
                        onRename = { renaming = person },
                        onGroup = { moving = person },
                        onNames = { alsoCalled = person },
                        onRemove = { removing = person })
                    HorizontalDivider(modifier = Modifier.padding(start = 20.dp))
                }
            }
            if (owner) item {
                Column(modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedButton(onClick = { adding = true }, enabled = !busy) { Text("Add a person") }
                        OutlinedButton(onClick = { newGroupFor = -1 }, enabled = !busy) { Text("New group") }
                    }
                    TextButton(onClick = { naming = true }) { Text(if (group.isBlank()) "Name your organization" else "Rename $group") }
                }
            }
            if (rows.isNotEmpty() && canSend) item {
                Text("Say \"ΠAN, tell ${firstName(rows.first().name)} ...\" for one message, or \"ΠAN, talk to ${firstName(rows.first().name)}\" and then just talk. \"ΠAN, hang up\" ends it.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            }
            // Read out, or shown only: this person's choice unless the owner locked it.
            item {
                Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Read messages out loud", style = MaterialTheme.typography.bodyLarge)
                        Text(when {
                            myModeLocked -> "Set by whoever runs this ΠAN."
                            myMode == "show" -> "Off: what people send you is only shown."
                            else -> "On: ΠAN says what people send you. Off shows it only."
                        }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Switch(checked = myMode == "speak", enabled = !myModeLocked, onCheckedChange = { viewModel.setMode(if (it) "speak" else "show") })
                }
            }
        }
    }

    if (naming) {
        var name by remember { mutableStateOf(group) }
        AlertDialog(
            onDismissRequest = { naming = false },
            title = { Text("Your organization") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("What the people on your ΠAN are: Family, or the name of the place you work. Everyone on it sees this name. Groups go inside it.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedTextField(value = name, onValueChange = { name = it.take(30) }, label = { Text("Name") },
                        singleLine = true, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = { naming = false; viewModel.nameGroup(name) }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { naming = false }) { Text("Cancel") } },
        )
    }

    newGroupFor?.let { forPerson ->
        var name by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { newGroupFor = null },
            title = { Text("New group") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("A group or a team inside ${group.ifBlank { "your organization" }}. Call it anything. You can move people in and out, rename it or delete it later.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedTextField(value = name, onValueChange = { name = it.take(30) }, label = { Text("Name") },
                        singleLine = true, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        GROUP_IDEAS.filter { idea -> groups.none { it.name.equals(idea, ignoreCase = true) } }.take(3).forEach { idea ->
                            FilterChip(selected = name == idea, onClick = { name = idea }, label = { Text(idea) })
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(enabled = name.isNotBlank(), onClick = {
                    newGroupFor = null
                    viewModel.addGroup(name, thenMove = forPerson.takeIf { it > 0 })
                }) { Text("Make it") }
            },
            dismissButton = { TextButton(onClick = { newGroupFor = null }) { Text("Cancel") } },
        )
    }

    moving?.let { person ->
        AlertDialog(
            onDismissRequest = { moving = null },
            title = { Text("${firstName(person.name)}'s group") },
            text = {
                Column {
                    (listOf(GroupLine(0, "No group")) + groups).forEach { g ->
                        TextButton(onClick = { moving = null; if (g.id != person.group) viewModel.moveTo(person.id, g.id) }, modifier = Modifier.fillMaxWidth()) {
                            Text(g.name, modifier = Modifier.weight(1f),
                                fontWeight = if (g.id == person.group || (g.id == 0 && groups.none { it.id == person.group })) FontWeight.SemiBold else FontWeight.Normal)
                        }
                    }
                    TextButton(onClick = { moving = null; newGroupFor = person.id }, modifier = Modifier.fillMaxWidth()) {
                        Text("New group...", modifier = Modifier.weight(1f))
                    }
                }
            },
            confirmButton = { TextButton(onClick = { moving = null }) { Text("Close") } },
        )
    }

    renamingGroup?.let { g ->
        var name by remember(g.id) { mutableStateOf(g.name) }
        AlertDialog(
            onDismissRequest = { renamingGroup = null },
            title = { Text("Rename ${g.name}") },
            text = {
                OutlinedTextField(value = name, onValueChange = { name = it.take(30) }, label = { Text("Name") },
                    singleLine = true, modifier = Modifier.fillMaxWidth())
            },
            confirmButton = {
                TextButton(enabled = name.isNotBlank() && name.trim() != g.name, onClick = { renamingGroup = null; viewModel.renameGroup(g.id, name) }) { Text("Rename") }
            },
            dismissButton = { TextButton(onClick = { renamingGroup = null }) { Text("Cancel") } },
        )
    }

    alsoCalled?.let { person ->
        var names by remember(person.id) { mutableStateOf(person.aka.joinToString(", ")) }
        AlertDialog(
            onDismissRequest = { alsoCalled = null },
            title = { Text("Other names for ${firstName(person.name)}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("For a name ΠAN mishears, or a name nobody says in full. \"ΠAN, tell ...\" and \"ΠAN, talk to ...\" work with these too. Up to four, with commas between.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedTextField(value = names, onValueChange = { names = it.take(110) }, label = { Text("Names") },
                        singleLine = true, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    alsoCalled = null
                    viewModel.setNames(person.id, names.split(',').map { it.trim() }.filter { it.isNotEmpty() }.take(4))
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { alsoCalled = null }) { Text("Cancel") } },
        )
    }

    if (adding) {
        var name by remember { mutableStateOf("") }
        var role by remember { mutableStateOf("user") }
        AlertDialog(
            onDismissRequest = { adding = false },
            title = { Text("Add a person") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = name, onValueChange = { name = it.take(40) }, label = { Text("Name") },
                        singleLine = true, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ROLES.forEach { (key, label) ->
                            FilterChip(selected = role == key, onClick = { role = key }, label = { Text(label) })
                        }
                    }
                    Text(roleCan(role) + " Never your memory, your computers or your settings.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            confirmButton = {
                TextButton(enabled = name.isNotBlank() && !busy, onClick = {
                    scope.launch {
                        busy = true
                        val r = viewModel.hub("POST", "/api/v1/auth/users", JSONObject().put("display_name", name.trim()).put("role", role))
                        busy = false
                        adding = false
                        val user = r?.takeIf { it.first == 200 }?.second?.optJSONObject("user")
                        if (user == null) snackbar.showSnackbar(r?.second?.optString("error")?.takeIf { it.isNotBlank() } ?: "ΠAN could not add them right now.")
                        else { viewModel.load(withDevices = true); codeFor(user.optInt("id"), user.optString("display_name")) }
                    }
                }) { Text("Add") }
            },
            dismissButton = { TextButton(onClick = { adding = false }) { Text("Cancel") } },
        )
    }

    code?.let { (whose, uri) ->
        val qr = remember(uri) { qrBitmap(uri, 640) }
        AlertDialog(
            onDismissRequest = { code = null; viewModel.refresh(withDevices = true) },
            title = { Text("$whose's device") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Install ΠAN on their device and scan this code with it. The code works once, for 10 minutes.")
                    if (qr != null) Image(bitmap = qr.asImageBitmap(), contentDescription = "Pairing code for $whose", modifier = Modifier.size(240.dp))
                    Text("Show it only to them: whoever scans it gets $whose's place on your ΠAN.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            confirmButton = { TextButton(onClick = { code = null; viewModel.refresh(withDevices = true) }) { Text("Done") } },
        )
    }

    renaming?.let { person ->
        var name by remember(person.id) { mutableStateOf(person.name) }
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("Rename ${person.name}") },
            text = {
                OutlinedTextField(value = name, onValueChange = { name = it.take(40) }, label = { Text("Name") },
                    singleLine = true, modifier = Modifier.fillMaxWidth())
            },
            confirmButton = {
                TextButton(enabled = name.isNotBlank() && name.trim() != person.name && !busy, onClick = {
                    renaming = null
                    scope.launch {
                        busy = true
                        val r = viewModel.hub("PUT", "/api/v1/auth/users/${person.id}/name", JSONObject().put("display_name", name.trim()))
                        busy = false
                        if (r == null || r.first != 200) snackbar.showSnackbar(r?.second?.optString("error")?.takeIf { it.isNotBlank() } ?: "ΠAN could not rename them right now.")
                        viewModel.load(withDevices = false)
                    }
                }) { Text("Rename") }
            },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("Cancel") } },
        )
    }

    removing?.let { person ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove ${person.name}?") },
            text = {
                Text(if (person.devices.isEmpty()) "${person.name} will no longer be on your ΠAN."
                else "${person.name}'s ${if (person.devices.size == 1) "device" else "devices"} will stop reaching your ΠAN, and ${person.name} will no longer be on it.")
            },
            confirmButton = {
                TextButton(onClick = {
                    removing = null
                    scope.launch {
                        busy = true
                        // The devices first: a device left paired after its person is gone is nobody's.
                        var left = 0
                        person.devices.forEach { id ->
                            val r = viewModel.hub("DELETE", "/api/v1/link/devices/$id")
                            if (r == null || r.first !in listOf(200, 404)) left++
                        }
                        val r = if (left == 0) viewModel.hub("DELETE", "/api/v1/auth/users/${person.id}") else null
                        busy = false
                        if (r == null || r.first != 200) snackbar.showSnackbar(
                            if (left > 0) "ΠAN could not remove ${person.name}'s device, so ${person.name} is still there. Try again."
                            else "ΠAN could not remove ${person.name} right now.")
                        viewModel.load(withDevices = true)
                    }
                }) { Text("Remove") }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun PersonRow(
    person: PersonLine, owner: Boolean, busy: Boolean,
    onOpen: () -> Unit, onRead: () -> Unit, onMode: (String, Boolean) -> Unit, onAddDevice: () -> Unit, onRename: () -> Unit,
    onGroup: () -> Unit, onNames: () -> Unit, onRemove: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(start = 20.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(person.name, style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (person.unread > 0) FontWeight.SemiBold else FontWeight.Normal)
            if (person.last != null) {
                Text((if (person.lastFromMe) "You: " else "") + person.last, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (person.unread > 0) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            // What the owner set for them. A person sees only who the owner is.
            val about = when {
                owner -> "${roleLabel(person.role)} · " + when (person.devices.size) {
                    0 -> "no device yet"
                    1 -> "1 device"
                    else -> "${person.devices.size} devices"
                } + (if (person.locked) " · messages ${if (person.mode == "show") "shown only" else "read out"}, set by you" else "")
                person.role == "owner" -> "Owner"
                else -> null
            }
            if (about != null) Text(about, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (person.aka.isNotEmpty()) Text("Also: " + person.aka.joinToString(", "), maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(horizontalAlignment = Alignment.End, modifier = Modifier.padding(start = 8.dp, end = if (owner) 0.dp else 16.dp)) {
            val at = whenText(person.lastAt)
            if (at.isNotEmpty()) Text(at, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (person.unread > 0) Badge(modifier = Modifier.padding(top = 4.dp)) { Text("${person.unread}") }
        }
        if (owner) Box {
            IconButton(onClick = { menu = true }, enabled = !busy) {
                Icon(Icons.Default.MoreVert, contentDescription = "More for ${person.name}")
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                // A child's conversations with others are the owner's to read (the hub holds this to children).
                if (person.role == "child") DropdownMenuItem(text = { Text("${firstName(person.name)}'s messages") }, onClick = { menu = false; onRead() })
                // How what is sent to them reaches them: his to set and lock, or theirs to choose.
                DropdownMenuItem(text = { Text("Messages: read out") }, onClick = { menu = false; onMode("speak", true) })
                DropdownMenuItem(text = { Text("Messages: show only") }, onClick = { menu = false; onMode("show", true) })
                if (person.locked) DropdownMenuItem(text = { Text("Let ${firstName(person.name)} choose") }, onClick = { menu = false; onMode(person.mode, false) })
                DropdownMenuItem(text = { Text("Group") }, onClick = { menu = false; onGroup() })
                DropdownMenuItem(text = { Text("Other names") }, onClick = { menu = false; onNames() })
                DropdownMenuItem(text = { Text("Add device") }, onClick = { menu = false; onAddDevice() })
                DropdownMenuItem(text = { Text("Rename") }, onClick = { menu = false; onRename() })
                DropdownMenuItem(text = { Text("Remove") }, onClick = { menu = false; onRemove() })
            }
        }
    }
}

// Names offered when the owner makes a group. Only a start: any name works.
private val GROUP_IDEAS = listOf("Kids", "Team", "Guests", "Family")

/** A group's name above its people. The owner can rename or delete it from here. */
@Composable
private fun GroupHeader(group: GroupLine, owner: Boolean, empty: Boolean, onRename: () -> Unit, onDelete: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 4.dp, top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = Modifier.weight(1f).padding(vertical = 6.dp)) {
            Text(group.name, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
            if (empty) Text("Nobody in it yet. Open a person's menu and choose Group.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (owner) Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "More for the group ${group.name}") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text("Rename") }, onClick = { menu = false; onRename() })
                DropdownMenuItem(text = { Text("Delete group") }, onClick = { menu = false; onDelete() })
            }
        }
    }
}

/**
 * Others: people with a ΠAN of their own whose code this person scanned. Each of the two scans the
 * other's code; each ΠAN keeps its own record on its own hub and can forget it (MeetCard has the
 * why). Nothing here talks to the other person's ΠAN.
 */
@Composable
private fun MetPart(viewModel: PeopleViewModel) {
    val met by viewModel.met.collectAsState()
    val canMeet by viewModel.canMeet.collectAsState()
    val myName by viewModel.myName.collectAsState()
    val context = LocalContext.current
    var showing by remember { mutableStateOf(false) }
    var scanned by remember { mutableStateOf<MeetCard.Card?>(null) }
    var forgetting by remember { mutableStateOf<MetLine?>(null) }
    val scan = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val text = result.data?.getStringExtra("code")
        if (result.resultCode == Activity.RESULT_OK && text != null) {
            val card = MeetCard.read(text)
            if (card == null) viewModel.say("That code is too old, or it is not a ΠAN code. Ask them to show it again.") else scanned = card
        }
    }
    LaunchedEffect(Unit) { viewModel.loadMet() }

    LazyColumn(modifier = Modifier.fillMaxSize()) {
        item {
            Text("People with their own ΠAN that you have met. You scan their code and they scan yours. Your ΠAN keeps its own record, and you can forget anyone.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        }
        if (canMeet) item {
            Row(modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { showing = true }) { Text("Show my code") }
                OutlinedButton(onClick = {
                    scan.launch(Intent(context, dev.pan.app.vpn.ScanPairActivity::class.java).putExtra("meet", true))
                }) { Text("Scan a code") }
            }
        }
        if (met.isEmpty()) item {
            Text("Nobody yet.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
        }
        items(met, key = { it.id }) { person ->
            var menu by remember { mutableStateOf(false) }
            Row(modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 4.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(person.name, style = MaterialTheme.typography.bodyLarge)
                    Text(if (person.times > 1) "Met ${person.times} times, last ${whenText(person.lastAt)}" else "Met ${whenText(person.lastAt)}",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "More for ${person.name}") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Forget") }, onClick = { menu = false; forgetting = person })
                    }
                }
            }
            HorizontalDivider(modifier = Modifier.padding(start = 20.dp))
        }
    }

    if (showing) {
        var uri by remember { mutableStateOf<String?>(null) }
        // A code is good for three minutes, so a fresh one is drawn every minute while this is open.
        LaunchedEffect(myName) {
            while (true) {
                uri = withContext(Dispatchers.Default) { MeetCard.mine(myName.ifBlank { "Someone" }) }
                delay(60_000)
            }
        }
        val qr = remember(uri) { uri?.let { qrBitmap(it, 720) } }
        AlertDialog(
            onDismissRequest = { showing = false },
            title = { Text("Your code") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Have them scan this with their ΠAN. It gives them the name ${myName.ifBlank { "Someone" }} and nothing else.")
                    if (qr != null) Image(bitmap = qr.asImageBitmap(), contentDescription = "Your ΠAN code", modifier = Modifier.size(260.dp))
                    Text("Then scan theirs, so you both have each other.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            confirmButton = { TextButton(onClick = { showing = false }) { Text("Done") } },
        )
    }

    scanned?.let { card ->
        AlertDialog(
            onDismissRequest = { scanned = null },
            title = { Text("Add ${card.name}?") },
            text = { Text("Their ΠAN gave the name ${card.name}. Your ΠAN keeps that you met, on your own computer. They are not told, and nothing of yours goes to them.") },
            confirmButton = { TextButton(onClick = { scanned = null; viewModel.addMet(card) }) { Text("Add") } },
            dismissButton = { TextButton(onClick = { scanned = null }) { Text("Cancel") } },
        )
    }

    forgetting?.let { person ->
        AlertDialog(
            onDismissRequest = { forgetting = null },
            title = { Text("Forget ${person.name}?") },
            text = { Text("Your ΠAN drops its record of meeting ${person.name}. If they scanned your code, their ΠAN still has theirs.") },
            confirmButton = { TextButton(onClick = { forgetting = null; viewModel.forgetMet(person) }) { Text("Forget") } },
            dismissButton = { TextButton(onClick = { forgetting = null }) { Text("Cancel") } },
        )
    }
}

/** One line about a call, with the one thing to do about it. */
@Composable
private fun CallBar(text: String, action: String, onAction: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        Row(modifier = Modifier.padding(start = 14.dp, end = 6.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Call, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
            Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.weight(1f).padding(horizontal = 10.dp))
            TextButton(onClick = onAction) { Text(action) }
        }
    }
}

/** The owner reading a child's conversations: who the child has talked with. Read only. */
@Composable
private fun ChildMessages(viewModel: PeopleViewModel, child: PersonLine) {
    val rows by viewModel.watchPeople.collectAsState()
    val first = firstName(child.name)
    BackHandler { viewModel.stopWatching() }
    Column(modifier = Modifier.fillMaxSize().statusBarsPadding()) {
        Row(modifier = Modifier.fillMaxWidth().padding(start = 4.dp, end = 16.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { viewModel.stopWatching() }) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to People")
            }
            Text("$first's messages", style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text("You can read these because $first is a child on your ΠAN. $first's device says that you can.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
        HorizontalDivider()
        val list = rows ?: return@Column
        if (list.isEmpty()) {
            Text("$first has not sent or been sent anything yet.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
            return@Column
        }
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(list, key = { it.id }) { person ->
                Row(modifier = Modifier.fillMaxWidth().clickable { viewModel.openTalk(person) }.padding(horizontal = 20.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(person.name, style = MaterialTheme.typography.bodyLarge)
                        Text((if (person.lastFromMe) "$first: " else "") + (person.last ?: ""), maxLines = 1, overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(whenText(person.lastAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                HorizontalDivider(modifier = Modifier.padding(start = 20.dp))
            }
        }
    }
}

/** readingFor: the child whose conversation the owner is reading (their lines on the right, nothing can be sent). */
@Composable
private fun Conversation(viewModel: PeopleViewModel, person: PersonLine, readingFor: PersonLine? = null) {
    val talk by viewModel.talk.collectAsState()
    val more by viewModel.more.collectAsState()
    val sending by viewModel.sending.collectAsState()
    val mayType by viewModel.canSend.collectAsState()
    val canSend = mayType && readingFor == null
    val talkWith by viewModel.talkWith.collectAsState()
    val talkJoined by viewModel.talkJoined.collectAsState()
    val onCall = talkWith == person.id
    var draft by remember(person.id) { mutableStateOf("") }
    val list = rememberLazyListState()
    val first = firstName(person.name)

    BackHandler { viewModel.closeTalk() }
    // Keep the newest line in view when one arrives or is sent.
    val newest = talk.lastOrNull()?.id
    LaunchedEffect(newest) { if (talk.isNotEmpty()) list.scrollToItem(talk.size - 1 + if (more) 1 else 0) }

    Column(modifier = Modifier.fillMaxSize().statusBarsPadding().imePadding()) {
        Row(modifier = Modifier.fillMaxWidth().padding(start = 4.dp, end = 16.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { viewModel.closeTalk() }) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to People")
            }
            Text(if (readingFor != null) "${firstName(readingFor.name)} and $first" else person.name,
                style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            // A call: after this, what this person says goes to them without "ΠAN, tell ..." each time.
            if (canSend && !onCall) IconButton(onClick = { viewModel.startTalk(person.id, first) }) {
                Icon(Icons.Default.Call, contentDescription = "Talk to $first")
            }
        }
        if (onCall) CallBar(if (talkJoined) "On with $first. Just talk." else "Calling $first. What you say is passed on.", "End") { viewModel.endTalk() }
        HorizontalDivider()
        if (talk.isEmpty()) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                Text(if (readingFor != null) "Nothing here." else "Nothing here yet. Say \"ΠAN, tell $first ...\" or type below. $first's device says it out loud, and it stays here.",
                    style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(state = list, modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (more) item(key = "earlier") {
                    Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        TextButton(onClick = { viewModel.earlier() }) { Text("Earlier") }
                    }
                }
                items(talk, key = { it.id }) { line -> Bubble(line, first) }
                item(key = "foot") { Spacer(Modifier.size(4.dp)) }
            }
        }
        if (canSend) {
            Row(modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(value = draft, onValueChange = { draft = it.take(500) },
                    placeholder = { Text("Message $first") }, maxLines = 4, modifier = Modifier.weight(1f))
                IconButton(enabled = draft.isNotBlank() && !sending, onClick = {
                    viewModel.send(draft) { sent -> if (sent) draft = "" }
                }) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send to $first") }
            }
        }
    }
}

@Composable
private fun Bubble(line: TalkLine, theirFirst: String) {
    Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = if (line.fromMe) Alignment.End else Alignment.Start) {
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = if (line.fromMe) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.widthIn(max = 300.dp),
        ) {
            Text(line.body, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                color = if (line.fromMe) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 6.dp)) {
            Text(whenText(line.at), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (line.fromMe) {
                Spacer(Modifier.width(6.dp))
                // Seen: they opened it here. Reached: their device has it (and said it unless muted). Else it waits.
                Text(when {
                    line.opened -> "Seen"
                    line.said -> "Reached $theirFirst's device"
                    else -> "Waiting for $theirFirst's device"
                }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
