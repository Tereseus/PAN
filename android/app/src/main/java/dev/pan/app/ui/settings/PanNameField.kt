package dev.pan.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import dev.pan.app.util.PanName

/** ΠAN's name on this device (util/PanName.kt): what this phone or pendant answers to. */
@Composable
fun PanNameField() {
    val ctx = LocalContext.current
    var saved by remember { PanName.load(ctx); mutableStateOf(PanName.name) }
    var input by remember(saved) { mutableStateOf(saved) }
    Text("ΠAN's name", style = MaterialTheme.typography.titleMedium)
    Text(
        if (saved.isEmpty()) "Give ΠAN its own name on this device. Then it answers to that name, and not to ΠAN."
        else "On this device ΠAN is called $saved. It answers to $saved, not to ΠAN.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    OutlinedTextField(
        value = input,
        onValueChange = { input = it.take(PanName.MAX_CHARS) },
        label = { Text("Name") },
        placeholder = { Text("ΠAN") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (PanName.clean(input) != saved) {
            Button(onClick = { PanName.set(ctx, input); saved = PanName.name }, modifier = Modifier.weight(1f)) {
                Text(if (PanName.clean(input).isEmpty()) "Use ΠAN" else "Save")
            }
        }
        if (saved.isNotEmpty()) {
            OutlinedButton(onClick = { PanName.set(ctx, ""); saved = ""; input = "" }, modifier = Modifier.weight(1f)) {
                Text("Back to ΠAN")
            }
        }
    }
}
