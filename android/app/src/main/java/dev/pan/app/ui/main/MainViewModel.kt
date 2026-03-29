package dev.pan.app.ui.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.pan.app.data.DataRepository
import dev.pan.app.network.PanServerApi
import dev.pan.app.network.PanServerClient
import dev.pan.app.network.dto.DeviceSensorConfig
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

    val isMicEnabled: StateFlow<Boolean> = PanForegroundService.micEnabled

    private val _deviceTarget = MutableStateFlow("auto")
    val deviceTarget: StateFlow<String> = _deviceTarget

    private val _deviceName = MutableStateFlow(android.os.Build.MODEL)
    val deviceName: StateFlow<String> = _deviceName

    private val _devices = MutableStateFlow<List<DeviceItem>>(emptyList())
    val devices: StateFlow<List<DeviceItem>> = _devices

    private val _sensors = MutableStateFlow<List<DeviceSensorConfig>>(emptyList())
    val sensors: StateFlow<List<DeviceSensorConfig>> = _sensors

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

        // Auto-connect Tailscale on startup — always on for security
        viewModelScope.launch {
            try {
                dev.pan.app.vpn.PanVpn.autoConnect(application)
                remoteAccessManager.refreshFromVpn()
            } catch (_: Exception) {}
        }

        viewModelScope.launch {
            dataRepository.getSetting("device_target")?.let { _deviceTarget.value = it }
            dataRepository.getSetting("device_name")?.let {
                _deviceName.value = it
                DeviceNameHolder.name = it
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
    }

    fun toggleMic() {
        val newState = !PanForegroundService.micEnabled.value
        PanForegroundService.micEnabled.value = newState
        sttEngine.enabled = newState
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
                        if (remoteAccessManager.status.value == "Connected") break
                        kotlinx.coroutines.delay(1000)
                    }
                    remoteAccessManager.refreshFromVpn()
                }
            } catch (e: Exception) {
                remoteAccessManager.setStatus("Failed: ${e.message}")
            }
        }
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
