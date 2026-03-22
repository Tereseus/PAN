package dev.pan.app.ui.settings

import android.app.Application
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.pan.app.ai.LocalLlm
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
    private val serverClient: PanServerClient,
    private val application: Application
) : ViewModel() {

    private val localLlm = LocalLlm(application)

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

    // App preferences
    private val _preferredMusicApp = MutableStateFlow("Auto")
    val preferredMusicApp: StateFlow<String> = _preferredMusicApp

    private val _preferredMessagingApp = MutableStateFlow("Auto")
    val preferredMessagingApp: StateFlow<String> = _preferredMessagingApp

    // Local LLM model selection
    private val _selectedLlmModel = MutableStateFlow("llama-3.2-3b")
    val selectedLlmModel: StateFlow<String> = _selectedLlmModel

    private val _llmStatus = MutableStateFlow("not_downloaded")
    val llmStatus: StateFlow<String> = _llmStatus

    private val _llmDownloadProgress = MutableStateFlow(0f)
    val llmDownloadProgress: StateFlow<Float> = _llmDownloadProgress

    val isServerConnected: StateFlow<Boolean> = serverClient.isConnected

    init {
        viewModelScope.launch {
            dataRepository.getSetting("server_url")?.let { _serverUrl.value = it }
            dataRepository.getSetting("trigger_word")?.let { _triggerWord.value = it }
            dataRepository.getSetting("beep_enabled")?.let { _beepEnabled.value = it == "true" }
            dataRepository.getSetting("vibration_enabled")?.let { _vibrationEnabled.value = it == "true" }
            dataRepository.getSetting("voice_response_enabled")?.let { _voiceResponseEnabled.value = it == "true" }
            dataRepository.getSetting("device_target")?.let { _deviceTarget.value = it }
            dataRepository.getSetting("preferred_music_app")?.let { _preferredMusicApp.value = it }
            dataRepository.getSetting("preferred_messaging_app")?.let { _preferredMessagingApp.value = it }
            dataRepository.getSetting("selected_llm_model")?.let { _selectedLlmModel.value = it }
        }
        // Fetch device list from server
        refreshDevices()
        // Check LLM status — sync selected model with what's recommended/downloaded
        if (_selectedLlmModel.value == "llama-3.2-3b") {
            // Default hasn't been changed by user — use recommended model
            val recommended = localLlm.getRecommendedModel()
            _selectedLlmModel.value = recommended.id
        }
        refreshLlmStatus()
    }

    fun refreshLlmStatus() {
        val model = LocalLlm.AVAILABLE_MODELS.find { it.id == _selectedLlmModel.value }
            ?: localLlm.getRecommendedModel()
        _llmStatus.value = localLlm.getModelStatus(model)
    }

    fun downloadModel() {
        val model = LocalLlm.AVAILABLE_MODELS.find { it.id == _selectedLlmModel.value }
            ?: localLlm.getRecommendedModel()
        _llmStatus.value = "downloading"
        _llmDownloadProgress.value = 0f
        viewModelScope.launch {
            val success = localLlm.downloadModel(model) { progress ->
                _llmDownloadProgress.value = progress
            }
            _llmStatus.value = if (success) "downloaded" else "not_downloaded"
        }
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

    fun setPreferredMusicApp(app: String) {
        _preferredMusicApp.value = app
        viewModelScope.launch { dataRepository.setSetting("preferred_music_app", app) }
    }

    fun setPreferredMessagingApp(app: String) {
        _preferredMessagingApp.value = app
        viewModelScope.launch { dataRepository.setSetting("preferred_messaging_app", app) }
    }

    fun setSelectedLlmModel(modelId: String) {
        _selectedLlmModel.value = modelId
        viewModelScope.launch { dataRepository.setSetting("selected_llm_model", modelId) }
        localLlm.selectModel(modelId)
        refreshLlmStatus()
    }
}
