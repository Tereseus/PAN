package dev.pan.app.ui.main

import androidx.compose.animation.animateContentSize
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
import dev.pan.app.network.dto.DeviceSensorConfig
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

                    val phoneName = viewModel.deviceName.collectAsState().value
                    val targetLabel = when (deviceTarget) {
                        "auto" -> if (isServerConnected) "Auto (PC connected)" else "Auto ($phoneName — offline)"
                        "phone" -> phoneName
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
                                text = { Text(phoneName) },
                                onClick = { viewModel.setDeviceTarget("phone"); targetExpanded = false }
                            )
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

            // Sensors — dynamic from server
            SensorSection(
                devices = devices,
                isMicEnabled = isMicEnabled,
                onToggleMic = { viewModel.toggleMic() },
                viewModel = viewModel
            )

            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}

@Composable
fun SensorSection(
    devices: List<DeviceItem>,
    isMicEnabled: Boolean,
    onToggleMic: () -> Unit,
    viewModel: MainViewModel
) {
    val sensors by viewModel.sensors.collectAsState()
    val sensorsLoading by viewModel.sensorsLoading.collectAsState()
    var selectedDeviceId by remember { mutableStateOf<Int?>(null) }
    var expandedSensor by remember { mutableStateOf<String?>(null) }

    Text("Sensors", style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(top = 8.dp))

    // Device picker
    if (devices.isNotEmpty()) {
        var expanded by remember { mutableStateOf(false) }

        LaunchedEffect(devices) {
            if (selectedDeviceId == null && devices.isNotEmpty()) {
                val phone = devices.find { it.device_type == "phone" } ?: devices.first()
                selectedDeviceId = phone.id
                viewModel.loadSensorsForDevice(phone.id)
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Device: ", style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Box {
                AssistChip(
                    onClick = { expanded = true },
                    label = {
                        val dev = devices.find { it.id == selectedDeviceId }
                        Text(dev?.name ?: "Select...")
                    }
                )
                DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                    devices.forEach { d ->
                        DropdownMenuItem(
                            text = { Text(d.name) },
                            onClick = {
                                selectedDeviceId = d.id
                                viewModel.loadSensorsForDevice(d.id)
                                expanded = false
                                expandedSensor = null
                            }
                        )
                    }
                }
            }
        }

        if (sensorsLoading) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }

        // All sensors for this device — simple ON/OFF toggle each
        sensors.forEach { sensor ->
            val deviceId = selectedDeviceId ?: return@forEach
            val isOn = sensor.enabled
            val isLocked = sensor.locked
            val isExpanded = expandedSensor == sensor.id

            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .animateContentSize(),
                colors = if (!isOn) CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)
                ) else CardDefaults.cardColors(),
                onClick = { expandedSensor = if (isExpanded) null else sensor.id }
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(sensor.icon ?: "", modifier = Modifier.width(32.dp),
                            style = MaterialTheme.typography.titleMedium)
                        Column(modifier = Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(sensor.name, style = MaterialTheme.typography.bodyLarge)
                                if (isLocked) {
                                    Text("🔒",  style = MaterialTheme.typography.labelSmall)
                                }
                            }
                            if (isLocked && sensor.policy_reason != null) {
                                Text(sensor.policy_reason!!, style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.tertiary, maxLines = 1)
                            } else {
                                sensor.description?.let {
                                    Text(it, style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1)
                                }
                            }
                        }
                        Switch(
                            checked = isOn,
                            enabled = !isLocked,
                            onCheckedChange = { viewModel.toggleSensorEnabled(deviceId, sensor.id, it) }
                        )
                    }

                    // Expanded: attachment checkboxes
                    if (isExpanded && isOn) {
                        Spacer(modifier = Modifier.height(8.dp))
                        HorizontalDivider()
                        Spacer(modifier = Modifier.height(6.dp))

                        val others = sensors.filter { it.id != sensor.id && it.muted != 1 }
                        if (others.isNotEmpty()) {
                            Text("When ${sensor.name} captures, also attach:",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(modifier = Modifier.height(4.dp))
                            others.forEach { other ->
                                val attached = sensor.attachments[other.id] ?: false
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable {
                                            viewModel.toggleSensorAttachment(deviceId, sensor.id, other.id, !attached)
                                        }
                                        .padding(vertical = 1.dp)
                                ) {
                                    Checkbox(
                                        checked = attached,
                                        onCheckedChange = {
                                            viewModel.toggleSensorAttachment(deviceId, sensor.id, other.id, it)
                                        },
                                        modifier = Modifier.size(32.dp)
                                    )
                                    Text("${other.icon ?: ""} ${other.name}",
                                        style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        } else {
                            Text("Turn on other sensors to attach their data.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
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
