package dev.pan.app.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import dev.pan.app.audio.ListenMode

/**
 * Settings: how ΠAN listens (audio/ListenMode.kt). The person's own words, in any language:
 * the name that wakes Name only, and the words that end Listen only. Long press the mic button
 * to pick the mode.
 */
@Composable
fun ListenWordsSection() {
    val ctx = LocalContext.current
    LaunchedEffect(Unit) { ListenMode.load(ctx) }
    val name by ListenMode.nameWords.collectAsState()
    val release by ListenMode.releaseWords.collectAsState()
    var nameText by remember(name) { mutableStateOf(name.joinToString("\n")) }
    val rememberW by ListenMode.rememberWords.collectAsState()
    var releaseText by remember(release) { mutableStateOf(release.joinToString("\n")) }
    // No words end Don't remember any more, only the button (owner, Nov 25), so the box for them is
    // gone (Nov 26); what was saved stays untouched.
    val rememberText = rememberW.joinToString("\n")
    val changed = nameText.trim() != name.joinToString("\n") || releaseText.trim() != release.joinToString("\n")

    Text("How ΠAN listens", style = MaterialTheme.typography.titleMedium)
    Text(
        "Hold the microphone to pick: Normal, Listen only (the ear: ΠAN hears and remembers but says nothing), " +
            "Name only (Π: it answers only when you start with its name), Don't remember (the hat: it talks, " +
            "but nothing is kept, for up to an hour) or Mute (only the button turns it back on). " +
            "Your own words below work in any language, one per line.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    OutlinedTextField(
        value = nameText, onValueChange = { nameText = it },
        label = { Text("Your name for ΠAN (Name only)") },
        placeholder = { Text("ΠAN always works") },
        modifier = Modifier.fillMaxWidth(), minLines = 2
    )
    OutlinedTextField(
        value = releaseText, onValueChange = { releaseText = it },
        label = { Text("Words that end Listen only") },
        placeholder = { Text("\"You can talk\" always works") },
        modifier = Modifier.fillMaxWidth(), minLines = 2
    )
    Button(onClick = { ListenMode.setWords(ctx, nameText, releaseText, rememberText) }, enabled = changed) { Text("Save") }
}
