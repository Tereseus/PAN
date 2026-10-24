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
    val intuition by viewModel.intuition.collectAsState()
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

            // ONE status card. There used to be two stacked cards that both said
            // idle: IntuitionCard headed with the user's activity ("Idle") and
            // PanThinkingCard headed "PAN Idle". Two collapsed cards saying the
            // same word is not two pieces of information. They are now one card,
            // PAN's own state on top because that is the live part, the user's
            // state under it, and it opens expanded - a status card you have to
            // tap to read is not a status card.
            val isThinking by viewModel.isThinking.collectAsState()
            val currentFiller by viewModel.currentFiller.collectAsState()
            val lastQueryText by viewModel.lastQueryText.collectAsState()
            val lastResponseText by viewModel.lastResponseText.collectAsState()
            val lastResponseMs by viewModel.lastResponseMs.collectAsState()
            val lastFirstChunkMs by viewModel.lastFirstChunkMs.collectAsState()
            StatusCard(
                snapshot = intuition,
                isThinking = isThinking,
                filler = currentFiller,
                lastQuery = lastQueryText,
                lastResponse = lastResponseText,
                lastResponseMs = lastResponseMs,
                firstChunkMs = lastFirstChunkMs,
            )

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
                            // Was "AI - Cerebras (Active)". Cerebras has returned 402 on
                            // every model since August and nothing has routed through it
                            // since; naming it here was simply false. The label says what
                            // this dot actually knows - whether the hub is answering.
                            if (isServerConnected) "AI - Connected" else "AI - Offline",
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

/**
 * ONE status card.
 *
 * There used to be two, stacked, and both of them said idle: IntuitionCard was
 * headed with the user's activity ("Idle") and PanThinkingCard was headed "PAN
 * Idle". Two collapsed cards showing the same word is not two pieces of
 * information, it is one piece of information and a duplicate.
 *
 * Merged, in this order on purpose:
 *   PAN's state first  - thinking / ready, the reply, the response-time badge.
 *                        That is the part that changes while he is talking.
 *   His state second   - activity, mood, where. That is the context for it.
 *
 * Opens EXPANDED. A status card you have to tap before it tells you anything is
 * not a status card.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StatusCard(
    snapshot: IntuitionSnapshot?,
    isThinking: Boolean,
    filler: String,
    lastQuery: String,
    lastResponse: String,
    lastResponseMs: Long,
    firstChunkMs: Long,
) {
    var expanded by remember { mutableStateOf(true) }

    val now = snapshot?.now
    val activity = now?.activity ?: "Waiting for signal..."
    val mood = now?.mood ?: "Neutral"
    val moodEmoji = when (mood.lowercase()) {
        "engaged", "focused", "productive", "energetic" -> "\uD83D\uDFE2"
        "calm", "relaxed", "neutral", "normal" -> "\uD83D\uDD35"
        "tired", "distracted", "bored" -> "\uD83D\uDFE1"
        "stressed", "frustrated", "anxious" -> "\uD83D\uDFE0"
        "angry", "upset" -> "\uD83D\uDD34"
        else -> "\uD83D\uDD35"
    }

    // Response time: green < 2s, yellow < 5s, red beyond.
    val rtSeconds = lastResponseMs / 1000.0
    val rtColor = when {
        lastResponseMs <= 0 -> MaterialTheme.colorScheme.onSurfaceVariant
        rtSeconds < 2.0 -> MaterialTheme.colorScheme.primary
        rtSeconds < 5.0 -> MaterialTheme.colorScheme.tertiary
        else -> MaterialTheme.colorScheme.error
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .animateContentSize(),
        colors = CardDefaults.cardColors(
            containerColor = if (isThinking) MaterialTheme.colorScheme.primaryContainer
                            else MaterialTheme.colorScheme.surfaceVariant
        ),
        onClick = { expanded = !expanded }
    ) {
        Column(modifier = Modifier.padding(14.dp)) {

            // ---- PAN ------------------------------------------------------
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(if (isThinking) "\uD83E\uDDE0" else "\u03A0", fontSize = 20.sp)
                Spacer(modifier = Modifier.width(8.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        if (isThinking) "PAN is thinking\u2026" else "PAN ready",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    val subtitle = when {
                        isThinking && filler.isNotBlank() -> filler
                        lastResponse.isNotBlank() -> lastResponse
                        else -> "Waiting for your next question"
                    }
                    Text(
                        subtitle,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                if (lastResponseMs > 0 && !isThinking) {
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = rtColor.copy(alpha = 0.15f)
                    ) {
                        Text(
                            "\u21B3 ${"%.1f".format(rtSeconds)}s",
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                            style = MaterialTheme.typography.labelSmall,
                            color = rtColor,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                }
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    if (expanded) "\u25B2" else "\u25BC",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // ---- him ------------------------------------------------------
            Spacer(modifier = Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text(moodEmoji, fontSize = 16.sp)
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    buildString {
                        append(activity)
                        if (!now?.where.isNullOrBlank()) append("  \u00B7  ").also { append(now!!.where) }
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }

            if (expanded) {
                Spacer(modifier = Modifier.height(10.dp))
                HorizontalDivider()
                Spacer(modifier = Modifier.height(8.dp))

                if (lastQuery.isNotBlank()) {
                    Text("You asked", style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(lastQuery, style = MaterialTheme.typography.bodySmall,
                        maxLines = 3, overflow = TextOverflow.Ellipsis)
                    Spacer(modifier = Modifier.height(6.dp))
                }
                if (lastResponse.isNotBlank()) {
                    Text("PAN replied", style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(lastResponse, style = MaterialTheme.typography.bodySmall,
                        maxLines = 4, overflow = TextOverflow.Ellipsis)
                    Spacer(modifier = Modifier.height(8.dp))
                }

                Row(modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("First chunk", style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(if (firstChunkMs > 0) "${firstChunkMs}ms" else "\u2014",
                            style = MaterialTheme.typography.bodySmall)
                    }
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Total", style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(if (lastResponseMs > 0) "${"%.2f".format(rtSeconds)}s" else "\u2014",
                            style = MaterialTheme.typography.bodySmall, color = rtColor)
                    }
                }

                if (isThinking) {
                    Spacer(modifier = Modifier.height(8.dp))
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }

                if (now != null) {
                    Spacer(modifier = Modifier.height(10.dp))
                    HorizontalDivider()
                    Spacer(modifier = Modifier.height(8.dp))

                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Focus", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(now.focus ?: "\u2014", style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Mood", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text("$moodEmoji $mood", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    Spacer(modifier = Modifier.height(6.dp))
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Direction", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(now.direction ?: "\u2014", style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Urgency", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(now.urgency ?: "Normal", style = MaterialTheme.typography.bodySmall)
                        }
                    }

                    val topics = now.recent_topics
                    if (!topics.isNullOrEmpty()) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text("Recent Topics", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(modifier = Modifier.height(4.dp))
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            topics.take(5).forEach { topic ->
                                Surface(
                                    shape = RoundedCornerShape(12.dp),
                                    color = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
                                ) {
                                    Text(topic,
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.primary)
                                }
                            }
                        }
                    }

                    val services = snapshot?.pan?.services
                    if (!services.isNullOrEmpty()) {
                        Spacer(modifier = Modifier.height(8.dp))
                        val running = services.count { it.status == "Running" }
                        val stopped = services.filter { it.status != "Running" }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Services", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(modifier = Modifier.width(6.dp))
                            Surface(shape = RoundedCornerShape(12.dp),
                                color = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)) {
                                Text("$running running",
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.primary)
                            }
                            stopped.forEach { svc ->
                                Spacer(modifier = Modifier.width(4.dp))
                                Surface(shape = RoundedCornerShape(12.dp),
                                    color = MaterialTheme.colorScheme.error.copy(alpha = 0.12f)) {
                                    Text("${svc.name} \u2715",
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.error)
                                }
                            }
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
