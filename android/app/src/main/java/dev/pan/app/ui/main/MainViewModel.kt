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
    private val api: PanServerApi
) : ViewModel() {

    val isServerConnected: StateFlow<Boolean> = serverClient.isConnected
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

    init {
        PanForegroundService.micEnabled.value = sttEngine.enabled

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
                refreshDevices()
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

    /** Apply server sensor states to actual phone hardware on load */
    private fun syncHardwareToServerState(sensors: List<DeviceSensorConfig>) {
        for (s in sensors) {
            val enabled = s.enabled
            when (s.id) {
                "microphone" -> {
                    PanForegroundService.micEnabled.value = enabled
                    sttEngine.enabled = enabled
                }
                // All sensors including camera go through SensorContext
                // These toggles control what PAN is allowed to use, not device hardware
                else -> sensorContext.setSensorEnabled(s.id, enabled)
            }
        }
    }

    fun toggleSensorEnabled(deviceId: Int, sensorId: String, enabled: Boolean) {
        // Control what PAN is allowed to use (not the device hardware)
        when (sensorId) {
            "microphone" -> {
                PanForegroundService.micEnabled.value = enabled
                sttEngine.enabled = enabled
            }
            // All other sensors including camera go through SensorContext
            else -> sensorContext.setSensorEnabled(sensorId, enabled)
        }

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
}
