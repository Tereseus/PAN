package dev.pan.app.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.pan.app.data.DataRepository
import dev.pan.app.network.PanServerApi
import dev.pan.app.network.PanServerClient
import dev.pan.app.ui.commands.DeviceItem
import dev.pan.app.util.Constants
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val dataRepository: DataRepository,
    private val api: PanServerApi,
    private val serverClient: PanServerClient
) : ViewModel() {

    private val _serverUrl = MutableStateFlow(Constants.DEFAULT_SERVER_URL)
    val serverUrl: StateFlow<String> = _serverUrl

    private val _triggerWord = MutableStateFlow("hey pan")
    val triggerWord: StateFlow<String> = _triggerWord

    private val _beepEnabled = MutableStateFlow(true)
    val beepEnabled: StateFlow<Boolean> = _beepEnabled

    private val _vibrationEnabled = MutableStateFlow(true)
    val vibrationEnabled: StateFlow<Boolean> = _vibrationEnabled

    private val _voiceResponseEnabled = MutableStateFlow(true)
    val voiceResponseEnabled: StateFlow<Boolean> = _voiceResponseEnabled

    // Device target: "auto", "phone:<this>", or a device hostname
    // auto = nearest connected device (server connected → PC, otherwise phone)
    // phone = always handle locally
    // <hostname> = send to that specific device
    private val _deviceTarget = MutableStateFlow("auto")
    val deviceTarget: StateFlow<String> = _deviceTarget

    // Remote devices fetched from PAN server
    private val _devices = MutableStateFlow<List<DeviceItem>>(emptyList())
    val devices: StateFlow<List<DeviceItem>> = _devices

    val isServerConnected: StateFlow<Boolean> = serverClient.isConnected

    init {
        viewModelScope.launch {
            dataRepository.getSetting("server_url")?.let { _serverUrl.value = it }
            dataRepository.getSetting("trigger_word")?.let { _triggerWord.value = it }
            dataRepository.getSetting("beep_enabled")?.let { _beepEnabled.value = it == "true" }
            dataRepository.getSetting("vibration_enabled")?.let { _vibrationEnabled.value = it == "true" }
            dataRepository.getSetting("voice_response_enabled")?.let { _voiceResponseEnabled.value = it == "true" }
            dataRepository.getSetting("device_target")?.let { _deviceTarget.value = it }
        }
        // Fetch device list from server
        refreshDevices()
    }

    fun refreshDevices() {
        viewModelScope.launch {
            try {
                val res = api.deviceList()
                if (res.isSuccessful) {
                    _devices.value = res.body() ?: emptyList()
                }
            } catch (_: Exception) {}
        }
    }

    fun setServerUrl(url: String) {
        _serverUrl.value = url
        viewModelScope.launch { dataRepository.setSetting("server_url", url) }
    }

    fun setTriggerWord(word: String) {
        _triggerWord.value = word
        viewModelScope.launch { dataRepository.setSetting("trigger_word", word.lowercase()) }
    }

    fun setBeep(enabled: Boolean) {
        _beepEnabled.value = enabled
        viewModelScope.launch { dataRepository.setSetting("beep_enabled", enabled.toString()) }
    }

    fun setVibration(enabled: Boolean) {
        _vibrationEnabled.value = enabled
        viewModelScope.launch { dataRepository.setSetting("vibration_enabled", enabled.toString()) }
    }

    fun setVoiceResponse(enabled: Boolean) {
        _voiceResponseEnabled.value = enabled
        viewModelScope.launch { dataRepository.setSetting("voice_response_enabled", enabled.toString()) }
    }

    fun setDeviceTarget(target: String) {
        _deviceTarget.value = target
        viewModelScope.launch { dataRepository.setSetting("device_target", target) }
    }
}
