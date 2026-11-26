package dev.pan.app.ui.settings

import android.app.Application
import android.content.Intent
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.pan.app.BuildConfig
import dev.pan.app.data.DataRepository
import dev.pan.app.network.PanServerApi
import dev.pan.app.network.PanServerClient
import dev.pan.app.network.DeviceItem
import dev.pan.app.update.UpdateChecker
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
    private val application: Application,
    private val updateChecker: UpdateChecker,
    val remoteAccessManager: RemoteAccessManager,
    val accessoryHub: dev.pan.app.accessory.AccessoryHub,
    private val feedbackSounds: dev.pan.app.audio.FeedbackSounds,
) : ViewModel() {

    /** A plain call to the hub for a settings section that only shows what the hub decides (People). */
    suspend fun hub(method: String, path: String, body: org.json.JSONObject? = null) = serverClient.hubJson(method, path, body)

    /** False on a device paired for a person other than the owner: the owner's sections are not shown. */
    suspend fun ownersDevice() = serverClient.ownersDevice()

    private val _serverUrl = MutableStateFlow(Constants.DEFAULT_SERVER_URL)
    val serverUrl: StateFlow<String> = _serverUrl

    private val _deviceName = MutableStateFlow(android.os.Build.MODEL)
    val deviceName: StateFlow<String> = _deviceName

    private val _backchannelEnabled = MutableStateFlow(false)
    val backchannelEnabled: StateFlow<Boolean> = _backchannelEnabled

    private val _beepEnabled = MutableStateFlow(true)
    val beepEnabled: StateFlow<Boolean> = _beepEnabled

    private val _vibrationEnabled = MutableStateFlow(true)
    val vibrationEnabled: StateFlow<Boolean> = _vibrationEnabled

    // Device target: "auto", "phone:<this>", or a device hostname
    // auto = nearest connected device (server connected → PC, otherwise phone)
    // phone = always handle locally
    // <hostname> = send to that specific device
    private val _deviceTarget = MutableStateFlow("auto")
    val deviceTarget: StateFlow<String> = _deviceTarget

    // Remote devices fetched from PAN server
    private val _devices = MutableStateFlow<List<DeviceItem>>(emptyList())
    val devices: StateFlow<List<DeviceItem>> = _devices

    // Query answer source: "local" (on-device LLM), "cloud" (Haiku/API), "auto"
    private val _queryAnswerSource = MutableStateFlow("cloud")
    val queryAnswerSource: StateFlow<String> = _queryAnswerSource

    val isServerConnected: StateFlow<Boolean> = serverClient.isConnected

    // Remote access state
    val remoteAccessEnabled: StateFlow<Boolean> = remoteAccessManager.enabled
    val remoteAccessStatus: StateFlow<String> = remoteAccessManager.status
    val remoteAccessIp: StateFlow<String> = remoteAccessManager.ip

    // PAN personality (free-form prompt; empty = default/off)
    private val _personality = MutableStateFlow("")
    val personality: StateFlow<String> = _personality

    private val _toastMessage = MutableStateFlow<String?>(null)
    val toastMessage: StateFlow<String?> = _toastMessage
    fun clearToast() { _toastMessage.value = null }

    // Manual OTA update check — true while a check/download is in flight so the
    // button can show a "Checking…" state and prevent double-taps.
    private val _updateChecking = MutableStateFlow(false)
    val updateChecking: StateFlow<Boolean> = _updateChecking
    /** 0..1 while an update downloads (UpdateChecker.progress), else null. */
    val updateProgress: StateFlow<Float?> get() = updateChecker.progress
    fun updateTotalMb(): Long = updateChecker.progressTotal / 1_000_000

    // Incognito mode — when on, the X-PAN-Scope header flips to "incognito"
    // and the server routes ALL phone-originated event writes to a sibling
    // SQLCipher file (pan.incognito.db) that can be wiped with one call when
    // the user toggles the mode back off. Persisted across app restarts so
    // the user doesn't accidentally drop out of it on a reboot.
    private val _incognitoMode = MutableStateFlow(false)
    val incognitoMode: StateFlow<Boolean> = _incognitoMode

    // Tier 0 Phase 4: org policy gate. When the active org disallows
    // incognito, the toggle is greyed out.
    // Default FAIL-CLOSED: assume disallowed until the server confirms
    // otherwise. Prevents a brief window on launch (or with no network)
    // where the toggle would appear active despite an org ban.
    private val _incognitoAllowed = MutableStateFlow(false)
    val incognitoAllowed: StateFlow<Boolean> = _incognitoAllowed

    init {
        viewModelScope.launch {
            dataRepository.getSetting("server_url")?.let { _serverUrl.value = it }
            dataRepository.getSetting("beep_enabled")?.let { _beepEnabled.value = it == "true"; feedbackSounds.setSound(it == "true") }
            dataRepository.getSetting("backchannel_enabled")?.let { _backchannelEnabled.value = it == "true" }
            dataRepository.getSetting("vibration_enabled")?.let { _vibrationEnabled.value = it == "true"; feedbackSounds.setVibration(it == "true") }
            dataRepository.getSetting("device_target")?.let { _deviceTarget.value = it }
            dataRepository.getSetting("device_name")?.let { _deviceName.value = it }
            dataRepository.getSetting("query_answer_source")?.let { _queryAnswerSource.value = it }
            // Restore incognito mode from local persistence and immediately
            // reflect it in the network ScopeHolder so the very first request
            // after launch carries the correct X-PAN-Scope header.
            dataRepository.getSetting("incognito_mode")?.let {
                val on = it == "true"
                _incognitoMode.value = on
                dev.pan.app.di.ScopeHolder.set(application, on)
            }
        }

        // Personality: this device's own (util/Personality.kt). A phone from before Nov 26 kept a
        // copy of the hub's shared text in the settings table: it moves over once, then the hub's
        // global setting is never read or written from here again.
        viewModelScope.launch {
            if (!dev.pan.app.util.Personality.saved(application)) {
                dataRepository.getSetting("personality")?.let { dev.pan.app.util.Personality.set(application, it) }
            }
            dev.pan.app.util.Personality.load(application)
            _personality.value = dev.pan.app.util.Personality.text
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
        // All AI via server — no local model init
    }

    fun refreshDevices() {
        viewModelScope.launch {
            if (!serverClient.ownersDevice()) return@launch
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

    fun setBackchannel(enabled: Boolean) {
        _backchannelEnabled.value = enabled
        dev.pan.app.stt.SherpaStreamingStt.backchannelOn = enabled
        viewModelScope.launch { dataRepository.setSetting("backchannel_enabled", enabled.toString()) }
    }

    fun setBeep(enabled: Boolean) {
        _beepEnabled.value = enabled
        feedbackSounds.setSound(enabled)
        viewModelScope.launch { dataRepository.setSetting("beep_enabled", enabled.toString()) }
    }

    fun setVibration(enabled: Boolean) {
        _vibrationEnabled.value = enabled
        feedbackSounds.setVibration(enabled)
        viewModelScope.launch { dataRepository.setSetting("vibration_enabled", enabled.toString()) }
    }

    fun setDeviceTarget(target: String) {
        _deviceTarget.value = target
        viewModelScope.launch { dataRepository.setSetting("device_target", target) }
    }

    fun setQueryAnswerSource(source: String) {
        _queryAnswerSource.value = source
        viewModelScope.launch { dataRepository.setSetting("query_answer_source", source) }
    }

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
                // Start the app's own Tailscale: uses the auth key if set, otherwise shows the login URL
                try {
                    val loginUrl = dev.pan.app.vpn.PanVpn.connect(application, byHand = true)
                    if (loginUrl != null) {
                        // No browser (Nov 15): the sign-in button is under Settings > Advanced.
                        Log.i("Settings", "Tailscale wants a sign-in; no key from the hub")
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

    // --- Personality ---
    // Empty string = turned off. Saved on this device only and sent with every voice turn
    // (PanServerClient.askPanStream), so it does not change ΠAN on anyone else's device.
    fun setPersonality(text: String) {
        dev.pan.app.util.Personality.set(application, text)
        _personality.value = dev.pan.app.util.Personality.text
    }

    fun clearPersonality() = setPersonality("")

    // --- Manual OTA update ---
    //
    // Pulls the same self-update flow MainActivity fires ~8s after launch, but
    // on-demand from a Settings button. Says "found, downloading" before the
    // download starts, then how it ended, via the snackbar. If the launch check
    // is still downloading, checkAndInstall waits for it instead of starting a
    // second download. UpdateChecker runs its network/IO on Dispatchers.IO
    // internally, so launching from viewModelScope (Main) is safe.
    fun checkForUpdate() {
        if (_updateChecking.value) return
        _updateChecking.value = true
        viewModelScope.launch {
            try {
                when (val found = updateChecker.check()) {
                    is UpdateChecker.Result.UpToDate ->
                        _toastMessage.value = "You're on the latest version (${BuildConfig.VERSION_NAME})"
                    is UpdateChecker.Result.Error ->
                        _toastMessage.value = "Update check failed: ${found.message}"
                    is UpdateChecker.Result.UpdateAvailable -> {
                        _toastMessage.value = "Update ${found.versionName} found, downloading…"
                        when (val result = updateChecker.checkAndInstall(application)) {
                            is UpdateChecker.Result.UpdateInstalling ->
                                _toastMessage.value = "Installing ${result.versionName}…"
                            is UpdateChecker.Result.UpToDate ->
                                _toastMessage.value = "You're on the latest version (${BuildConfig.VERSION_NAME})"
                            is UpdateChecker.Result.Error ->
                                _toastMessage.value = "Update failed: ${result.message}"
                            else -> {}
                        }
                    }
                    else -> {}
                }
            } finally {
                _updateChecking.value = false
            }
        }
    }

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
        dev.pan.app.di.ScopeHolder.set(application, enabled)
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
