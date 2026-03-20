package dev.pan.app.ui.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.pan.app.data.DataRepository
import dev.pan.app.network.PanServerApi
import dev.pan.app.network.PanServerClient
import dev.pan.app.service.PanForegroundService
import dev.pan.app.stt.GoogleStreamingStt
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
    private val api: PanServerApi
) : ViewModel() {

    val isServerConnected: StateFlow<Boolean> = serverClient.isConnected
    val lastAction: StateFlow<String> = PanForegroundService.lastAction

    val isMicEnabled: StateFlow<Boolean> = PanForegroundService.micEnabled

    private val _deviceTarget = MutableStateFlow("auto")
    val deviceTarget: StateFlow<String> = _deviceTarget

    private val _devices = MutableStateFlow<List<DeviceItem>>(emptyList())
    val devices: StateFlow<List<DeviceItem>> = _devices

    val pendingCount: StateFlow<Int> = dataRepository.pendingCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(), 0)

    init {
        PanForegroundService.micEnabled.value = sttEngine.enabled

        viewModelScope.launch {
            dataRepository.getSetting("device_target")?.let { _deviceTarget.value = it }
        }

        viewModelScope.launch {
            while (true) {
                serverClient.checkHealth()
                refreshDevices()
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
            if (res.isSuccessful) _devices.value = res.body() ?: emptyList()
        } catch (_: Exception) {}
    }
}
