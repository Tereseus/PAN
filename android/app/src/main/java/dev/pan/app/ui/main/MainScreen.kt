package dev.pan.app.ui.main

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import dev.pan.app.ui.commands.DeviceItem

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(
    onNavigateToSettings: () -> Unit,
    onNavigateToConversation: () -> Unit,
    onNavigateToCommands: () -> Unit = {},
    onNavigateToDashboard: () -> Unit = {},
    viewModel: MainViewModel = hiltViewModel()
) {
    val isServerConnected by viewModel.isServerConnected.collectAsState()
    val isMicEnabled by viewModel.isMicEnabled.collectAsState()
    val lastAction by viewModel.lastAction.collectAsState()
    val pendingCount by viewModel.pendingCount.collectAsState()
    val deviceTarget by viewModel.deviceTarget.collectAsState()
    val devices by viewModel.devices.collectAsState()
    var targetExpanded by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("ΠΑΝ") },
                actions = {
                    IconButton(onClick = onNavigateToSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
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
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            // Dashboard — primary entry point
            Button(
                onClick = onNavigateToDashboard,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("ΠΑΝ Dashboard")
            }

            // Last action
            if (lastAction.isNotEmpty()) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text("Last action", style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(lastAction, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }

            // Server status
            Card(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Server", style = MaterialTheme.typography.titleMedium)
                        Text(
                            if (isServerConnected) "Connected" else "Disconnected",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (isServerConnected) MaterialTheme.colorScheme.primary
                                   else MaterialTheme.colorScheme.error
                        )
                        if (pendingCount > 0) {
                            Text("$pendingCount items pending",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.secondary)
                        }
                    }
                    StatusDot(isActive = isServerConnected)
                }
            }

            // Device target
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Default Device", style = MaterialTheme.typography.titleMedium)
                    Spacer(modifier = Modifier.height(4.dp))

                    val targetLabel = when (deviceTarget) {
                        "auto" -> if (isServerConnected) "Auto (PC connected)" else "Auto (Phone — offline)"
                        "phone" -> "This Phone"
                        else -> devices.find { it.hostname == deviceTarget }?.name ?: deviceTarget
                    }

                    Box {
                        AssistChip(
                            onClick = { targetExpanded = true },
                            label = { Text(targetLabel) }
                        )

                        DropdownMenu(
                            expanded = targetExpanded,
                            onDismissRequest = { targetExpanded = false }
                        ) {
                            DropdownMenuItem(
                                text = { Text("Auto (nearest connected)") },
                                onClick = { viewModel.setDeviceTarget("auto"); targetExpanded = false }
                            )
                            DropdownMenuItem(
                                text = { Text("This Phone") },
                                onClick = { viewModel.setDeviceTarget("phone"); targetExpanded = false }
                            )
                            // Show only non-phone devices (phone is already "This Phone" above)
                            val otherDevices = devices.filter { it.device_type != "phone" }
                            if (otherDevices.isNotEmpty()) {
                                HorizontalDivider()
                                otherDevices.forEach { device ->
                                    DropdownMenuItem(
                                        text = { Text("${device.name} (${device.device_type})") },
                                        onClick = { viewModel.setDeviceTarget(device.hostname); targetExpanded = false }
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Sensor toggles
            Text("Sensors", style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(top = 8.dp))

            SensorToggleCard(
                name = "Microphone / STT",
                description = if (isMicEnabled) "Always on — listening and remembering" else "Paused — PAN is not remembering",
                isEnabled = isMicEnabled,
                onToggle = { viewModel.toggleMic() }
            )

            SensorToggleCard(
                name = "Camera",
                description = "Waiting for Pandant",
                isEnabled = false,
                onToggle = { },
                available = false
            )

            SensorToggleCard(
                name = "Pandant Sensors",
                description = "Waiting for BLE connection",
                isEnabled = false,
                onToggle = { },
                available = false
            )

            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}

@Composable
fun SensorToggleCard(
    name: String,
    description: String,
    isEnabled: Boolean,
    onToggle: () -> Unit,
    available: Boolean = true
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = if (!available) CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
        ) else CardDefaults.cardColors()
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            StatusDot(isActive = isEnabled && available)
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.bodyLarge)
                Text(description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(
                checked = isEnabled,
                onCheckedChange = { onToggle() },
                enabled = available
            )
        }
    }
}

@Composable
fun StatusDot(isActive: Boolean) {
    Surface(
        modifier = Modifier.size(12.dp),
        shape = MaterialTheme.shapes.extraLarge,
        color = if (isActive) MaterialTheme.colorScheme.primary
               else MaterialTheme.colorScheme.error.copy(alpha = 0.4f)
    ) {}
}
