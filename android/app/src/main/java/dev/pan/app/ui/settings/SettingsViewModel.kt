package dev.pan.app.ui.settings

import android.app.Application
import android.content.Intent
import android.net.VpnService
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.pan.app.ai.LocalLlm
import dev.pan.app.ai.MediaPipeLlm
import dev.pan.app.data.DataRepository
import dev.pan.app.network.PanServerApi
import dev.pan.app.network.PanServerClient
import dev.pan.app.ui.commands.DeviceItem
import dev.pan.app.util.Constants
import dev.pan.app.vpn.RemoteAccessManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val dataRepository: DataRepository,
    private val api: PanServerApi,
    private val serverClient: PanServerClient,
    private val localLlm: LocalLlm,
    private val application: Application,
    val remoteAccessManager: RemoteAccessManager
) : ViewModel() {

    private val _serverUrl = MutableStateFlow(Constants.DEFAULT_SERVER_URL)
    val serverUrl: StateFlow<String> = _serverUrl

    private val _triggerWord = MutableStateFlow("hey pan")
    val triggerWord: StateFlow<String> = _triggerWord

    private val _deviceName = MutableStateFlow(android.os.Build.MODEL)
    val deviceName: StateFlow<String> = _deviceName

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

    // Query answer source: "local" (on-device LLM), "cloud" (Haiku/API), "auto"
    private val _queryAnswerSource = MutableStateFlow("cloud")
    val queryAnswerSource: StateFlow<String> = _queryAnswerSource

    // Dual model selection: classifier + conversation
    private val _classifierModel = MutableStateFlow("qwen3-0.6b")
    val classifierModel: StateFlow<String> = _classifierModel

    private val _conversationModel = MutableStateFlow("")
    val conversationModel: StateFlow<String> = _conversationModel

    // Keep for backward compat with UI status display
    private val _selectedLlmModel = MutableStateFlow("qwen3-0.6b")
    val selectedLlmModel: StateFlow<String> = _selectedLlmModel

    private val _llmStatus = MutableStateFlow("not_downloaded")
    val llmStatus: StateFlow<String> = _llmStatus

    private val _llmDownloadProgress = MutableStateFlow(0f)
    val llmDownloadProgress: StateFlow<Float> = _llmDownloadProgress

    // Track which model is currently being downloaded — StateFlow so Compose observes it
    private val _downloadingId = MutableStateFlow<String?>(null)
    val downloadingId: StateFlow<String?> = _downloadingId

    val isServerConnected: StateFlow<Boolean> = serverClient.isConnected

    // Remote access state
    val remoteAccessEnabled: StateFlow<Boolean> = remoteAccessManager.enabled
    val remoteAccessStatus: StateFlow<String> = remoteAccessManager.status
    val remoteAccessIp: StateFlow<String> = remoteAccessManager.ip

    // MediaPipe on-device AI
    private var mediaPipeLlm: MediaPipeLlm? = null

    // Gemini API key
    private val _geminiKey = MutableStateFlow("")
    val geminiKey: StateFlow<String> = _geminiKey

    init {
        viewModelScope.launch {
            dataRepository.getSetting("server_url")?.let { _serverUrl.value = it }
            dataRepository.getSetting("trigger_word")?.let { _triggerWord.value = it }
            dataRepository.getSetting("beep_enabled")?.let { _beepEnabled.value = it == "true" }
            dataRepository.getSetting("vibration_enabled")?.let { _vibrationEnabled.value = it == "true" }
            dataRepository.getSetting("voice_response_enabled")?.let { _voiceResponseEnabled.value = it == "true" }
            dataRepository.getSetting("device_target")?.let { _deviceTarget.value = it }
            dataRepository.getSetting("device_name")?.let { _deviceName.value = it }
            dataRepository.getSetting("preferred_music_app")?.let { _preferredMusicApp.value = it }
            dataRepository.getSetting("preferred_messaging_app")?.let { _preferredMessagingApp.value = it }
            dataRepository.getSetting("query_answer_source")?.let { _queryAnswerSource.value = it }
            dataRepository.getSetting("classifier_model")?.let { _classifierModel.value = it }
            dataRepository.getSetting("conversation_model")?.let { _conversationModel.value = it }
            // backward compat
            dataRepository.getSetting("selected_llm_model")?.let { _selectedLlmModel.value = it }
            dataRepository.getSetting("gemini_key")?.let { _geminiKey.value = it }
        }
        refreshDevices()
        refreshLlmStatus()
        mediaPipeLlm = MediaPipeLlm(application)
    }

    fun refreshLlmStatus() {
        val model = LocalLlm.AVAILABLE_MODELS.find { it.id == _classifierModel.value }
            ?: localLlm.getRecommendedModel()
        _llmStatus.value = localLlm.getModelStatus(model)
    }

    fun getModelStatus(model: LocalLlm.ModelInfo): String = localLlm.getModelStatus(model)

    fun downloadModel(modelId: String) {
        val model = LocalLlm.AVAILABLE_MODELS.find { it.id == modelId } ?: return
        _downloadingId.value = modelId
        _llmDownloadProgress.value = 0f
        viewModelScope.launch {
            localLlm.downloadModel(model) { progress ->
                _llmDownloadProgress.value = progress
            }
            _downloadingId.value = null
            refreshLlmStatus()
        }
    }

    fun isDownloading(modelId: String): Boolean = _downloadingId.value == modelId

    fun deleteModel(modelId: String) {
        val model = LocalLlm.AVAILABLE_MODELS.find { it.id == modelId } ?: return
        localLlm.deleteModel(model)
        refreshLlmStatus()
    }

    fun loadModel(modelId: String) {
        val model = LocalLlm.AVAILABLE_MODELS.find { it.id == modelId } ?: return
        viewModelScope.launch {
            localLlm.loadModel(model)
            refreshLlmStatus()
        }
    }

    fun setClassifierModel(modelId: String) {
        _classifierModel.value = modelId
        viewModelScope.launch {
            dataRepository.setSetting("classifier_model", modelId)
            localLlm.selectClassifierModel(modelId)
        }
    }

    fun setConversationModel(modelId: String) {
        _conversationModel.value = modelId
        viewModelScope.launch {
            dataRepository.setSetting("conversation_model", modelId)
            localLlm.selectConversationModel(modelId)
        }
    }

    fun addCustomModel(name: String, url: String) {
        val id = "custom-${name.lowercase().replace(" ", "-")}"
        LocalLlm.addCustomModel(id, name, url, 500_000_000)
        refreshLlmStatus()
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

    fun setDeviceName(name: String) {
        _deviceName.value = name
        dev.pan.app.di.DeviceNameHolder.name = name
        viewModelScope.launch { dataRepository.setSetting("device_name", name) }
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

    fun setQueryAnswerSource(source: String) {
        _queryAnswerSource.value = source
        viewModelScope.launch { dataRepository.setSetting("query_answer_source", source) }
    }

    fun setSelectedLlmModel(modelId: String) {
        _selectedLlmModel.value = modelId
        viewModelScope.launch { dataRepository.setSetting("selected_llm_model", modelId) }
        localLlm.selectModel(modelId)
        refreshLlmStatus()
    }

    fun getDownloadProgress(): Float = _llmDownloadProgress.value

    // --- Remote Access ---

    fun enableRemoteAccess(enabled: Boolean) {
        if (enabled) {
            remoteAccessManager.setEnabled(true)
            remoteAccessManager.setStatus("Connecting...")
            viewModelScope.launch {
                try {
                    // Try auto-auth from server first
                    val resp = api.getTailscaleAuthKey(mapOf("action" to "get_key"))
                    if (resp.isSuccessful) {
                        val key = resp.body()?.get("auth_key") as? String
                        if (!key.isNullOrBlank()) {
                            Log.d("Settings", "Got auto-auth key from server")
                            dev.pan.app.vpn.PanVpn.setAuthKey(application, key)
                        }
                    }
                } catch (e: Exception) {
                    Log.d("Settings", "Auto-auth failed, falling back to browser: ${e.message}")
                }
                // Connect via VpnService — will use auth key if set, otherwise show login URL
                try {
                    val loginUrl = dev.pan.app.vpn.PanVpn.connect(application)
                    if (loginUrl != null) {
                        dev.pan.app.vpn.PanVpn.openLoginUrl(application, loginUrl)
                        // Poll until connected after browser login
                        for (i in 0 until 120) {
                            kotlinx.coroutines.delay(2000)
                            remoteAccessManager.refreshFromVpn()
                            if (remoteAccessManager.status.value == "Connected") break
                        }
                    } else {
                        // Connected silently — poll until proxy ready
                        for (i in 0 until 15) {
                            remoteAccessManager.refreshFromVpn()
                            if (remoteAccessManager.status.value == "Connected") break
                            kotlinx.coroutines.delay(1000)
                        }
                        remoteAccessManager.refreshFromVpn()
                    }
                } catch (e: Exception) {
                    Log.e("Settings", "VPN connect failed: ${e.message}")
                    remoteAccessManager.setStatus("Failed: ${e.message}")
                }
            }
        } else {
            viewModelScope.launch {
                dev.pan.app.vpn.PanVpn.disconnect(application)
                remoteAccessManager.setEnabled(false)
            }
        }
    }

    fun getRemoteProxyUrl(): String? {
        return remoteAccessManager.getTailscaleBaseUrl()
    }

    fun getVpnIntent(): Intent? {
        return VpnService.prepare(application)
    }

    // --- MediaPipe On-Device AI ---

    fun getMediaPipeStatus(): String {
        return mediaPipeLlm?.getStatus() ?: "not_downloaded"
    }

    fun downloadMediaPipeModel() {
        _downloadingId.value = "mediapipe-gemma3n"
        _llmDownloadProgress.value = 0f
        viewModelScope.launch {
            val mp = mediaPipeLlm ?: MediaPipeLlm(application).also { mediaPipeLlm = it }
            val success = mp.downloadModel { progress ->
                _llmDownloadProgress.value = progress
            }
            _downloadingId.value = null
            if (success) {
                mp.loadModel()
            }
        }
    }

    // --- Gemini API Key ---

    fun getGeminiKey(): String = _geminiKey.value

    fun setGeminiKey(key: String) {
        _geminiKey.value = key
        viewModelScope.launch { dataRepository.setSetting("gemini_key", key) }
    }
}
