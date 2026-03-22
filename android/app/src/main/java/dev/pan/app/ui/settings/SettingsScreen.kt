package dev.pan.app.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    viewModel: SettingsViewModel = hiltViewModel()
) {
    val serverUrl by viewModel.serverUrl.collectAsState()
    val beepEnabled by viewModel.beepEnabled.collectAsState()
    val vibrationEnabled by viewModel.vibrationEnabled.collectAsState()
    val voiceResponseEnabled by viewModel.voiceResponseEnabled.collectAsState()
    val deviceTarget by viewModel.deviceTarget.collectAsState()
    val devices by viewModel.devices.collectAsState()
    val preferredMusicApp by viewModel.preferredMusicApp.collectAsState()
    val preferredMessagingApp by viewModel.preferredMessagingApp.collectAsState()
    val selectedLlmModel by viewModel.selectedLlmModel.collectAsState()
    val llmStatus by viewModel.llmStatus.collectAsState()
    val llmDownloadProgress by viewModel.llmDownloadProgress.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Connection
            Text("Connection", style = MaterialTheme.typography.titleMedium)

            OutlinedTextField(
                value = serverUrl,
                onValueChange = { viewModel.setServerUrl(it) },
                label = { Text("PAN Server URL") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )
            Text("Your PC's IP with port 7777",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)

            HorizontalDivider()

            // Feedback
            Text("Feedback", style = MaterialTheme.typography.titleMedium)

            SettingToggle(
                title = "Voice Responses",
                description = "PAN speaks responses aloud via TTS",
                checked = voiceResponseEnabled,
                onToggle = { viewModel.setVoiceResponse(it) }
            )

            SettingToggle(
                title = "Sound Effects",
                description = "Audio tone when a command is detected",
                checked = beepEnabled,
                onToggle = { viewModel.setBeep(it) }
            )

            SettingToggle(
                title = "Vibration",
                description = "Haptic feedback on commands",
                checked = vibrationEnabled,
                onToggle = { viewModel.setVibration(it) }
            )

            HorizontalDivider()

            // Device Preference
            Text("Device Preference", style = MaterialTheme.typography.titleMedium)
            Text("Where should PAN execute actions by default?",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)

            val deviceOptions = listOf("auto" to "Auto (nearest device)") +
                devices.map { it.hostname to "${it.name} (${it.device_type})" }

            deviceOptions.forEach { (value, label) ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    RadioButton(
                        selected = deviceTarget == value,
                        onClick = { viewModel.setDeviceTarget(value) }
                    )
                    Text(label, modifier = Modifier.padding(start = 8.dp))
                }
            }

            HorizontalDivider()

            // App Preferences
            Text("App Preferences", style = MaterialTheme.typography.titleMedium)

            SettingDropdown(
                title = "Music App",
                description = "Preferred app for playing music",
                selected = preferredMusicApp,
                options = listOf("Auto", "Spotify", "YouTube", "YouTube Music"),
                onSelect = { viewModel.setPreferredMusicApp(it) }
            )

            SettingDropdown(
                title = "Messaging App",
                description = "Preferred app for sending messages",
                selected = preferredMessagingApp,
                options = listOf("Auto", "SMS", "WhatsApp", "Instagram", "Telegram"),
                onSelect = { viewModel.setPreferredMessagingApp(it) }
            )

            HorizontalDivider()

            // Local LLM
            Text("Local AI Model", style = MaterialTheme.typography.titleMedium)

            // Status indicator
            val statusColor = when (llmStatus) {
                "loaded" -> MaterialTheme.colorScheme.primary
                "downloaded" -> MaterialTheme.colorScheme.tertiary
                "downloading" -> MaterialTheme.colorScheme.secondary
                else -> MaterialTheme.colorScheme.error
            }
            val statusText = when (llmStatus) {
                "loaded" -> "Installed & Running"
                "downloaded" -> "Installed (not loaded)"
                "downloading" -> "Downloading... ${(llmDownloadProgress * 100).toInt()}%"
                "not_downloaded" -> "Not installed"
                else -> llmStatus
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(
                    shape = MaterialTheme.shapes.small,
                    color = statusColor.copy(alpha = 0.15f),
                    modifier = Modifier.padding(end = 8.dp)
                ) {
                    Text(
                        statusText,
                        color = statusColor,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp)
                    )
                }
            }

            // Progress bar when downloading
            if (llmStatus == "downloading") {
                LinearProgressIndicator(
                    progress = { llmDownloadProgress },
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)
                )
            }

            val llmOptions = listOf(
                "llama-3.2-1b" to "Llama 3.2 1B (700MB, fast)",
                "llama-3.2-3b" to "Llama 3.2 3B (2GB, recommended)",
                "phi-3.5-mini" to "Phi 3.5 Mini (2.2GB, best quality)"
            )

            llmOptions.forEach { (value, label) ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    RadioButton(
                        selected = selectedLlmModel == value,
                        onClick = { viewModel.setSelectedLlmModel(value) }
                    )
                    Text(label, modifier = Modifier.padding(start = 8.dp))
                }
            }

            // Download button if not installed
            if (llmStatus == "not_downloaded") {
                Button(
                    onClick = { viewModel.downloadModel() },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("Download Model")
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingDropdown(
    title: String,
    description: String,
    selected: String,
    options: List<String>,
    onSelect: (String) -> Unit
) {
    var expanded by remember { mutableStateOf(false) }

    Column {
        Text(title, style = MaterialTheme.typography.bodyLarge)
        Text(description,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        ExposedDropdownMenuBox(
            expanded = expanded,
            onExpandedChange = { expanded = !expanded }
        ) {
            OutlinedTextField(
                value = selected,
                onValueChange = {},
                readOnly = true,
                modifier = Modifier.menuAnchor().fillMaxWidth(),
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) }
            )
            ExposedDropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false }
            ) {
                options.forEach { option ->
                    DropdownMenuItem(
                        text = { Text(option) },
                        onClick = {
                            onSelect(option)
                            expanded = false
                        }
                    )
                }
            }
        }
    }
}

@Composable
fun SettingToggle(
    title: String,
    description: String,
    checked: Boolean,
    onToggle: (Boolean) -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(
            checked = checked,
            onCheckedChange = onToggle
        )
    }
}
