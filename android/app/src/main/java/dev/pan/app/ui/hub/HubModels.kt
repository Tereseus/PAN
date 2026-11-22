package dev.pan.app.ui.hub

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pan.app.tts.VoicePace
import java.util.Locale

/**
 * Models (the owner, 2026-11-21): which models the hub uses for every device, with a picker for
 * each; the machines ΠAN can run models on (the owner 2026-11-22: every computer, its chips, its
 * measured speed, what runs there, a switch each); what this device hears and speaks with; how fast
 * it builds the voice; and how long his turns took on each device. The hub's part comes from
 * `GET /api/v1/voice/picks` and `GET /api/v1/compute`.
 */
@Composable
internal fun ModelsPart(
    picks: HubPicks?,
    noPicks: Boolean,
    device: DeviceVoice,
    onSetHubModel: (key: String, value: String) -> Unit,
    onSetPace: (Float?) -> Unit,
    machines: List<Machine>? = null,
    timing: String = "",
    onSetAllowed: (id: String, allowed: Boolean) -> Unit = { _, _ -> },
    onTestSpeed: (id: String) -> Unit = {},
) {
    // A hub model change waits here for a yes.
    var asked by remember { mutableStateOf<Pair<String, String>?>(null) }
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        item { Heading("On the hub") }
        when {
            noPicks -> item { Note("The hub has no picks list yet.") }
            picks == null -> item { Note("Asking the hub.") }
            else -> {
                picks.hubModel?.let { p -> item { PickRow("Answer model (hub)", "The smart one. Answers every line the voice reader hands up: questions, opinions, facts, anything that needs thought.", p) { asked = p.key to it } } }
                picks.readerModel?.let { p -> item { PickRow("Voice reader (hub)", "Reads each line first. Decides if you are talking to ΠAN, answers short things itself, hands the rest to the answer model.", p) { asked = p.key to it } } }
                if (picks.hubAsr.isNotBlank()) item { Line("Speech to text (hub)", picks.hubAsr, "Transcribes your recording again on the hub, more accurately than the device. ΠAN answers from this text.") }
            }
        }

        item { Heading("Machines") }
        when {
            machines == null -> item { Note(if (picks == null) "" else "Asking the hub.") }
            machines.isEmpty() -> item { Note("This hub has no machine list yet.") }
            else -> items(machines, key = { "m-${it.id}" }) { m -> MachineRow(m, timing, onSetAllowed, onTestSpeed) }
        }

        item { Heading("On this device") }
        item { Line("Speech to text (this device)", device.ear, "Transcribes live on the device, so ΠAN knows the moment you stop talking.") }
        item { VoicePart(device, onSetPace) }
        item {
            val t = device.timing
            Line("Voice timing", if (t.empty) "No lines measured yet."
                else "${t.ratio} ms to build each second of speech, ${t.medianBuildMs} ms a line, over ${t.count} lines",
                if (t.empty) "" else "Under 1000 ms a second, it builds faster than it talks.")
        }

        item { Heading("Your times") }
        val devices = picks?.devices.orEmpty()
        if (devices.isEmpty()) item { Note(if (picks == null) "" else "No turns on record yet.") }
        else {
            item { TimesRow("Device", "Average", "Middle", "Slowest", "Turns", header = true) }
            items(devices, key = { "t-${it.device}" }) { d ->
                TimesRow(d.device, secs(d.avgMs), secs(d.medianMs), secs(d.slowestMs), d.turns.toString())
            }
        }
        item { Spacer(Modifier.size(24.dp)) }
    }

    asked?.let { (key, value) ->
        AlertDialog(
            onDismissRequest = { asked = null },
            title = { Text("Change the model?") },
            text = { Text("This changes the model for every device.\n\n$value") },
            confirmButton = { TextButton(onClick = { onSetHubModel(key, value); asked = null }) { Text("Change") } },
            dismissButton = { TextButton(onClick = { asked = null }) { Text("Cancel") } },
        )
    }
}

private fun secs(ms: Long) = String.format(Locale.US, "%.1f s", ms / 1000.0)

@Composable
private fun Note(text: String) {
    if (text.isBlank()) return
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
}

@Composable
private fun Line(label: String, value: String, why: String = "") {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(120.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(value, style = MaterialTheme.typography.bodyLarge)
            if (why.isNotBlank()) Text(why, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun PickRow(label: String, what: String, pick: ModelPick, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(modifier = Modifier.width(120.dp)) {
            Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(what, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Box(modifier = Modifier.weight(1f)) {
            OutlinedButton(onClick = { open = true }, enabled = pick.choices.isNotEmpty(), modifier = Modifier.fillMaxWidth()) {
                Text(pick.value.ifBlank { "Not set" }, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                pick.choices.forEach { c ->
                    DropdownMenuItem(text = { Text(if (c == pick.value) "$c  (now)" else c) }, onClick = {
                        open = false
                        if (c != pick.value) onPick(c)
                    })
                }
            }
        }
    }
}

@Composable
private fun VoicePart(device: DeviceVoice, onSetPace: (Float?) -> Unit) {
    val pace = device.pace
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Text to speech (this device)", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(120.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(device.voice, style = MaterialTheme.typography.bodyLarge)
                Text("Speaks ΠAN's replies. Made on this device, so a slow device makes it slower.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (pace != null) Text("Speed %.2f, %d steps".format(Locale.US, pace.speed, pace.steps), style = MaterialTheme.typography.bodyMedium)
                if (device.liveSpeed > 0f) Text("A test speed of %.2f is on until the app restarts.".format(Locale.US, device.liveSpeed),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (pace == null) return@Column
        Row(modifier = Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(if (pace.auto) "Auto" else "Manual", style = MaterialTheme.typography.bodyLarge)
                Text(if (pace.auto) "ΠAN picks the speed for this device." else "The speed you set below.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(checked = pace.auto, onCheckedChange = { auto -> onSetPace(if (auto) null else pace.speed) })
        }
        if (!pace.auto) {
            var v by remember(pace.speed) { mutableFloatStateOf(pace.speed) }
            Text("Speed %.2f".format(Locale.US, v), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 4.dp))
            Slider(value = v, onValueChange = { v = VoicePace.snap(it) }, valueRange = VoicePace.MIN..VoicePace.MAX,
                steps = ((VoicePace.MAX - VoicePace.MIN) / VoicePace.STEP + 0.5f).toInt() - 1,
                onValueChangeFinished = { onSetPace(v) })
        }
    }
}

@Composable
private fun TimesRow(device: String, avg: String, middle: String, slowest: String, turns: String, header: Boolean = false) {
    val style = if (header) MaterialTheme.typography.labelMedium else MaterialTheme.typography.bodyMedium
    val color = if (header) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(device, style = style, color = color, modifier = Modifier.weight(1.6f), maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(avg, style = style, color = color, modifier = Modifier.weight(1f))
        Text(middle, style = style, color = color, modifier = Modifier.weight(1f))
        Text(slowest, style = style, color = color, modifier = Modifier.weight(1f))
        Text(turns, style = style, color = color, modifier = Modifier.weight(0.7f))
    }
}

/** One machine: name and switch, its chips, its measured speed with a test button, what runs there. */
@Composable
private fun MachineRow(m: Machine, timing: String, onSetAllowed: (String, Boolean) -> Unit, onTestSpeed: (String) -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(if (m.hub) "${m.name} (the hub)" else m.name, style = MaterialTheme.typography.bodyLarge)
                val state = when {
                    m.hub -> "Always on. Everything falls back here."
                    !m.online -> "Offline"
                    !m.allowed -> "Switched off. Its models run on the hub."
                    m.sharesCard -> "ΠAN may use it. WoE's running jobs finish first, new ones wait."
                    else -> "ΠAN may use it."
                }
                Text(state, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (!m.hub) Switch(checked = m.allowed, onCheckedChange = { onSetAllowed(m.id, it) })
        }
        Text(m.chips.ifBlank { "Its chips are not reported yet (an older ΠAN on that computer)." }, style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 4.dp))
        if (m.ollama) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                Text(MachineText.speed(m.tokS, m.speedModel, m.speedAt), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = { onTestSpeed(m.id) }, enabled = timing.isEmpty() && m.allowed && m.online) {
                    Text(if (timing == m.id) "Testing" else "Test speed")
                }
            }
            m.loaded.forEach { Text("Loaded: " + MachineText.loaded(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        } else {
            Text("No models run here.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        m.runs.forEach { Text("Runs here now: " + MachineText.run(it), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 2.dp)) }
    }
}
