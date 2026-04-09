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
import dev.pan.app.vpn.RemoteAccessManager

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
    val sttStatus by viewModel.sttStatus.collectAsState()
    val pendingCount by viewModel.pendingCount.collectAsState()
    val deviceTarget by viewModel.deviceTarget.collectAsState()
    val devices by viewModel.devices.collectAsState()
    val context = androidx.compose.ui.platform.LocalContext.current

    // Auto-launch VPN consent dialog on first load if not yet consented
    val vpnLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == android.app.Activity.RESULT_OK) {
            viewModel.connectTailscale()
        }
    }

    androidx.compose.runtime.LaunchedEffect(Unit) {
        val vpnIntent = android.net.VpnService.prepare(context)
        if (vpnIntent != null) {
            vpnLauncher.launch(vpnIntent)
        } else {
            viewModel.connectTailscale()
        }
    }
    val remoteAccessEnabled by viewModel.remoteAccessEnabled.collectAsState()
    val remoteAccessStatus by viewModel.remoteAccessStatus.collectAsState()
    val remoteAccessIp by viewModel.remoteAccessIp.collectAsState()
    val remoteAccessOrg by viewModel.remoteAccessOrg.collectAsState()
    val displayNickname by viewModel.displayNickname.collectAsState()
    val activeOrgName by viewModel.activeOrgName.collectAsState()
    var targetExpanded by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    // Tier 0 Phase 5: Π · <orgName> · <displayNickname>
                    // Π is the universal brand mark; org tells you WHERE you are;
                    // nickname tells you WHO. Middle-dot separators look more
                    // designed than dashes or @ signs.
                    val parts = buildList {
                        add("Π")
                        if (activeOrgName.isNotBlank()) add(activeOrgName)
                        if (displayNickname.isNotBlank()) add(displayNickname)
                    }
                    Text(parts.joinToString(" · "))
                },
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
                onClick = {
                    android.util.Log.w("PAN-DASH", "Dashboard button tapped!")
                    onNavigateToDashboard()
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("PAN Dashboard")
            }

            // Microphone toggle — LIVE (red) or Muted
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = if (isMicEnabled) MaterialTheme.colorScheme.errorContainer
                                    else MaterialTheme.colorScheme.surfaceVariant
                )
            ) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            if (isMicEnabled) "LIVE" else "Muted",
                            style = MaterialTheme.typography.titleMedium,
                            color = if (isMicEnabled) MaterialTheme.colorScheme.error
                                   else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            if (isMicEnabled) "PAN is listening" else "Tap to enable microphone",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (isMicEnabled) MaterialTheme.colorScheme.error.copy(alpha = 0.7f)
                                   else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Switch(
                        checked = isMicEnabled,
                        onCheckedChange = { viewModel.toggleMic() },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = MaterialTheme.colorScheme.error,
                            checkedTrackColor = MaterialTheme.colorScheme.errorContainer
                        )
                    )
                }
            }

            // Last action / STT status — always visible
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    if (lastAction.isNotEmpty()) {
                        Text("Last Action", style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(lastAction, style = MaterialTheme.typography.bodyMedium)
                    }
                    Text("STT: $sttStatus", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            // Connection Status
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Connection", style = MaterialTheme.typography.titleMedium)
                    // Server / org hub — labeled by the active org name (Tier 0 Phase 5)
                    val hubLabel = if (activeOrgName.isNotBlank()) "$activeOrgName Hub" else "PAN Hub"
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        StatusDot(isActive = isServerConnected)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            if (isServerConnected) "Connected — $hubLabel" else "Disconnected — $hubLabel",
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (isServerConnected) MaterialTheme.colorScheme.primary
                                   else MaterialTheme.colorScheme.error
                        )
                    }
                    // Secure tunnel
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        StatusDot(isActive = remoteAccessStatus == "Connected")
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            when (remoteAccessStatus) {
                                "Connected" -> "Secure - Tailscale Encrypted"
                                "Connecting..." -> "Secure - Connecting..."
                                else -> "Secure - $remoteAccessStatus"
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (remoteAccessStatus == "Connected") MaterialTheme.colorScheme.primary
                                   else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    // AI backend
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        StatusDot(isActive = isServerConnected)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            if (isServerConnected) "AI - Cerebras (Active)" else "AI - Offline",
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (isServerConnected) MaterialTheme.colorScheme.primary
                                   else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    // Tailscale IP intentionally hidden from the main view per
                    // Tier 0 Phase 5 design. It's still visible from the
                    // Settings → Diagnostics screen for troubleshooting.
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
