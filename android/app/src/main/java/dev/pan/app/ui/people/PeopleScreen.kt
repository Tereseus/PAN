package dev.pan.app.ui.people

import androidx.activity.compose.BackHandler
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import kotlinx.coroutines.delay
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
    val message by viewModel.message.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(message) { message?.let { snackbar.showSnackbar(it); viewModel.clearMessage() } }

    // Fresh while the tab is on screen and the app is in front; nothing is asked otherwise.
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(open?.id) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            if (viewModel.open.value == null) viewModel.load(withDevices = true)
            while (true) {
                delay(5000)
                if (viewModel.open.value != null) viewModel.loadTalk() else viewModel.load(withDevices = false)
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        val person = open
        if (person != null) Conversation(viewModel, person) else PeopleList(viewModel, snackbar)
        SnackbarHost(snackbar, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 72.dp))
    }
}

@Composable
private fun PeopleList(viewModel: PeopleViewModel, snackbar: SnackbarHostState) {
    val people by viewModel.people.collectAsState()
    val failed by viewModel.failed.collectAsState()
    val owner by viewModel.owner.collectAsState()
    val canSend by viewModel.canSend.collectAsState()
    val scope = rememberCoroutineScope()

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
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            if (!canSend) item {
                Text("Whoever set up this ΠAN has not opened messages for you.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            }
            if (rows.isEmpty() && canSend) item {
                Text(if (owner) "Nobody else is on your ΠAN yet. Add family or others: each person's device talks to ΠAN as them and cannot reach your memory, your computers or your settings."
                    else "Nobody else is on this ΠAN yet.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            }
            items(rows, key = { it.id }) { person ->
                PersonRow(person, owner = owner, busy = busy,
                    onOpen = { viewModel.openTalk(person) },
                    onAddDevice = { scope.launch { codeFor(person.id, person.name) } },
                    onRename = { renaming = person },
                    onRemove = { removing = person })
                HorizontalDivider(modifier = Modifier.padding(start = 20.dp))
            }
            if (owner) item {
                OutlinedButton(onClick = { adding = true }, enabled = !busy,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp)) { Text("Add a person") }
            }
            if (rows.isNotEmpty() && canSend) item {
                Text("Say \"ΠAN, tell ${firstName(rows.first().name)} ...\" and their device says it. Or open a name and type.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            }
        }
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
    onOpen: () -> Unit, onAddDevice: () -> Unit, onRename: () -> Unit, onRemove: () -> Unit,
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
                }
                person.role == "owner" -> "Owner"
                else -> null
            }
            if (about != null) Text(about, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                DropdownMenuItem(text = { Text("Add device") }, onClick = { menu = false; onAddDevice() })
                DropdownMenuItem(text = { Text("Rename") }, onClick = { menu = false; onRename() })
                DropdownMenuItem(text = { Text("Remove") }, onClick = { menu = false; onRemove() })
            }
        }
    }
}

@Composable
private fun Conversation(viewModel: PeopleViewModel, person: PersonLine) {
    val talk by viewModel.talk.collectAsState()
    val more by viewModel.more.collectAsState()
    val sending by viewModel.sending.collectAsState()
    val canSend by viewModel.canSend.collectAsState()
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
            Text(person.name, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        HorizontalDivider()
        if (talk.isEmpty()) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                Text("Nothing here yet. Say \"ΠAN, tell $first ...\" or type below. $first's device says it out loud, and it stays here.",
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
