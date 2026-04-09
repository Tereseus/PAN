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

    // PAN personality (free-form prompt; empty = default/off)
    private val _personality = MutableStateFlow("")
    val personality: StateFlow<String> = _personality

    // Incognito mode — when on, the X-PAN-Scope header flips to "incognito"
    // and the server routes ALL phone-originated event writes to a sibling
    // SQLCipher file (pan.incognito.db) that can be wiped with one call when
    // the user toggles the mode back off. Persisted across app restarts so
    // the user doesn't accidentally drop out of it on a reboot.
    private val _incognitoMode = MutableStateFlow(false)
    val incognitoMode: StateFlow<Boolean> = _incognitoMode

    // Tier 0 Phase 4: org policy gates. When the active org disallows
    // incognito (or blackout), the corresponding toggle is greyed out.
    // Default FAIL-CLOSED: assume disallowed until the server confirms
    // otherwise. Prevents a brief window on launch (or with no network)
    // where the toggle would appear active despite an org ban.
    private val _incognitoAllowed = MutableStateFlow(false)
    val incognitoAllowed: StateFlow<Boolean> = _incognitoAllowed
    private val _blackoutAllowed = MutableStateFlow(false)
    val blackoutAllowed: StateFlow<Boolean> = _blackoutAllowed

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
            // Restore incognito mode from local persistence and immediately
            // reflect it in the network ScopeHolder so the very first request
            // after launch carries the correct X-PAN-Scope header.
            dataRepository.getSetting("incognito_mode")?.let {
                val on = it == "true"
                _incognitoMode.value = on
                dev.pan.app.di.ScopeHolder.scope = if (on) "incognito" else "main"
            }
        }

        // Personality: prefer server value (source of truth), fall back to local
        viewModelScope.launch {
            try {
                val res = api.getSettings()
                if (res.isSuccessful) {
                    val v = res.body()?.get("personality") as? String
                    if (v != null) {
                        _personality.value = v
                        dataRepository.setSetting("personality", v)
                    } else {
                        dataRepository.getSetting("personality")?.let { _personality.value = it }
                    }
                } else {
                    dataRepository.getSetting("personality")?.let { _personality.value = it }
                }
            } catch (_: Exception) {
                dataRepository.getSetting("personality")?.let { _personality.value = it }
            }
        }

        // Tier 0 Phase 4: poll org policy on its own coroutine. If the org
        // disallows incognito, grey out the toggle. If we're already in
        // incognito and the org just disallowed it, force out immediately.
        viewModelScope.launch {
            while (true) {
                try {
                    val res = api.getOrgPolicy()
                    if (res.isSuccessful) {
                        val p = res.body()
                        if (p != null) {
                            _incognitoAllowed.value = p.incognito_allowed
                            _blackoutAllowed.value = p.blackout_allowed
                            if (!p.incognito_allowed && _incognitoMode.value) {
                                Log.w("Settings", "Org disallowed incognito while active — forcing out")
                                setIncognitoMode(false)
                            }
                        }
                    }
                } catch (_: Exception) {}
                kotlinx.coroutines.delay(60000)
            }
        }
        refreshDevices()
        refreshLlmStatus()
        // All AI via server — no local model init
    }

    fun refreshLlmStatus() {
        _llmStatus.value = "server"
    }

    fun addCustomModel(name: String, url: String) {
        // Custom model endpoints (Ollama, LM Studio, etc.) saved to server settings
        viewModelScope.launch {
            dataRepository.setSetting("custom_model_${name.lowercase().replace(" ", "-")}", url)
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

    // MediaPipe REMOVED — all AI via server

    // --- Gemini API Key ---

    fun getGeminiKey(): String = _geminiKey.value

    fun setGeminiKey(key: String) {
        _geminiKey.value = key
        viewModelScope.launch { dataRepository.setSetting("gemini_key", key) }
    }

    // --- Personality ---
    // Empty string = default/off (no personality block injected by router).
    fun setPersonality(text: String) {
        _personality.value = text
        viewModelScope.launch {
            dataRepository.setSetting("personality", text)
            // Push to server so all devices share the same personality
            try {
                api.updateSettings(mapOf("personality" to text))
            } catch (e: Exception) {
                Log.w("Settings", "Failed to push personality to server: ${e.message}")
            }
        }
    }

    fun clearPersonality() = setPersonality("")

    // --- Incognito mode ---
    //
    // Toggling ON: flip ScopeHolder so all subsequent requests carry
    //   X-PAN-Scope: incognito. The server lazy-creates pan.incognito.db
    //   and routes phone-originated event writes there.
    // Toggling OFF: flip ScopeHolder back to "main" AND ask the server to
    //   wipe the incognito SQLCipher file. True forget — file is closed and
    //   deleted along with its WAL/SHM siblings. There is no recovery.
    fun setIncognitoMode(enabled: Boolean) {
        // Tier 0 Phase 4: org policy hard guard — if the active org disallows
        // incognito, refuse to enable it on the phone side too. Server also
        // enforces this in the scope middleware as a defense-in-depth backstop.
        if (enabled && !_incognitoAllowed.value) {
            Log.w("Settings", "setIncognitoMode(true) blocked: org policy disallows incognito")
            return
        }
        _incognitoMode.value = enabled
        dev.pan.app.di.ScopeHolder.scope = if (enabled) "incognito" else "main"
        viewModelScope.launch {
            dataRepository.setSetting("incognito_mode", enabled.toString())
            if (!enabled) {
                // Wipe the server-side incognito DB on toggle-off so private
                // session content actually disappears, not just goes invisible.
                try {
                    api.wipeScope("incognito")
                } catch (e: Exception) {
                    Log.w("Settings", "incognito wipe failed: ${e.message}")
                }
            }
        }
    }

    // --- Stop / Force-Restart the foreground PAN service ---
    //
    // The PAN foreground service is what keeps voice triggers, log shipping,
    // remote access, and the persistent notification alive. These two actions
    // give the user explicit control over it from Settings.

    fun stopPanService() {
        try {
            val intent = Intent(application, dev.pan.app.service.PanForegroundService::class.java)
            application.stopService(intent)
            Log.d("Settings", "PanForegroundService stopped via Settings toggle")
        } catch (e: Exception) {
            Log.e("Settings", "stopPanService failed: ${e.message}")
        }
    }

    fun forceRestartApp() {
        try {
            // Stop the foreground service first so it doesn't survive the
            // process kill and resurrect with stale state.
            stopPanService()
            // Build a fresh launch intent for ourselves and start it in a NEW
            // task with cleared backstack — this gives us a clean cold start.
            val pm = application.packageManager
            val launch = pm.getLaunchIntentForPackage(application.packageName)
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                application.startActivity(launch)
            }
            // Then kill our own process. Android will hand control to the
            // freshly-launched activity, which boots a fresh ViewModel + DI
            // graph + foreground service. The cleanest possible restart.
            android.os.Process.killProcess(android.os.Process.myPid())
            kotlin.system.exitProcess(0)
        } catch (e: Exception) {
            Log.e("Settings", "forceRestartApp failed: ${e.message}")
        }
    }
}
