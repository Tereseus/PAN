package dev.pan.app.ui.main

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import dev.pan.app.network.dto.DeviceSensorConfig
import dev.pan.app.network.dto.IntuitionSnapshot
import dev.pan.app.ui.commands.DeviceItem
import dev.pan.app.vpn.RemoteAccessManager

// The old single main screen lived here until 0.5.1. Home (ui/home/HomeScreen.kt) replaced it;
// what is left is the sensor list, which Settings > Privacy shows.

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

    Text("What each device may use", style = MaterialTheme.typography.bodyLarge,
        modifier = Modifier.padding(top = 8.dp))

    // Device picker
    if (devices.isNotEmpty()) {
        var expanded by remember { mutableStateOf(false) }

        LaunchedEffect(devices) {
            if (selectedDeviceId == null && devices.isNotEmpty()) {
                // This device first. "The first phone in the list" was the Pixel on every
                // other device, so the car head unit showed the Pixel's sensors (its mic
                // switched off) and its own microphone never appeared (2026-11-14).
                val phone = devices.find { viewModel.isThisDevice(it.id) }
                    ?: devices.find { it.device_type == "phone" } ?: devices.first()
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
            val ownMic = viewModel.isOwnMic(deviceId, sensor.id)
            val isOn = if (ownMic) isMicEnabled else sensor.enabled
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
                            onCheckedChange = { if (ownMic) onToggleMic() else viewModel.toggleSensorEnabled(deviceId, sensor.id, it) }
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
