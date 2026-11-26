package dev.pan.app.ui.people

import android.app.Activity
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.background
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
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
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
import dev.pan.app.service.PanForegroundService
import dev.pan.app.ui.home.MicButton
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
    val room by viewModel.room.collectAsState()
    val message by viewModel.message.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val actions = remember { PersonActions() }
    LaunchedEffect(message) { message?.let { snackbar.showSnackbar(it); viewModel.clearMessage() } }

    // Fresh while the tab is on screen and the app is in front; nothing is asked otherwise.
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(open?.id, watching?.id, room?.first) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            if (viewModel.open.value == null && viewModel.watching.value == null) viewModel.load(withDevices = true)
            while (true) {
                // With a group's call on screen: who is on, and what was said, quickly.
                delay(if (viewModel.room.value != null) 2000 else 5000)
                viewModel.tick()
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        val person = open
        val child = watching
        val group = room
        when {
            group != null -> RoomTalk(viewModel, group.first, group.second)
            person != null -> Conversation(viewModel, person, actions, snackbar, readingFor = child)
            child != null -> ChildMessages(viewModel, child)
            else -> PeopleList(viewModel, snackbar, actions)
        }
        PersonDialogs(viewModel, actions, snackbar)
        SnackbarHost(snackbar, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 72.dp))
    }
}

/**
 * What the owner can do to one person. Asked from inside that person's conversation (the "..."
 * there), shown as dialogs over whatever is on screen.
 */
private class PersonActions {
    var renaming by mutableStateOf<PersonLine?>(null)
    var removing by mutableStateOf<PersonLine?>(null)
    var groupsFor by mutableStateOf<PersonLine?>(null)
    var alsoCalled by mutableStateOf<PersonLine?>(null)
    var code by mutableStateOf<Pair<String, String>?>(null)      // whose, the pairing link
    var busy by mutableStateOf(false)
}

/** A one-time code for a device of this person's. */
private suspend fun codeFor(viewModel: PeopleViewModel, actions: PersonActions, snackbar: SnackbarHostState, id: Int, name: String) {
    actions.busy = true
    val r = viewModel.hub("POST", "/api/v1/link/pair",
        JSONObject().put("name", "$name's device").put("for_user", id).put("ttl_minutes", 10))
    actions.busy = false
    val uri = r?.takeIf { it.first == 200 }?.second?.optString("uri").orEmpty()
    if (uri.startsWith("pan://pair")) actions.code = name to uri
    else snackbar.showSnackbar(r?.second?.optString("error")?.takeIf { it.isNotBlank() } ?: "ΠAN could not make a code right now.")
}

@Composable
private fun PeopleList(viewModel: PeopleViewModel, snackbar: SnackbarHostState, actions: PersonActions) {
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
    val roomOn by viewModel.roomOn.collectAsState()
    val roomsRinging by viewModel.roomsRinging.collectAsState()
    val roomsOpen by viewModel.roomsOpen.collectAsState()
    val roomsCan by viewModel.roomsCan.collectAsState()
    val myId by viewModel.myId.collectAsState()
    val myMode by viewModel.myMode.collectAsState()
    val myModeLocked by viewModel.myModeLocked.collectAsState()
    val scope = rememberCoroutineScope()
    // What is being looked at (the owner, 2026-11-18: one drop down): "all" the organization on
    // this hub, "g<id>" one group in it, "others" the people with a ΠAN of their own.
    var part by rememberSaveable { mutableStateOf("all") }
    var picking by remember { mutableStateOf(false) }
    var naming by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var newGroup by remember { mutableStateOf(false) }
    var filling by remember { mutableStateOf<GroupLine?>(null) }
    var renamingGroup by remember { mutableStateOf<GroupLine?>(null) }
    // Deleting a group asks first (owner, Nov 26).
    var deletingGroup by remember { mutableStateOf<GroupLine?>(null) }
    LaunchedEffect(Unit) { viewModel.loadMet() }

    // Mute wherever a call can be taken or made (the owner, 2026-11-18).
    val micOn by PanForegroundService.micEnabled.collectAsState()
    val micContext = LocalContext.current
    Column(modifier = Modifier.fillMaxSize().statusBarsPadding()) {
        Row(modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 16.dp, top = 12.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("People", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            MicButton(on = micOn, diameter = 40.dp, onClick = {
                micContext.startService(android.content.Intent(micContext, PanForegroundService::class.java).apply { action = "TOGGLE_MIC" })
            })
        }
        if (!micOn && (talkWith != 0 || callingMe != 0 || roomOn != null || roomsRinging.isNotEmpty())) Text("Muted: nobody on a call can hear you, and ΠAN cannot either. Tap the microphone to unmute.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp))
        val rows = people
        if (rows == null) {
            if (failed) Text("ΠAN could not be reached. The people on it show here when it can.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp))
            return@Column
        }
        // The drop down. First the organization by the name the owner gave it (a family, a
        // workplace), then its groups, then everyone else.
        val orgName = group.ifBlank { "Family" }
        val current = groups.firstOrNull { part == "g${it.id}" }
        val showOthers = canMeet || met.isNotEmpty()
        val showing = when {
            part == "others" && showOthers -> "others"
            current != null -> part
            else -> "all"
        }
        if (groups.isNotEmpty() || showOthers || owner) {
            Box(modifier = Modifier.padding(horizontal = 16.dp)) {
                OutlinedButton(onClick = { picking = true }) {
                    Text(when (showing) { "others" -> "Everyone else"; "all" -> orgName; else -> current?.name ?: orgName })
                    Icon(Icons.Default.ArrowDropDown, contentDescription = "Choose who to show")
                }
                DropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
                    DropdownMenuItem(text = { Text(orgName, fontWeight = if (showing == "all") FontWeight.SemiBold else FontWeight.Normal) },
                        onClick = { picking = false; part = "all" })
                    groups.forEach { g ->
                        DropdownMenuItem(text = { Text(g.name, fontWeight = if (showing == "g${g.id}") FontWeight.SemiBold else FontWeight.Normal) },
                            onClick = { picking = false; part = "g${g.id}" })
                    }
                    if (showOthers) DropdownMenuItem(text = { Text("Everyone else", fontWeight = if (showing == "others") FontWeight.SemiBold else FontWeight.Normal) },
                        onClick = { picking = false; part = "others" })
                    if (owner) {
                        HorizontalDivider()
                        DropdownMenuItem(text = { Text("New group") }, onClick = { picking = false; newGroup = true })
                    }
                }
            }
        }
        if (showing == "others") { MetPart(viewModel); return@Column }
        val shown = if (current != null && showing != "all") rows.filter { current.id in it.groups } else rows
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            // A call: who is calling, or who this person is on with. Always in view, whatever is picked.
            rows.firstOrNull { it.id == callingMe }?.let { caller ->
                item(key = "calling") {
                    CallBar("${firstName(caller.name)} wants to talk.", "Answer", second = "Not now", onSecond = { viewModel.declineTalk(caller.id) }) {
                        viewModel.startTalk(caller.id, firstName(caller.name))
                    }
                }
            }
            rows.firstOrNull { it.id == talkWith }?.let { other ->
                item(key = "oncall") {
                    CallBar(if (talkJoined) "On with ${firstName(other.name)}. Just talk." else "Calling ${firstName(other.name)}. What you say is passed on.", "End") { viewModel.endTalk() }
                }
            }
            // A call with a whole group: one that rings, the one this person is on, one going on.
            roomsRinging.forEach { r ->
                item(key = "roomring-${r.key}") {
                    val who = rows.firstOrNull { it.id == r.by }?.let { firstName(it.name) } ?: "Someone"
                    CallBar("$who is calling ${r.name}.", "Answer", second = "Not now", onSecond = { viewModel.declineRoom(r.key) }) {
                        viewModel.startRoom(r.key, r.name); viewModel.openRoom(r.key, r.name)
                    }
                }
            }
            roomOn?.let { r ->
                item(key = "roomon") {
                    CallBar(roomText(r, myId), "Leave", second = "Open", onSecond = { viewModel.openRoom(r.key, r.name) }) { viewModel.leaveRoom() }
                }
            }
            roomsOpen.filter { o -> roomsRinging.none { it.key == o.key } }.forEach { r ->
                item(key = "roomopen-${r.key}") {
                    CallBar("${r.name}: ${namesOn(r, myId).ifBlank { "a call" }} on now.", "Join") { viewModel.startRoom(r.key, r.name); viewModel.openRoom(r.key, r.name) }
                }
            }
            // Call everyone who is showing: the whole organization, or the group picked above.
            val callKey = if (current != null && showing != "all") "g${current.id}" else "all"
            val callName = if (callKey == "all") group.ifBlank { "everyone" } else current?.name.orEmpty()
            val busyHere = roomOn?.key == callKey || roomsRinging.any { it.key == callKey } || roomsOpen.any { it.key == callKey }
            if (canSend && callKey in roomsCan && !busyHere) item(key = "callgroup") {
                Row(modifier = Modifier.padding(start = 20.dp, end = 16.dp, top = 8.dp, bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    FilledTonalButton(onClick = { viewModel.startRoom(callKey, callName); viewModel.openRoom(callKey, callName) }) {
                        Icon(Icons.Default.Call, contentDescription = null, modifier = Modifier.size(18.dp))
                        Text("Call $callName", modifier = Modifier.padding(start = 6.dp))
                    }
                    TextButton(onClick = { viewModel.openRoom(callKey, callName) }) { Text("Earlier calls") }
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
            if (current != null && showing != "all" && shown.isEmpty()) item {
                Text("Nobody is in ${current.name} yet.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            }
            items(shown, key = { it.id }) { person ->
                PersonRow(person, owner = owner, onOpen = { viewModel.openTalk(person) })
                HorizontalDivider(modifier = Modifier.padding(start = 20.dp))
            }
            // The owner's buttons for what is showing: a group's people and name, or the organization's.
            if (owner && current != null && showing != "all") item {
                Row(modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(onClick = { filling = current }) { Text("Choose people") }
                    TextButton(onClick = { renamingGroup = current }) { Text("Rename") }
                    TextButton(onClick = { deletingGroup = current }) { Text("Delete") }
                }
            }
            if (owner && showing == "all") item {
                Row(modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(onClick = { adding = true }, enabled = !actions.busy) { Text("Add a person") }
                    TextButton(onClick = { naming = true }) { Text(if (group.isBlank()) "Name it" else "Rename $group") }
                }
            }
            if (shown.isNotEmpty() && canSend) item {
                Text("Tap someone to write or call. Or say \"ΠAN, tell ${firstName(shown.first().name)} ...\" for one message, or \"ΠAN, talk to ${firstName(shown.first().name)}\" and then just talk.",
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

    if (newGroup) {
        var name by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { newGroup = false },
            title = { Text("New group") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("A group or a team inside ${group.ifBlank { "Family" }}. Call it anything. It shows in the list at the top; pick it there to choose its people.",
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
            confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = { newGroup = false; viewModel.addGroup(name) }) { Text("Make it") } },
            dismissButton = { TextButton(onClick = { newGroup = false }) { Text("Cancel") } },
        )
    }

    filling?.let { g ->
        AlertDialog(
            onDismissRequest = { filling = null },
            title = { Text("Who is in ${g.name}") },
            text = {
                LazyColumn {
                    items(people.orEmpty(), key = { it.id }) { person ->
                        val inIt = g.id in person.groups
                        Row(modifier = Modifier.fillMaxWidth().clickable { viewModel.setInGroup(person.id, g.id, !inIt) },
                            verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = inIt, onCheckedChange = { viewModel.setInGroup(person.id, g.id, it) })
                            Text(person.name, style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { filling = null }) { Text("Done") } },
        )
    }

    deletingGroup?.let { g ->
        AlertDialog(
            onDismissRequest = { deletingGroup = null },
            title = { Text("Delete ${g.name}?") },
            text = { Text("The group goes away. The people in it stay on your ΠAN.") },
            confirmButton = {
                TextButton(onClick = { deletingGroup = null; part = "all"; viewModel.removeGroup(g.id) }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deletingGroup = null }) { Text("Cancel") } },
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
                TextButton(enabled = name.isNotBlank() && !actions.busy, onClick = {
                    scope.launch {
                        actions.busy = true
                        val r = viewModel.hub("POST", "/api/v1/auth/users", JSONObject().put("display_name", name.trim()).put("role", role))
                        actions.busy = false
                        adding = false
                        val user = r?.takeIf { it.first == 200 }?.second?.optJSONObject("user")
                        if (user == null) snackbar.showSnackbar(r?.second?.optString("error")?.takeIf { it.isNotBlank() } ?: "ΠAN could not add them right now.")
                        else { viewModel.load(withDevices = true); codeFor(viewModel, actions, snackbar, user.optInt("id"), user.optString("display_name")) }
                    }
                }) { Text("Add") }
            },
            dismissButton = { TextButton(onClick = { adding = false }) { Text("Cancel") } },
        )
    }
}

/** The dialogs for what the owner does to one person. Over the list or over a conversation. */
@Composable
private fun PersonDialogs(viewModel: PeopleViewModel, actions: PersonActions, snackbar: SnackbarHostState) {
    val people by viewModel.people.collectAsState()
    val groups by viewModel.groups.collectAsState()
    val scope = rememberCoroutineScope()

    actions.code?.let { (whose, uri) ->
        val qr = remember(uri) { qrBitmap(uri, 640) }
        AlertDialog(
            onDismissRequest = { actions.code = null; viewModel.refresh(withDevices = true) },
            title = { Text("$whose's device") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Install ΠAN on their device and scan this code with it. The code works once, for 10 minutes.")
                    if (qr != null) Image(bitmap = qr.asImageBitmap(), contentDescription = "Pairing code for $whose", modifier = Modifier.size(240.dp))
                    Text("Show it only to them: whoever scans it gets $whose's place on your ΠAN.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            confirmButton = { TextButton(onClick = { actions.code = null; viewModel.refresh(withDevices = true) }) { Text("Done") } },
        )
    }

    actions.groupsFor?.let { asked ->
        // The list keeps loading while this is open: show the person as they are now.
        val person = people?.firstOrNull { it.id == asked.id } ?: asked
        AlertDialog(
            onDismissRequest = { actions.groupsFor = null },
            title = { Text("${firstName(person.name)}'s groups") },
            text = {
                Column {
                    if (groups.isEmpty()) Text("There are no groups yet. Make one from the list at the top of People.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    groups.forEach { g ->
                        val inIt = g.id in person.groups
                        Row(modifier = Modifier.fillMaxWidth().clickable { viewModel.setInGroup(person.id, g.id, !inIt) },
                            verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = inIt, onCheckedChange = { viewModel.setInGroup(person.id, g.id, it) })
                            Text(g.name, style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { actions.groupsFor = null }) { Text("Done") } },
        )
    }

    actions.alsoCalled?.let { person ->
        var names by remember(person.id) { mutableStateOf(person.aka.joinToString(", ")) }
        AlertDialog(
            onDismissRequest = { actions.alsoCalled = null },
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
                    actions.alsoCalled = null
                    viewModel.setNames(person.id, names.split(',').map { it.trim() }.filter { it.isNotEmpty() }.take(4))
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { actions.alsoCalled = null }) { Text("Cancel") } },
        )
    }

    actions.renaming?.let { person ->
        var name by remember(person.id) { mutableStateOf(person.name) }
        AlertDialog(
            onDismissRequest = { actions.renaming = null },
            title = { Text("Rename ${person.name}") },
            text = {
                OutlinedTextField(value = name, onValueChange = { name = it.take(40) }, label = { Text("Name") },
                    singleLine = true, modifier = Modifier.fillMaxWidth())
            },
            confirmButton = {
                TextButton(enabled = name.isNotBlank() && name.trim() != person.name && !actions.busy, onClick = {
                    actions.renaming = null
                    scope.launch {
                        actions.busy = true
                        val r = viewModel.hub("PUT", "/api/v1/auth/users/${person.id}/name", JSONObject().put("display_name", name.trim()))
                        actions.busy = false
                        if (r == null || r.first != 200) snackbar.showSnackbar(r?.second?.optString("error")?.takeIf { it.isNotBlank() } ?: "ΠAN could not rename them right now.")
                        viewModel.load(withDevices = false)
                    }
                }) { Text("Rename") }
            },
            dismissButton = { TextButton(onClick = { actions.renaming = null }) { Text("Cancel") } },
        )
    }

    actions.removing?.let { person ->
        AlertDialog(
            onDismissRequest = { actions.removing = null },
            title = { Text("Remove ${person.name}?") },
            text = {
                Text(if (person.devices.isEmpty()) "${person.name} will no longer be on your ΠAN."
                else "${person.name}'s ${if (person.devices.size == 1) "device" else "devices"} will stop reaching your ΠAN, and ${person.name} will no longer be on it.")
            },
            confirmButton = {
                TextButton(onClick = {
                    actions.removing = null
                    scope.launch {
                        actions.busy = true
                        // The devices first: a device left paired after its person is gone is nobody's.
                        var left = 0
                        person.devices.forEach { id ->
                            val r = viewModel.hub("DELETE", "/api/v1/link/devices/$id")
                            if (r == null || r.first !in listOf(200, 404)) left++
                        }
                        val r = if (left == 0) viewModel.hub("DELETE", "/api/v1/auth/users/${person.id}") else null
                        actions.busy = false
                        if (r == null || r.first != 200) snackbar.showSnackbar(
                            if (left > 0) "ΠAN could not remove ${person.name}'s device, so ${person.name} is still there. Try again."
                            else "ΠAN could not remove ${person.name} right now.")
                        else viewModel.closeTalk()
                        viewModel.load(withDevices = true)
                    }
                }) { Text("Remove") }
            },
            dismissButton = { TextButton(onClick = { actions.removing = null }) { Text("Cancel") } },
        )
    }
}

/** One person in the list. Tap to open their conversation; everything else about them is in there. */
@Composable
private fun PersonRow(person: PersonLine, owner: Boolean, onOpen: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(start = 20.dp, end = 16.dp, top = 10.dp, bottom = 10.dp),
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
                owner -> roleLabel(person.role) + (if (person.devices.isEmpty()) " · no device yet" else "")
                person.role == "owner" -> "Owner"
                else -> null
            }
            if (about != null) Text(about, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(horizontalAlignment = Alignment.End, modifier = Modifier.padding(start = 8.dp)) {
            val at = whenText(person.lastAt)
            if (at.isNotEmpty()) Text(at, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (person.unread > 0) Badge(modifier = Modifier.padding(top = 4.dp)) { Text("${person.unread}") }
        }
    }
}

// Names offered when the owner makes a group. Only a start: any name works.
private val GROUP_IDEAS = listOf("Kids", "Team", "Guests", "Friends")

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
/**
 * A call, on every tab that is not People (the owner, 2026-11-18: answering meant finding the
 * People tab first). Small, in the top corner: who is calling with Answer and Not now, or who
 * this person is on with and End.
 */
@Composable
fun CallStrip(viewModel: PeopleViewModel, modifier: Modifier = Modifier) {
    val people by viewModel.people.collectAsState()
    val talkWith by viewModel.talkWith.collectAsState()
    val talkJoined by viewModel.talkJoined.collectAsState()
    val callingMe by viewModel.callingMe.collectAsState()
    val roomOn by viewModel.roomOn.collectAsState()
    val roomsRinging by viewModel.roomsRinging.collectAsState()
    val caller = people?.firstOrNull { it.id == callingMe }
    val other = people?.firstOrNull { it.id == talkWith }
    val ringing = roomsRinging.firstOrNull()
    val group = roomOn
    if (caller == null && other == null && (ringing != null || group != null)) {
        // A call with a whole group, the same way: who is calling which group, or the one this person is on.
        Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(12.dp), shadowElevation = 4.dp, modifier = modifier) {
            Row(modifier = Modifier.padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Call, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(18.dp))
                if (ringing != null) {
                    val who = people?.firstOrNull { it.id == ringing.by }?.let { firstName(it.name) } ?: "Someone"
                    Text("$who is calling ${ringing.name}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onPrimaryContainer,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 8.dp).widthIn(max = 170.dp))
                    TextButton(onClick = { viewModel.declineRoom(ringing.key) }) { Text("Not now") }
                    TextButton(onClick = { viewModel.startRoom(ringing.key, ringing.name) }) { Text("Answer") }
                } else if (group != null) {
                    Text(if (group.on.size > 1) "On with ${group.name}" else "Calling ${group.name}", style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onPrimaryContainer, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(horizontal = 8.dp).widthIn(max = 200.dp))
                    TextButton(onClick = { viewModel.leaveRoom() }) { Text("Leave") }
                }
            }
        }
        return
    }
    if (caller == null && other == null) return
    Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(12.dp), shadowElevation = 4.dp, modifier = modifier) {
        Row(modifier = Modifier.padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Call, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(18.dp))
            if (caller != null) {
                Text("${firstName(caller.name)} is calling", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.padding(horizontal = 8.dp))
                TextButton(onClick = { viewModel.declineTalk(caller.id) }) { Text("Not now") }
                TextButton(onClick = { viewModel.startTalk(caller.id, firstName(caller.name)) }) { Text("Answer") }
            } else if (other != null) {
                Text(if (talkJoined) "On with ${firstName(other.name)}" else "Calling ${firstName(other.name)}", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.padding(horizontal = 8.dp))
                TextButton(onClick = { viewModel.endTalk() }) { Text("End") }
            }
        }
    }
}

@Composable
private fun CallBar(text: String, action: String, second: String? = null, onSecond: () -> Unit = {}, onAction: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        Row(modifier = Modifier.padding(start = 14.dp, end = 6.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Call, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
            Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.weight(1f).padding(horizontal = 10.dp))
            if (second != null) TextButton(onClick = onSecond) { Text(second) }
            TextButton(onClick = onAction) { Text(action) }
        }
    }
}

/** The others who are on a group's call, by first name: "Mia", "Mia and Kit", "Mia, Kit and Sam". */
private fun namesOn(r: RoomCall, myId: Int): String {
    val names = r.on.filter { it.first != myId }.map { it.second }
    return when (names.size) {
        0 -> ""
        1 -> names[0]
        else -> names.dropLast(1).joinToString(", ") + " and " + names.last()
    }
}

private fun roomText(r: RoomCall, myId: Int): String {
    val others = namesOn(r, myId)
    return if (others.isBlank()) "Calling ${r.name}. What you say is passed on." else "On with ${r.name}: $others. Just talk."
}

/**
 * A call with a whole group (the owner, 2026-11-18). The same as a call with one person: what
 * this person says is heard by their own device and read out by the devices of the others who
 * are on. What shows here is what this person said or heard in this group's calls.
 */
@Composable
private fun RoomTalk(viewModel: PeopleViewModel, key: String, name: String) {
    val said by viewModel.roomSaid.collectAsState()
    val roomOn by viewModel.roomOn.collectAsState()
    val roomsRinging by viewModel.roomsRinging.collectAsState()
    val roomsOpen by viewModel.roomsOpen.collectAsState()
    val roomsCan by viewModel.roomsCan.collectAsState()
    val myId by viewModel.myId.collectAsState()
    val mayType by viewModel.canSend.collectAsState()
    val sending by viewModel.sending.collectAsState()
    val here = roomOn?.takeIf { it.key == key }
    val going = roomsRinging.firstOrNull { it.key == key } ?: roomsOpen.firstOrNull { it.key == key }
    var draft by remember(key) { mutableStateOf("") }
    val list = rememberLazyListState()
    val micOn by PanForegroundService.micEnabled.collectAsState()
    val context = LocalContext.current

    BackHandler { viewModel.closeRoom() }
    val newest = said.lastOrNull()?.id
    LaunchedEffect(newest) { if (said.isNotEmpty()) list.scrollToItem(said.size - 1) }

    Column(modifier = Modifier.fillMaxSize().statusBarsPadding().imePadding()) {
        Row(modifier = Modifier.fillMaxWidth().padding(start = 4.dp, end = 16.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { viewModel.closeRoom() }) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to People")
            }
            Text(name.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            when {
                here != null -> FilledTonalButton(onClick = { viewModel.leaveRoom() }) { Text("Leave") }
                mayType && (key in roomsCan || going != null) -> FilledTonalButton(onClick = { viewModel.startRoom(key, name) }) {
                    Icon(Icons.Default.Call, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(if (going != null) "Join" else "Call", modifier = Modifier.padding(start = 6.dp))
                }
            }
        }
        // Where this person's voice is going right now, in words.
        val others = here?.let { namesOn(it, myId) }.orEmpty()
        Text(when {
            here == null && going != null -> "${namesOn(going, myId).ifBlank { "Someone" }} on a call now. Tap Join to come on."
            here == null -> "Tap Call to ring everyone in $name. Then just talk: what you say goes to whoever comes on. Or say \"ΠAN, call $name\"."
            !micOn -> "Muted: nobody can hear you. You still hear the others. Tap the microphone below to talk."
            others.isBlank() -> "Ringing. What you say is passed on once someone comes on. Start with \"ΠAN\" to ask ΠAN something."
            else -> "On with $others. They hear you, and you hear them. Start with \"ΠAN\" to ask ΠAN something."
        }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
        if (here == null && going != null && roomsRinging.any { it.key == key }) {
            CallBar("${going.name} is ringing you.", "Answer", second = "Not now", onSecond = { viewModel.declineRoom(key) }) { viewModel.startRoom(key, name) }
        }
        HorizontalDivider()
        if (said.isEmpty()) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                Text("Nothing here yet. What you say and hear in a call with $name stays here, for you.",
                    style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(state = list, modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(said, key = { it.id }) { line ->
                    Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = if (line.fromMe) Alignment.End else Alignment.Start) {
                        if (!line.fromMe) Text(line.name, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 8.dp))
                        Surface(shape = RoundedCornerShape(16.dp),
                            color = if (line.fromMe) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                            modifier = Modifier.widthIn(max = 300.dp)) {
                            Text(line.body, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                                color = if (line.fromMe) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text(whenText(line.at), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 6.dp))
                    }
                }
                item(key = "foot") { Spacer(Modifier.size(4.dp)) }
            }
        }
        // The same row as on Home: the words (only while on the call), and the microphone to the right.
        Row(modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically) {
            if (here != null && mayType) {
                val sendNow = { if (draft.isNotBlank() && !sending) viewModel.sayRoom(draft) { sent -> if (sent) draft = "" } }
                Row(modifier = Modifier.weight(1f).heightIn(min = 52.dp).clip(RoundedCornerShape(26.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant).padding(horizontal = 18.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    BasicTextField(
                        value = draft,
                        onValueChange = { draft = it.take(500) },
                        modifier = Modifier.weight(1f),
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        maxLines = 4,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { sendNow() }),
                        decorationBox = { inner ->
                            if (draft.isEmpty()) Text("Type to $name", style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                            inner()
                        }
                    )
                    IconButton(onClick = { sendNow() }, enabled = draft.isNotBlank() && !sending, modifier = Modifier.size(36.dp)) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send to $name",
                            tint = if (draft.isNotBlank()) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            } else Spacer(Modifier.weight(1f))
            Spacer(Modifier.width(12.dp))
            MicButton(on = micOn, onClick = {
                context.startService(android.content.Intent(context, PanForegroundService::class.java).apply { action = "TOGGLE_MIC" })
            })
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
private fun Conversation(viewModel: PeopleViewModel, person: PersonLine, actions: PersonActions, snackbar: SnackbarHostState, readingFor: PersonLine? = null) {
    val owner by viewModel.owner.collectAsState()
    val menuScope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
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
    // Mute, here too (the owner, 2026-11-18): a muted ΠAN reads nothing out and hears nothing,
    // and from inside a conversation there was no way to see or change that.
    val micOn by PanForegroundService.micEnabled.collectAsState()
    val context = LocalContext.current

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
            // A call: after this, what this person says goes to them without "ΠAN, tell ..." each time.
            // A button with its name on it: beside a bare microphone it read as "talk" (the owner, 2026-11-18).
            if (canSend && !onCall) FilledTonalButton(onClick = { viewModel.startTalk(person.id, first) }) {
                Icon(Icons.Default.Call, contentDescription = null, modifier = Modifier.size(18.dp))
                Text("Call", modifier = Modifier.padding(start = 6.dp))
            }
            // Everything about this person lives here, not on the list.
            if (readingFor == null) Box {
                IconButton(onClick = { menu = true }, enabled = !actions.busy) {
                    Icon(Icons.Default.MoreVert, contentDescription = "More for ${person.name}")
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    // Anyone's own choice: take calls from this person or not.
                    DropdownMenuItem(text = { Text(if (person.callsOff) "Take calls from $first" else "Don't take calls from $first") },
                        onClick = { menu = false; viewModel.setCalls(person.id, person.callsOff) })
                    // The rest is the owner's, about a person on his ΠAN.
                    if (owner && person.role != "owner") {
                    // A child's conversations with others are the owner's to read (the hub holds this to children).
                    if (person.role == "child") DropdownMenuItem(text = { Text("$first's messages") }, onClick = { menu = false; viewModel.closeTalk(); viewModel.watch(person) })
                    DropdownMenuItem(text = { Text("Groups") }, onClick = { menu = false; actions.groupsFor = person })
                    DropdownMenuItem(text = { Text("Other names") }, onClick = { menu = false; actions.alsoCalled = person })
                    // How what is sent to them reaches them: the owner's to set and lock, or theirs to choose.
                    DropdownMenuItem(text = { Text("Messages: read out") }, onClick = { menu = false; viewModel.setMode("speak", person.id, true) })
                    DropdownMenuItem(text = { Text("Messages: show only") }, onClick = { menu = false; viewModel.setMode("show", person.id, true) })
                    if (person.locked) DropdownMenuItem(text = { Text("Let $first choose") }, onClick = { menu = false; viewModel.setMode(person.mode, person.id, false) })
                    DropdownMenuItem(text = { Text("Add device") }, onClick = { menu = false; menuScope.launch { codeFor(viewModel, actions, snackbar, person.id, person.name) } })
                    DropdownMenuItem(text = { Text("Rename") }, onClick = { menu = false; actions.renaming = person })
                    DropdownMenuItem(text = { Text("Remove") }, onClick = { menu = false; actions.removing = person })
                    }
                }
            }
        }
        // Where this person's voice is going right now, in words: nobody should have to guess.
        if (readingFor == null) Text(when {
            !micOn && onCall -> "Muted: $first cannot hear you. You still hear $first. Tap the microphone below to talk."
            !micOn -> "Muted. What $first sends shows here, not read out."
            onCall && talkJoined -> "$first hears you, and you hear $first. Start with \"ΠAN\" to ask ΠAN something."
            onCall -> "What you say is passed on to $first once they answer. Start with \"ΠAN\" to ask ΠAN something."
            else -> "ΠAN is listening, and what you say goes to ΠAN, not to $first. To talk to $first, tap Call."
        }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
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
            // The same box as on Home (the owner, 2026-11-18): the words, the send arrow at their
            // end, and the microphone to the right of it.
            Row(modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 12.dp),
                verticalAlignment = Alignment.CenterVertically) {
                val shape = RoundedCornerShape(26.dp)
                val sendNow = { if (draft.isNotBlank() && !sending) viewModel.send(draft) { sent -> if (sent) draft = "" } }
                Row(modifier = Modifier.weight(1f).heightIn(min = 52.dp).clip(shape)
                        .background(MaterialTheme.colorScheme.surfaceVariant).padding(horizontal = 18.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    BasicTextField(
                        value = draft,
                        onValueChange = { draft = it.take(500) },
                        modifier = Modifier.weight(1f),
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        maxLines = 4,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { sendNow() }),
                        decorationBox = { inner ->
                            if (draft.isEmpty()) Text("Type to $first", style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                            inner()
                        }
                    )
                    IconButton(onClick = { sendNow() }, enabled = draft.isNotBlank() && !sending, modifier = Modifier.size(36.dp)) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send to $first",
                            tint = if (draft.isNotBlank()) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.width(12.dp))
                MicButton(on = micOn, onClick = {
                    context.startService(android.content.Intent(context, PanForegroundService::class.java).apply { action = "TOGGLE_MIC" })
                })
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
