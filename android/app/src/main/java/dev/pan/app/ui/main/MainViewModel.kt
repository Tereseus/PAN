package dev.pan.app.ui.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.pan.app.data.DataRepository
import dev.pan.app.network.PanServerApi
import dev.pan.app.network.PanServerClient
import dev.pan.app.network.dto.DeviceSensorConfig
import dev.pan.app.network.dto.IntuitionSnapshot
import dev.pan.app.network.dto.SensorAttachRequest
import dev.pan.app.network.dto.SensorUpdateRequest
import dev.pan.app.sensor.SensorContext
import dev.pan.app.service.PanForegroundService
import dev.pan.app.stt.GoogleStreamingStt
import dev.pan.app.di.DeviceNameHolder
import dev.pan.app.ui.commands.DeviceItem
import dev.pan.app.vpn.RemoteAccessManager
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class MainViewModel @Inject constructor(
    private val serverClient: PanServerClient,
    private val dataRepository: DataRepository,
    private val sttEngine: GoogleStreamingStt,
    private val sensorContext: SensorContext,
    private val api: PanServerApi,
    private val remoteAccessManager: RemoteAccessManager,
    private val application: android.app.Application
) : ViewModel() {

    val isServerConnected: StateFlow<Boolean> = serverClient.isConnected

    // Remote access state from RemoteAccessManager
    val remoteAccessEnabled: StateFlow<Boolean> = remoteAccessManager.enabled
    val remoteAccessStatus: StateFlow<String> = remoteAccessManager.status
    val remoteAccessIp: StateFlow<String> = remoteAccessManager.ip
    val remoteAccessOrg: StateFlow<String> = remoteAccessManager.org
    val lastAction: StateFlow<String> = PanForegroundService.lastAction
    val sttStatus: StateFlow<String> = PanForegroundService.sttStatus

    val isMicEnabled: StateFlow<Boolean> = PanForegroundService.micEnabled

    private val _deviceTarget = MutableStateFlow("auto")
    val deviceTarget: StateFlow<String> = _deviceTarget

    private val _deviceName = MutableStateFlow(android.os.Build.MODEL)
    val deviceName: StateFlow<String> = _deviceName

    // Tier 0: identity for the top bar — display nickname + active org name.
    // Defaults to "Personal" so the bar renders something sane before the
    // /me request returns.
    private val _displayNickname = MutableStateFlow("")
    val displayNickname: StateFlow<String> = _displayNickname
    private val _activeOrgName = MutableStateFlow("Personal")
    val activeOrgName: StateFlow<String> = _activeOrgName
    private val _activeOrgSlug = MutableStateFlow("personal")
    val activeOrgSlug: StateFlow<String> = _activeOrgSlug

    private val _devices = MutableStateFlow<List<DeviceItem>>(emptyList())
    val devices: StateFlow<List<DeviceItem>> = _devices

    private val _sensors = MutableStateFlow<List<DeviceSensorConfig>>(emptyList())
    val sensors: StateFlow<List<DeviceSensorConfig>> = _sensors

    // Intuition — live situational awareness from the server
    private val _intuition = MutableStateFlow<IntuitionSnapshot?>(null)
    val intuition: StateFlow<IntuitionSnapshot?> = _intuition

    private val _sensorsLoading = MutableStateFlow(false)
    val sensorsLoading: StateFlow<Boolean> = _sensorsLoading

    // Track which device the sensor UI is showing, so background poll knows what to fetch
    private var activeSensorDeviceId: Int? = null

    val pendingCount: StateFlow<Int> = dataRepository.pendingCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(), 0)

    // Track connection state for reconnection logic
    private var wasConnected = false

    init {
        // Don't reset micEnabled on init — it persists across navigation

        // Tailscale auto-connect is triggered by LaunchedEffect in MainScreen
        // (needs Activity context for VPN consent dialog)

        viewModelScope.launch {
            dataRepository.getSetting("device_target")?.let { _deviceTarget.value = it }
            dataRepository.getSetting("device_name")?.let {
                _deviceName.value = it
                DeviceNameHolder.name = it
            }
        }

        // Tier 0: fetch identity for the top bar. Polls periodically so org
        // switching on the server is reflected without an app restart.
        viewModelScope.launch {
            while (true) {
                try {
                    val res = api.getMe()
                    if (res.isSuccessful) {
                        val me = res.body()
                        if (me != null) {
                            _displayNickname.value = me.display_nickname ?: me.display_name
                            me.org?.let { o ->
                                _activeOrgName.value = o.name
                                _activeOrgSlug.value = o.slug
                            }
                        }
                    }
                } catch (_: Exception) {}
                delay(60000) // refresh every 60s
            }
        }

        viewModelScope.launch {
            while (true) {
                serverClient.checkHealth()
                val nowConnected = serverClient.isConnected.value
                // Reconnection: when transitioning false -> true, reload everything
                if (nowConnected && !wasConnected) {
                    refreshDevices()
                    val devId = activeSensorDeviceId
                    if (devId != null) loadSensorsForDevice(devId)
                } else {
                    refreshDevices()
                }
                wasConnected = nowConnected
                delay(10000)
            }
        }

        // Poll sensor state from server every 10s so dashboard changes sync to phone
        viewModelScope.launch {
            delay(5000) // offset from health poll
            while (true) {
                pollSensorState()
                delay(10000)
            }
        }

        // Poll intuition snapshot every 10s
        viewModelScope.launch {
            delay(2000) // let server connect first
            while (true) {
                pollIntuition()
                delay(10000)
            }
        }
    }

    fun toggleMic() {
        // Mute is a bulk-sensor toggle: muting snapshots all currently-enabled
        // sensors and disables them; unmuting restores from the snapshot.
        // The snapshot is stored per phone device in SharedPreferences so each
        // phone remembers its own previous state independently.
        val wasEnabled = PanForegroundService.micEnabled.value
        if (wasEnabled) {
            snapshotAndDisableAllSensors()
        } else {
            restoreSensorSnapshot()
        }

        // Existing behavior: tell the foreground service to flip the mic.
        // Send TOGGLE_MIC intent — it handles STT start/stop, notification
        // update, and callback setup.
        val intent = android.content.Intent(application, PanForegroundService::class.java).apply {
            action = "TOGGLE_MIC"
        }
        application.startService(intent)
    }

    /**
     * Snapshot all currently-enabled sensors for this device into SharedPreferences,
     * then disable them all on the server. Per-device key so each phone has its
     * own snapshot.
     */
    private fun snapshotAndDisableAllSensors() {
        val deviceId = activeSensorDeviceId ?: return
        val currentSensors = _sensors.value
        if (currentSensors.isEmpty()) return

        // TODO(tier0-phase7): once geofencing/zones land, skip sensors where
        // forced_by_org = 1 — orgs may require certain sensors (e.g. GPS in
        // an airport sterile zone) to stay on regardless of user mute. The
        // sensor_toggles.forced_by_org column already exists in the schema
        // but is unused until Phase 7 wires zones + polygon-in-point + UI.
        // When that lands: filter currentSensors to non-forced before snapshot,
        // and don't try to re-enable forced sensors on restore (they were never off).
        val snapshot = currentSensors.associate { it.id to it.enabled }
        val json = org.json.JSONObject(snapshot as Map<*, *>).toString()
        val prefs = application.getSharedPreferences("pan_sensor_cache", android.content.Context.MODE_PRIVATE)
        prefs.edit().putString("snapshot_$deviceId", json).apply()

        viewModelScope.launch {
            for (sensor in currentSensors) {
                if (sensor.enabled) {
                    try {
                        api.updateSensor(deviceId, sensor.id, SensorUpdateRequest(enabled = false))
                        sensorContext.setSensorEnabled(sensor.id, false)
                    } catch (_: Exception) {}
                }
            }
            _sensors.value = _sensors.value.map { it.copy(enabled = false) }
        }
    }

    /**
     * Restore the previously-snapshotted sensor states for this device.
     * If no snapshot exists (e.g. first launch, or app was killed while muted
     * after we cleared the snapshot), this is a no-op.
     */
    private fun restoreSensorSnapshot() {
        val deviceId = activeSensorDeviceId ?: return
        val prefs = application.getSharedPreferences("pan_sensor_cache", android.content.Context.MODE_PRIVATE)
        val json = prefs.getString("snapshot_$deviceId", null) ?: return

        val snapshot: Map<String, Boolean> = try {
            val obj = org.json.JSONObject(json)
            buildMap {
                val it = obj.keys()
                while (it.hasNext()) {
                    val k = it.next()
                    put(k, obj.getBoolean(k))
                }
            }
        } catch (_: Exception) { return }

        viewModelScope.launch {
            for ((sensorId, enabled) in snapshot) {
                if (enabled) {
                    try {
                        api.updateSensor(deviceId, sensorId, SensorUpdateRequest(enabled = true))
                        sensorContext.setSensorEnabled(sensorId, true)
                    } catch (_: Exception) {}
                }
            }
            _sensors.value = _sensors.value.map { s ->
                s.copy(enabled = snapshot[s.id] ?: s.enabled)
            }
        }

        // Clear the snapshot — we've consumed it.
        prefs.edit().remove("snapshot_$deviceId").apply()
    }

    fun setDeviceTarget(target: String) {
        _deviceTarget.value = target
        viewModelScope.launch { dataRepository.setSetting("device_target", target) }
    }

    private suspend fun refreshDevices() {
        try {
            val res = api.deviceList()
            if (res.isSuccessful) {
                val devices = res.body() ?: emptyList()
                _devices.value = devices
                // Auto-detect this phone's device ID for sensor polling
                if (activeSensorDeviceId == null) {
                    val phone = devices.find { it.device_type == "phone" }
                    if (phone != null) {
                        activeSensorDeviceId = phone.id
                    }
                }
            }
        } catch (_: Exception) {}
    }

    fun loadSensorsForDevice(deviceId: Int) {
        activeSensorDeviceId = deviceId
        viewModelScope.launch {
            _sensorsLoading.value = true
            try {
                val res = api.getDeviceSensors(deviceId)
                if (res.isSuccessful) {
                    val sensors = res.body()?.sensors ?: emptyList()
                    _sensors.value = sensors
                    // Sync actual hardware state with server state
                    syncHardwareToServerState(sensors)
                }
            } catch (_: Exception) {}
            _sensorsLoading.value = false
        }
    }

    /** Background poll: fetch sensor state from server and apply to hardware */
    private suspend fun pollSensorState() {
        val deviceId = activeSensorDeviceId ?: return
        try {
            val res = api.getDeviceSensors(deviceId)
            if (res.isSuccessful) {
                val sensors = res.body()?.sensors ?: emptyList()
                // Only sync if state actually changed (avoid re-triggering STT etc.)
                val oldStates = _sensors.value.associate { it.id to it.enabled }
                val newStates = sensors.associate { it.id to it.enabled }
                if (oldStates != newStates) {
                    _sensors.value = sensors
                    syncHardwareToServerState(sensors)
                }
            }
        } catch (_: Exception) {}
    }

    /** Apply server sensor states to SensorContext (permissions, not hardware control).
     *  NEVER affects Quick Mute — that's a local phone-only control. */
    private fun syncHardwareToServerState(sensors: List<DeviceSensorConfig>) {
        for (s in sensors) {
            // Microphone sensor toggle = PAN permission, NOT Quick Mute
            // Quick Mute is controlled ONLY by the user tapping the toggle on the phone
            sensorContext.setSensorEnabled(s.id, s.enabled)
        }
    }

    fun toggleSensorEnabled(deviceId: Int, sensorId: String, enabled: Boolean) {
        // Sensor toggles control what PAN is ALLOWED to use (permissions)
        // They do NOT control Quick Mute — that's phone-only
        sensorContext.setSensorEnabled(sensorId, enabled)

        // Update local UI state immediately (no flicker)
        _sensors.value = _sensors.value.map { s ->
            if (s.id == sensorId) s.copy(enabled = enabled) else s
        }

        // Persist to server DB — do NOT call loadSensorsForDevice here
        // because syncHardwareToServerState would re-trigger sttEngine.enabled
        // while the recognizer is still starting, causing a double-start race condition
        viewModelScope.launch {
            try {
                api.updateSensor(deviceId, sensorId, SensorUpdateRequest(enabled = enabled))
            } catch (_: Exception) {}
        }
    }

    fun toggleSensorAttachment(deviceId: Int, sensorId: String, attachTo: String, enabled: Boolean) {
        viewModelScope.launch {
            try {
                api.updateSensorAttachment(deviceId, sensorId, attachTo, SensorAttachRequest(enabled = enabled))
                // Update locally without full reload for snappy feel
                _sensors.value = _sensors.value.map { s ->
                    if (s.id == sensorId) s.copy(attachments = s.attachments + (attachTo to enabled))
                    else s
                }
            } catch (_: Exception) {}
        }
    }

    fun connectTailscale() {
        viewModelScope.launch {
            // If already connected with working proxy that can reach server, skip
            if (dev.pan.app.vpn.PanVpn.isRunning() && remoteAccessManager.proxyPort.value > 0) {
                // Verify proxy actually works by checking if API calls succeed
                remoteAccessManager.refreshFromVpn()
                if (remoteAccessManager.status.value == "Connected") {
                    android.util.Log.d("PAN-VPN", "Already connected, proxy=${remoteAccessManager.proxyPort.value}")
                    return@launch
                }
                // Proxy exists but not working — stop and restart
                android.util.Log.d("PAN-VPN", "Proxy exists but not connected, restarting...")
                try { dev.pan.app.vpn.PanVpn.disconnect(application) } catch (_: Exception) {}
                kotlinx.coroutines.delay(1000)
            }
            // Delay to let audio/foreground service initialize first
            kotlinx.coroutines.delay(3000)
            remoteAccessManager.setEnabled(true)
            remoteAccessManager.setStatus("Connecting...")
            try {
                // Try auto-auth from server first
                try {
                    val deviceName = android.os.Build.MODEL
                    val resp = api.getTailscaleAuthKey(mapOf("device_name" to deviceName, "device_id" to deviceName.lowercase().replace(" ", "-")))
                    if (resp.isSuccessful) {
                        val key = resp.body()?.get("auth_key")?.toString()
                        if (!key.isNullOrBlank() && key != "null") {
                            dev.pan.app.vpn.PanVpn.setAuthKey(application, key)
                        }
                    }
                } catch (_: Exception) {}

                val loginUrl = dev.pan.app.vpn.PanVpn.connect(application)
                if (loginUrl != null) {
                    dev.pan.app.vpn.PanVpn.openLoginUrl(application, loginUrl)
                    for (i in 0 until 60) {
                        kotlinx.coroutines.delay(2000)
                        remoteAccessManager.refreshFromVpn()
                        if (remoteAccessManager.status.value == "Connected") break
                    }
                } else {
                    for (i in 0 until 15) {
                        remoteAccessManager.refreshFromVpn()
                        val port = try { panvpn.Panvpn.getProxyPort().toInt() } catch (_: Exception) { 0 }
                        android.util.Log.d("PAN-VPN", "Poll $i: status=${remoteAccessManager.status.value} proxy=$port")
                        if (remoteAccessManager.status.value == "Connected" && port > 0) break
                        kotlinx.coroutines.delay(1000)
                    }
                    remoteAccessManager.refreshFromVpn()
                    val finalPort = try { panvpn.Panvpn.getProxyPort().toInt() } catch (_: Exception) { 0 }
                    android.util.Log.d("PAN-VPN", "Final: status=${remoteAccessManager.status.value} proxy=$finalPort shouldUse=${remoteAccessManager.shouldUseTailscale}")
                }
            } catch (e: Exception) {
                android.util.Log.e("PAN-VPN", "connectTailscale failed: ${e.message}")
                remoteAccessManager.setStatus("Failed: ${e.message}")
            }
        }
    }

    private suspend fun pollIntuition() {
        try {
            val res = api.getIntuitionCurrent()
            if (res.isSuccessful) {
                _intuition.value = res.body()?.snapshot
            }
        } catch (_: Exception) {}
    }

    fun toggleRemoteAccess(context: android.content.Context, enabled: Boolean) {
        viewModelScope.launch {
            if (enabled) {
                remoteAccessManager.setEnabled(true)
                remoteAccessManager.setStatus("Connecting...")
                try {
                    val loginUrl = dev.pan.app.vpn.PanVpn.connect(context)
                    if (loginUrl != null) {
                        dev.pan.app.vpn.PanVpn.openLoginUrl(context, loginUrl)
                    }
                    remoteAccessManager.refreshFromVpn()
                } catch (e: Exception) {
                    remoteAccessManager.setStatus("Failed: ${e.message}")
                }
            } else {
                dev.pan.app.vpn.PanVpn.disconnect(context)
                remoteAccessManager.setEnabled(false)
            }
        }
    }
}
