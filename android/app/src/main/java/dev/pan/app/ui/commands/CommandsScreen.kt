package dev.pan.app.ui.commands

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CommandsScreen(
    onBack: () -> Unit,
    viewModel: CommandsViewModel = hiltViewModel()
) {
    val commands by viewModel.commands.collectAsState()
    val devices by viewModel.devices.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Commands") },
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
        ) {
            if (devices.isNotEmpty()) {
                Text("Devices", style = MaterialTheme.typography.titleMedium)
                Spacer(modifier = Modifier.height(8.dp))
                for (device in devices) {
                    Card(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                        Row(modifier = Modifier.padding(12.dp)) {
                            Text(device.name, style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.weight(1f))
                            Text(device.device_type,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                Spacer(modifier = Modifier.height(16.dp))
            }

            Text("Command History", style = MaterialTheme.typography.titleMedium)
            Text("Tap a command to see processing details",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(modifier = Modifier.height(8.dp))

            if (commands.isEmpty()) {
                Text("No commands yet.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(commands) { cmd ->
                    CommandCard(cmd, viewModel)
                }
            }
        }
    }
}

@Composable
fun CommandCard(cmd: CommandItem, viewModel: CommandsViewModel) {
    var expanded by remember { mutableStateOf(false) }
    val logs by viewModel.getLogsFor(cmd.id).collectAsState(initial = emptyList())

    val statusColor = when (cmd.status) {
        "completed" -> Color(0xFF4CAF50)
        "failed" -> Color(0xFFF44336)
        "pending", "processing" -> Color(0xFFFFA726)
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded }
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row {
                Text(cmd.text.ifEmpty { cmd.command },
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f))
                Text(cmd.status,
                    style = MaterialTheme.typography.labelSmall,
                    color = statusColor)
            }
            if (cmd.result.isNotEmpty()) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(cmd.result,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = if (expanded) Int.MAX_VALUE else 2)
            }

            // Expandable log details
            AnimatedVisibility(visible = expanded && logs.isNotEmpty()) {
                Column(modifier = Modifier.padding(top = 8.dp)) {
                    HorizontalDivider()
                    Spacer(modifier = Modifier.height(4.dp))
                    Text("Processing Log", style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary)
                    for (log in logs) {
                        Row(modifier = Modifier.padding(vertical = 2.dp)) {
                            Text(log.step,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.width(80.dp))
                            Text(log.detail,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(2.dp))
            Text("${cmd.command_type} | ${cmd.target_device} | ${cmd.created_at}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

data class CommandItem(
    val id: Long,
    val target_device: String,
    val command_type: String,
    val command: String,
    val text: String,
    val status: String,
    val result: String,
    val created_at: String
)

data class DeviceItem(
    val id: Int = 0,
    val hostname: String,
    val name: String,
    val device_type: String,
    val last_seen: String
)

data class LogItem(
    val id: Long,
    val command_id: Long,
    val step: String,
    val detail: String,
    val created_at: String
)
