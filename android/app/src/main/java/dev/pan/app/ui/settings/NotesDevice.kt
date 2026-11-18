package dev.pan.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Which of the owner's devices ΠAN's notes come to: reminders, messages, and a thread's answer
 * that arrives after the talk has moved on (the hub's phone-notes.js). One device gets them, so
 * a reminder is not read out by the phone, the tablet and the car at once. The owner can send
 * them to the device in his hand, or let them follow the device he last talked to ΠAN on.
 * The hub decides; this is only the screen. Not shown on a device that is another person's:
 * that device gets its own person's notes and nothing else.
 */
@Composable
internal fun NotesDeviceSection(viewModel: SettingsViewModel, snackbar: SnackbarHostState) {
    val scope = rememberCoroutineScope()
    // The name this device sends with every request (PanForegroundService.getPanDeviceId).
    val here = remember { android.os.Build.MODEL.lowercase().replace(" ", "-") }
    var loaded by remember { mutableStateOf(false) }
    var pinned by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun pretty(key: String) = key.split('-').joinToString(" ") { w -> w.replaceFirstChar { it.uppercase() } }

    suspend fun load() {
        if (!viewModel.ownersDevice()) { loaded = false; return }
        val r = viewModel.hub("GET", "/api/v1/notify/devices")
        if (r == null || r.first != 200) { loaded = false; return }
        pinned = r.second.optString("pinned").takeIf { it.isNotBlank() && it != "null" }
        loaded = true
    }

    suspend fun pin(key: String) {
        busy = true
        val r = viewModel.hub("PUT", "/api/v1/settings", JSONObject().put("notes_device", key))
        busy = false
        if (r == null || r.first != 200) snackbar.showSnackbar("ΠAN could not change that right now.")
        else pinned = key.takeIf { it.isNotBlank() }
    }

    LaunchedEffect(Unit) { load() }
    if (!loaded) return

    Text("Reminders and messages", style = MaterialTheme.typography.titleMedium)
    Text(when (pinned) {
        null -> "ΠAN reads them out on the device you last talked to it on."
        here -> "ΠAN reads them out on this device."
        else -> "ΠAN reads them out on ${pretty(pinned!!)}."
    } + " One device gets each one, never all of them at once.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (pinned != here) OutlinedButton(enabled = !busy, onClick = { scope.launch { pin(here) } }) { Text("Send them here") }
        if (pinned != null) OutlinedButton(enabled = !busy, onClick = { scope.launch { pin("") } }) { Text("Follow me") }
    }

    HorizontalDivider()
}
