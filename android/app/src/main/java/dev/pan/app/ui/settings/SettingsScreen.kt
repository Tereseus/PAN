package dev.pan.app.ui.settings

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.clickable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import kotlinx.coroutines.launch

/**
 * Settings opens on a short list of pages (0.5.18): it was one long scroll of ten sections.
 * What is on each page is in SettingsScreen below, in an `if (page == "...")` block per page.
 */
private data class SettingsPage(val key: String, val title: String, val about: String, val icon: ImageVector)

private val SETTINGS_PAGES = listOf(
    SettingsPage("connection", "This device", "Its name, and how it reaches ΠAN", Icons.Default.Phone),
    SettingsPage("voice", "Voice and sounds", "How ΠAN talks, where it reads reminders out, tones and vibration", Icons.Default.Notifications),
    SettingsPage("accessories", "Accessories", "Glasses, headphones, a watch", Icons.Default.Star),
    SettingsPage("privacy", "Privacy", "Incognito, the lock on Memory, what each device may use", Icons.Default.Lock),
    SettingsPage("about", "Updates and about", "This version, new versions, credits", Icons.Default.Info),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: (() -> Unit)? = null,            // null = shown as a tab (0.5.1), so no back arrow
    mainViewModel: dev.pan.app.ui.main.MainViewModel? = null,
    onOpenHub: () -> Unit = {},
    viewModel: SettingsViewModel = hiltViewModel()
) {
    val deviceName by viewModel.deviceName.collectAsState()
    val serverUrl by viewModel.serverUrl.collectAsState()
    val beepEnabled by viewModel.beepEnabled.collectAsState()
    val backchannelEnabled by viewModel.backchannelEnabled.collectAsState()
    val vibrationEnabled by viewModel.vibrationEnabled.collectAsState()
    val voiceResponseEnabled by viewModel.voiceResponseEnabled.collectAsState()
    val deviceTarget by viewModel.deviceTarget.collectAsState()
    val devices by viewModel.devices.collectAsState()
    val preferredMusicApp by viewModel.preferredMusicApp.collectAsState()
    val preferredMessagingApp by viewModel.preferredMessagingApp.collectAsState()
    val selectedLlmModel by viewModel.selectedLlmModel.collectAsState()
    val classifierModel by viewModel.classifierModel.collectAsState()
    val conversationModel by viewModel.conversationModel.collectAsState()
    val llmStatus by viewModel.llmStatus.collectAsState()
    val llmDownloadProgress by viewModel.llmDownloadProgress.collectAsState()
    val remoteAccessEnabled by viewModel.remoteAccessEnabled.collectAsState()
    val remoteAccessStatus by viewModel.remoteAccessStatus.collectAsState()
    val remoteAccessIp by viewModel.remoteAccessIp.collectAsState()
    val isServerConnected by viewModel.isServerConnected.collectAsState()
    val downloadingId by viewModel.downloadingId.collectAsState()
    val geminiKey by viewModel.geminiKey.collectAsState()
    val personality by viewModel.personality.collectAsState()
    val incognitoMode by viewModel.incognitoMode.collectAsState()
    val incognitoAllowed by viewModel.incognitoAllowed.collectAsState()
    val toastMessage by viewModel.toastMessage.collectAsState()
    val updateChecking by viewModel.updateChecking.collectAsState()
    val updateProgress by viewModel.updateProgress.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }
    // Developer options (About, at the bottom): the tools for building PAN stay out of a buyer's way.
    val uiPrefs = remember { context.getSharedPreferences("pan_ui", android.content.Context.MODE_PRIVATE) }
    var developerMode by remember { mutableStateOf(uiPrefs.getBoolean("developer", false)) }

    // Show toast messages from ViewModel
    LaunchedEffect(toastMessage) {
        toastMessage?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearToast()
        }
    }

    // VPN consent launcher
    val vpnLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            viewModel.enableRemoteAccess(true)
        }
    }

    // Which page is open: "" is the list of pages. Back goes to the list first.
    var page by rememberSaveable { mutableStateOf("") }
    val scroll = rememberScrollState()
    LaunchedEffect(page) { scroll.scrollTo(0) }
    BackHandler(enabled = page.isNotEmpty()) { page = "" }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text(SETTINGS_PAGES.firstOrNull { it.key == page }?.title ?: "Settings") },
                navigationIcon = {
                    if (page.isNotEmpty()) {
                        IconButton(onClick = { page = "" }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to Settings")
                        }
                    } else if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
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
                .verticalScroll(scroll),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // The first screen: one row per group. Each opens its own page, so nothing is a long scroll.
            if (page.isEmpty()) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    SETTINGS_PAGES.forEachIndexed { i, entry ->
                        if (i > 0) HorizontalDivider()
                        ListItem(
                            headlineContent = { Text(entry.title) },
                            supportingContent = { Text(entry.about) },
                            leadingContent = { Icon(entry.icon, contentDescription = null) },
                            trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
                            colors = ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
                            modifier = Modifier.clickable { page = entry.key }
                        )
                    }
                }
                Text("\u03A0AN " + dev.pan.app.BuildConfig.VERSION_NAME, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (page == "connection") {
            // Device
            Text("This device", style = MaterialTheme.typography.titleMedium)

            OutlinedTextField(
                value = deviceName,
                onValueChange = { viewModel.setDeviceName(it) },
                label = { Text("Device Name") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )
            Text("The name your other devices see",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)

            HorizontalDivider()

            // Connection: which way this phone reaches PAN right now, said first and plainly.
            Text("How it reaches ΠAN", style = MaterialTheme.typography.titleMedium)

            val link = viewModel.remoteAccessManager.link
            // The way in the app uses now (PAN Link's port while it works, else Tailscale's),
            // and PAN Link's own state, read off the main thread every 2 s.
            var conn by remember { mutableStateOf(ConnectionView()) }
            var confirmForget by remember { mutableStateOf(false) }
            LaunchedEffect(Unit) {
                while (true) {
                    conn = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                        val proxy = viewModel.getRemoteProxyUrl()
                        ConnectionView(
                            loaded = true,
                            proxyUrl = proxy,
                            viaLink = proxy != null && proxy == link.baseUrlIfConnected(),
                            linkSummary = link.summary(),
                            linkPaired = link.isPaired(),
                            linkWay = link.pathWords(),
                        )
                    }
                    kotlinx.coroutines.delay(2_000)
                }
            }
            val proxyUrl = conn.proxyUrl
            val linkPaired = conn.linkPaired
            Text(
                when {
                    !conn.loaded -> "Checking…"
                    conn.viaLink -> "Using ΠAN Link" + (conn.linkWay?.let { ", $it" } ?: "")
                    proxyUrl != null && linkPaired -> "Using the backup route: ΠAN Link isn't reaching your computer"
                    proxyUrl != null -> "Using the backup route"
                    else -> "Not connected to ΠAN yet, connecting…"
                },
                style = MaterialTheme.typography.bodyLarge,
                color = if (proxyUrl != null || !conn.loaded) MaterialTheme.colorScheme.primary
                       else MaterialTheme.colorScheme.error
            )
            if (developerMode) {
                OutlinedTextField(
                    value = proxyUrl ?: serverUrl.ifEmpty { "Not found yet" },
                    onValueChange = { },
                    label = { Text("ΠAN Server") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    readOnly = true
                )
            }

            Text("ΠAN Link", style = MaterialTheme.typography.titleSmall)
            Text(conn.linkSummary,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = {
                    context.startActivity(android.content.Intent(context, dev.pan.app.vpn.ScanPairActivity::class.java))
                }) { Text("Scan a pairing code") }
                if (linkPaired) {
                    TextButton(onClick = { confirmForget = true }) { Text("Forget this pairing") }
                } else {
                    // A phone that already reaches PAN (over Tailscale) gets a code from PAN itself.
                    var pairing by remember { mutableStateOf(false) }
                    TextButton(
                        enabled = proxyUrl != null && !pairing,
                        onClick = {
                            val base = proxyUrl ?: return@TextButton
                            pairing = true
                            scope.launch {
                                val r = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                    runCatching { link.pairThroughPan(base) }
                                }
                                pairing = false
                                snackbarHostState.showSnackbar(r.fold(
                                    { "Paired. This phone uses ΠAN Link now." },
                                    { "Pairing failed: ${it.message}" }))
                            }
                        }
                    ) { Text(if (pairing) "Pairing…" else "Pair this phone") }
                }
            }
            if (confirmForget) {
                AlertDialog(
                    onDismissRequest = { confirmForget = false },
                    title = { Text("Forget the pairing?") },
                    text = { Text("This phone stops using ΠAN Link and goes back to the backup route. To use the link again, scan a new pairing code, or tap Pair this phone.") },
                    confirmButton = {
                        TextButton(onClick = {
                            confirmForget = false
                            scope.launch(kotlinx.coroutines.Dispatchers.IO) { link.forget() }
                        }) { Text("Forget") }
                    },
                    dismissButton = { TextButton(onClick = { confirmForget = false }) { Text("Cancel") } },
                )
            }

            // Tailscale stays on underneath: the fallback, and PAN Link's way in from outside.
            // Behind Advanced, closed: people never have to see or sign in to it (the owner, Nov 15).
            // The hub hands the phone a key through PAN Link, so it joins by itself.
            if (developerMode) {
            Text("Tailscale (backup)", style = MaterialTheme.typography.titleSmall)
            Text(
                if (remoteAccessEnabled && remoteAccessStatus == "Connected")
                    "Connected${if (remoteAccessIp.isNotEmpty()) ", $remoteAccessIp" else ""}"
                else if (remoteAccessEnabled)
                    remoteAccessStatus
                else
                    "Connecting...",
                style = MaterialTheme.typography.bodySmall,
                color = if (remoteAccessStatus == "Connected") MaterialTheme.colorScheme.primary
                       else MaterialTheme.colorScheme.onSurfaceVariant
            )
            Text("Stays on as a backup. The app uses it when ΠAN Link can't reach your computer, and away from home ΠAN Link travels through it.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            TailscaleSignIn(snackbarHostState)
            }
            }
            if (page == "voice") {
            // Personality (PAN voice/character — empty = default/off)
            Text("Personality", style = MaterialTheme.typography.titleMedium)
            Text(
                "Describe how ΠAN should talk. Leave it empty for the usual ΠAN.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            var personalityInput by remember(personality) { mutableStateOf(personality) }
            OutlinedTextField(
                value = personalityInput,
                onValueChange = { personalityInput = it },
                label = { Text("How ΠAN talks") },
                placeholder = { Text("e.g. Sarcastic, witty, like Tony Stark") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 2,
                maxLines = 5
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                if (personalityInput != personality) {
                    Button(
                        onClick = { viewModel.setPersonality(personalityInput) },
                        modifier = Modifier.weight(1f)
                    ) { Text("Save") }
                }
                if (personality.isNotEmpty() || personalityInput.isNotEmpty()) {
                    OutlinedButton(
                        onClick = {
                            personalityInput = ""
                            viewModel.clearPersonality()
                        },
                        modifier = Modifier.weight(1f)
                    ) { Text("Turn Off") }
                }
            }

            HorizontalDivider()

            // It draws its own line under itself, and nothing at all on a person's device.
            NotesDeviceSection(viewModel, snackbarHostState)

            // Sounds
            Text("Sounds", style = MaterialTheme.typography.titleMedium)

            // Voice picker: developers only. Buyers get one voice.
            if (developerMode) {
            var voiceExpanded by remember { mutableStateOf(false) }
            var currentVoice by remember { mutableStateOf(
                context.getSharedPreferences("pan_tts_prefs", android.content.Context.MODE_PRIVATE)
                    .getString("voice_quality", "android") ?: "android"
            ) }
            var voiceStatus by remember { mutableStateOf("") }
            val voiceOptions = listOf(
                "android" to "Default (Android)",
                "supertonic" to "Supertonic Fast (81MB)",
                "supertonic3" to "Supertonic 3 Clear (129MB)"
            )
            ExposedDropdownMenuBox(
                expanded = voiceExpanded,
                onExpandedChange = { voiceExpanded = it }
            ) {
                OutlinedTextField(
                    value = voiceOptions.firstOrNull { it.first == currentVoice }?.second ?: "Default",
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("Voice Quality") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = voiceExpanded) },
                    modifier = Modifier.menuAnchor().fillMaxWidth()
                )
                ExposedDropdownMenu(
                    expanded = voiceExpanded,
                    onDismissRequest = { voiceExpanded = false }
                ) {
                    voiceOptions.forEach { (id, label) ->
                        DropdownMenuItem(
                            text = { Text(label) },
                            onClick = {
                                currentVoice = id
                                voiceExpanded = false
                                context.getSharedPreferences("pan_tts_prefs", android.content.Context.MODE_PRIVATE)
                                    .edit().putString("voice_quality", id)
                                    // Chosen here by hand: the service leaves an Android voice picked on purpose alone.
                                    .putBoolean("voice_picked", true).apply()
                                if (id != "android") {
                                    voiceStatus = "Downloading..."
                                    scope.launch {
                                        val piper = dev.pan.app.tts.PiperTtsEngine(context)
                                        if (!piper.isFullyReady(id)) {
                                            val ok = piper.downloadVoice(id)
                                            voiceStatus = if (ok) "Ready — restart app to activate" else "Download failed"
                                        } else {
                                            voiceStatus = "Ready — restart app to activate"
                                        }
                                    }
                                } else {
                                    voiceStatus = ""
                                }
                            }
                        )
                    }
                }
            }
            if (voiceStatus.isNotEmpty()) {
                Text(voiceStatus, style = MaterialTheme.typography.bodySmall,
                    color = if (voiceStatus.contains("Ready")) MaterialTheme.colorScheme.primary
                           else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            }

            SettingToggle(
                title = "Sound Effects",
                description = "A tone when ΠAN hears a command",
                checked = beepEnabled,
                onToggle = { viewModel.setBeep(it) }
            )

            SettingToggle(
                title = "Vibration",
                description = "A short buzz when ΠAN starts listening or something fails",
                checked = vibrationEnabled,
                onToggle = { viewModel.setVibration(it) }
            )
            }
            if (page == "accessories") {
            AccessoriesSection(viewModel.accessoryHub)
            }
            if (page == "privacy") {
            // Privacy
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "Incognito",
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (incognitoAllowed) MaterialTheme.colorScheme.onSurface
                                else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        when {
                            !incognitoAllowed -> "Turned off by your organization."
                            incognitoMode -> "On. What this phone sends is kept apart and erased when you turn this off."
                            else -> "Keeps what this phone sends apart from your memory, and erases it when you turn it off."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Switch(
                    checked = incognitoMode,
                    onCheckedChange = { viewModel.setIncognitoMode(it) },
                    enabled = incognitoAllowed
                )
            }
            // The lock on the Memory tab. Turning it off takes the fingerprint too.
            var memoryLock by remember { mutableStateOf(dev.pan.app.ui.memory.Fingerprint.lockOn(context)) }
            val hasFingerprint = remember { dev.pan.app.ui.memory.Fingerprint.ready(context) }
            val pinAllowed = remember { dev.pan.app.ui.memory.Pin.allowed(context) }
            SettingToggle(
                title = "Lock Memory",
                description = if (hasFingerprint) "Memory opens only with your fingerprint, and deleting asks for it again"
                              else if (pinAllowed) "This device has no fingerprint, so Memory opens with a PIN you set in ΠAN, and deleting asks for it again"
                              else "Memory opens only with a fingerprint. This device has none, so Memory stays closed here",
                checked = memoryLock,
                onToggle = { on ->
                    if (on) { memoryLock = true; dev.pan.app.ui.memory.Fingerprint.setLock(context, true) }
                    else if (hasFingerprint || pinAllowed) dev.pan.app.ui.memory.Fingerprint.ask(context, "Turn off the Memory lock", "Your fingerprint confirms it") { ok ->
                        if (ok) { memoryLock = false; dev.pan.app.ui.memory.Fingerprint.setLock(context, false) }
                    }
                }
            )
            if (!hasFingerprint && pinAllowed) {
                Text("Change the Memory PIN", style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.fillMaxWidth().then(Modifier.clickable { dev.pan.app.ui.memory.Pin.change(context) { } }).padding(vertical = 12.dp))
            }
            if (mainViewModel != null) {
                val allDevices by mainViewModel.devices.collectAsState()
                val micOn by mainViewModel.isMicEnabled.collectAsState()
                dev.pan.app.ui.main.SensorSection(
                    devices = allDevices,
                    isMicEnabled = micOn,
                    onToggleMic = { mainViewModel.toggleMic() },
                    viewModel = mainViewModel
                )
            }
            // The data dividend row comes back here when there is something to turn on (the owner, 2026-11-18).
            }
            if (page == "about") {
            // App Updates — manual OTA pull. The app auto-checks ~8s after
            // launch; this button lets the user pull the update immediately.
            Text("App Updates", style = MaterialTheme.typography.titleMedium)
            Text(
                "Version ${dev.pan.app.BuildConfig.VERSION_NAME} (${dev.pan.app.BuildConfig.VERSION_CODE})",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Button(
                onClick = { viewModel.checkForUpdate() },
                enabled = !updateChecking,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(if (updateChecking) (if (updateProgress != null) "Downloading…" else "Checking…") else "Check for updates")
            }
            updateProgress?.let { p ->
                LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth())
                val total = viewModel.updateTotalMb()
                Text("${(p * total).toLong()} of $total MB",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(
                "Gets the newest app from your computer. If there is one, Android asks to install it.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            HorizontalDivider()

            Text("About", style = MaterialTheme.typography.titleMedium)
            Text("\u03A0AN " + dev.pan.app.BuildConfig.VERSION_NAME, style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Credits()
            SettingToggle(
                title = "Developer options",
                description = "Tools for building PAN: server address, backup route, voice picker, service controls",
                checked = developerMode,
                onToggle = { developerMode = it; uiPrefs.edit().putBoolean("developer", it).apply() }
            )
            if (developerMode) {
                OutlinedButton(onClick = onOpenHub, modifier = Modifier.fillMaxWidth()) { Text("Hub") }
                Text("What is running on your hub, and what ΠAN reads about you right now.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            HorizontalDivider()

            if (developerMode) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedButton(
                    onClick = { viewModel.stopPanService() },
                    modifier = Modifier.weight(1f)
                ) { Text("Stop ΠAN Service") }
                Button(
                    onClick = { viewModel.forceRestartApp() },
                    modifier = Modifier.weight(1f)
                ) { Text("Force Restart") }
            }
            Text(
                "Stop = kills the foreground service (voice triggers, log shipping). " +
                "Force Restart = stop service, kill process, cold-start the app.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
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

/**
 * Glasses, headphones, watch, Medallion, other: what is connected in each slot, and which one
 * PAN listens and speaks through (AccessoryHub has the why).
 */
@Composable
private fun AccessoriesSection(hub: dev.pan.app.accessory.AccessoryHub) {
    LaunchedEffect(Unit) { hub.start(); hub.refresh() }
    val all by hub.accessories.collectAsState()
    val chosen by hub.micKey.collectAsState()
    val routed by hub.routed.collectAsState()

    Text("Accessories", style = MaterialTheme.typography.titleMedium)
    Text("Glasses, headphones and earbuds that work with Android work with ΠAN. Pick one to talk to ΠAN through it.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant)

    dev.pan.app.accessory.AccessoryHub.Slot.entries.forEach { slot ->
        val inSlot = all.filter { it.slot == slot }
        Text(slot.label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 4.dp))
        if (inSlot.isEmpty()) {
            Text(when (slot) {
                    dev.pan.app.accessory.AccessoryHub.Slot.GLASSES -> "None connected. Android XR glasses pair in Bluetooth settings."
                    dev.pan.app.accessory.AccessoryHub.Slot.WATCH -> "None paired."
                    dev.pan.app.accessory.AccessoryHub.Slot.MEDALLION -> "Not connected."
                    dev.pan.app.accessory.AccessoryHub.Slot.CAR -> "None connected. When the phone joins a car's Bluetooth, ΠAN talks through the car and listens on the phone."
                    else -> "None connected."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        inSlot.forEach { a ->
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(a.name, style = MaterialTheme.typography.bodyMedium)
                    val parts = listOfNotNull(a.how, "mic".takeIf { a.mic }, "speaker".takeIf { a.speaker },
                        "ΠAN is using it".takeIf { routed == a.key })
                    Text(parts.joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                // The Medallion has its own link; only call audio devices can be picked here.
                if (a.mic && a.connected && a.slot != dev.pan.app.accessory.AccessoryHub.Slot.MEDALLION) {
                    Switch(checked = chosen == a.key, onCheckedChange = { on -> hub.useForVoice(if (on) a.key else null) })
                }
            }
        }
    }
    if (chosen != null && routed == null) {
        Text("The one you picked is not connected. ΠAN is using the phone until it comes back.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** What the Connection section shows, read together off the main thread. */
private data class ConnectionView(
    val loaded: Boolean = false,
    val proxyUrl: String? = null,
    val viaLink: Boolean = false,
    val linkSummary: String = "",
    val linkPaired: Boolean = false,
    val linkWay: String? = null,
)


/**
 * Tailscale sign-in, shown only while the app's own Tailscale needs it.
 *
 * Before Nov 14 a never-signed-in device only said "Connecting...": the sign-in link went to
 * logcat, and the browser it tried to open does not exist on a car head unit. Now the link is
 * a button and a QR code (sign in on your phone), and a device waiting for the tailnet admin's
 * approval says so instead of looking stuck.
 */
@Composable
private fun TailscaleSignIn(snackbarHostState: SnackbarHostState) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var st by remember { mutableStateOf(dev.pan.app.vpn.PanVpn.VpnStatus(connected = false)) }
    LaunchedEffect(Unit) {
        while (true) {
            st = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                if (dev.pan.app.vpn.PanVpn.isRunning()) dev.pan.app.vpn.PanVpn.getStatus()
                else dev.pan.app.vpn.PanVpn.VpnStatus(connected = false)
            }
            kotlinx.coroutines.delay(2_000)
        }
    }
    when {
        st.authUrl.isNotEmpty() -> {
            Text("Sign in to Tailscale so this device can reach ΠAN away from your home network.",
                style = MaterialTheme.typography.bodyMedium)
            Button(onClick = {
                if (!dev.pan.app.vpn.PanVpn.openLoginUrl(context, st.authUrl)) scope.launch {
                    snackbarHostState.showSnackbar("No browser here. Scan the code below with your phone.")
                }
            }) { Text("Sign in to Tailscale") }
            val qr = remember(st.authUrl) { qrBitmap(st.authUrl, 512) }
            if (qr != null) {
                Text("Or scan this with your phone's camera and sign in there:",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                androidx.compose.foundation.Image(
                    bitmap = qr.asImageBitmap(),
                    contentDescription = "Tailscale sign-in code",
                    modifier = Modifier.size(200.dp),
                )
            }
        }
        st.waitingForApproval -> {
            Text("Signed in. Waiting for approval: open login.tailscale.com/admin/machines on any computer and approve this device. It connects by itself after that.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error)
        }
    }
}

internal fun qrBitmap(text: String, size: Int): android.graphics.Bitmap? = try {
    val m = com.google.zxing.qrcode.QRCodeWriter()
        .encode(text, com.google.zxing.BarcodeFormat.QR_CODE, size, size)
    val px = IntArray(size * size) { i ->
        if (m.get(i % size, i / size)) android.graphics.Color.BLACK else android.graphics.Color.WHITE
    }
    android.graphics.Bitmap.createBitmap(px, size, size, android.graphics.Bitmap.Config.ARGB_8888)
} catch (_: Exception) { null }
