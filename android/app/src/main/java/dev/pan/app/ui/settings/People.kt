package dev.pan.app.ui.settings

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * People: the family and others who use this ΠAN (docs/PEOPLE-PLAN.md).
 *
 * The owner adds a person, says what they are (adult, child, guest) and gets a code for that
 * person's device. A device paired with the code is that person's: it talks to ΠAN as them and
 * reaches nothing of the owner's. The hub decides all of it; this is only the screen. On a
 * device that is not the owner's the hub refuses these calls, and the section is not shown.
 */
private data class PersonRow(val id: Int, val name: String, val role: String, val devices: List<String>)

private val ROLES = listOf("user" to "Adult", "child" to "Child", "guest" to "Guest")
private fun roleLabel(role: String) = ROLES.firstOrNull { it.first == role }?.second ?: role.replaceFirstChar { it.uppercase() }
// Only what a person's device can do today: the house and messages are not built for them yet.
private fun roleCan(role: String) = when (role) {
    "child" -> "Talks to ΠAN and uses the camera, and nothing else unless you open it."
    else -> "Talks to ΠAN and uses the camera."
}

@Composable
internal fun PeopleSection(viewModel: SettingsViewModel, snackbar: SnackbarHostState) {
    val scope = rememberCoroutineScope()
    var people by remember { mutableStateOf<List<PersonRow>?>(null) }   // null: not the owner's device, or no hub
    var adding by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf<Pair<String, String>?>(null) }     // whose, the pairing link
    var removing by remember { mutableStateOf<PersonRow?>(null) }
    var renaming by remember { mutableStateOf<PersonRow?>(null) }
    var busy by remember { mutableStateOf(false) }

    suspend fun load() {
        if (!viewModel.ownersDevice()) { people = null; return }
        val users = viewModel.hub("GET", "/api/v1/auth/users")
        if (users == null || users.first != 200) { people = null; return }
        val devices = viewModel.hub("GET", "/api/v1/link/people")?.takeIf { it.first == 200 }?.second?.optJSONArray("devices")
        val byUser = HashMap<Int, MutableList<String>>()
        if (devices != null) for (i in 0 until devices.length()) {
            val d = devices.optJSONObject(i) ?: continue
            byUser.getOrPut(d.optInt("user_id")) { mutableListOf() }.add(d.optString("link_device_id"))
        }
        val list = users.second.optJSONArray("users")
        val rows = ArrayList<PersonRow>()
        if (list != null) for (i in 0 until list.length()) {
            val u = list.optJSONObject(i) ?: continue
            if (u.optString("role") == "owner" || u.optInt("is_active", 1) == 0) continue
            rows.add(PersonRow(u.optInt("id"), u.optString("display_name"), u.optString("role"), byUser[u.optInt("id")] ?: emptyList()))
        }
        people = rows
    }

    suspend fun codeFor(person: PersonRow) {
        busy = true
        val r = viewModel.hub("POST", "/api/v1/link/pair",
            JSONObject().put("name", "${person.name}'s device").put("for_user", person.id).put("ttl_minutes", 10))
        busy = false
        val uri = r?.takeIf { it.first == 200 }?.second?.optString("uri").orEmpty()
        if (uri.startsWith("pan://pair")) code = person.name to uri
        else snackbar.showSnackbar(r?.second?.optString("error")?.takeIf { it.isNotBlank() } ?: "ΠAN could not make a code right now.")
    }

    LaunchedEffect(Unit) { load() }
    val rows = people ?: return

    Text("People", style = MaterialTheme.typography.titleMedium)
    Text("Family and others who use this ΠAN. Each person's device talks to ΠAN as them and cannot reach your memory, your computers or your settings.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant)

    rows.forEach { person ->
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(person.name, style = MaterialTheme.typography.bodyLarge)
                Text("${roleLabel(person.role)} · " + when (person.devices.size) {
                    0 -> "no device yet"
                    1 -> "1 device"
                    else -> "${person.devices.size} devices"
                }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(enabled = !busy, onClick = { scope.launch { codeFor(person) } }) { Text("Add device") }
            TextButton(enabled = !busy, onClick = { renaming = person }) { Text("Rename") }
            TextButton(enabled = !busy, onClick = { removing = person }) { Text("Remove") }
        }
    }
    OutlinedButton(onClick = { adding = true }, enabled = !busy) { Text("Add a person") }

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
                        else { load(); codeFor(PersonRow(user.optInt("id"), user.optString("display_name"), user.optString("role"), emptyList())) }
                    }
                }) { Text("Add") }
            },
            dismissButton = { TextButton(onClick = { adding = false }) { Text("Cancel") } },
        )
    }

    code?.let { (whose, uri) ->
        val qr = remember(uri) { qrBitmap(uri, 640) }
        AlertDialog(
            onDismissRequest = { code = null; scope.launch { load() } },
            title = { Text("$whose's device") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Install ΠAN on their device and scan this code with it. The code works once, for 10 minutes.")
                    if (qr != null) Image(bitmap = qr.asImageBitmap(), contentDescription = "Pairing code for $whose", modifier = Modifier.size(240.dp))
                    Text("Show it only to them: whoever scans it gets $whose's place on your ΠAN.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            confirmButton = { TextButton(onClick = { code = null; scope.launch { load() } }) { Text("Done") } },
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
                        load()
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
                        load()
                    }
                }) { Text("Remove") }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
}
