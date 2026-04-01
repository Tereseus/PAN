package dev.pan.app.vpn

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import panvpn.Panvpn
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Single source of truth for remote access state.
 * Both MainViewModel and SettingsViewModel read from here.
 */
@Singleton
class RemoteAccessManager @Inject constructor() {

    companion object {
        private const val TAG = "RemoteAccess"
    }

    private val _enabled = MutableStateFlow(false)
    val enabled: StateFlow<Boolean> = _enabled

    private val _status = MutableStateFlow("Off")
    val status: StateFlow<String> = _status

    private val _ip = MutableStateFlow("")
    val ip: StateFlow<String> = _ip

    private val _org = MutableStateFlow("")
    val org: StateFlow<String> = _org

    /** The Tailscale hostname for the PAN server (e.g., "tedgl") */
    private val _serverTailscaleHost = MutableStateFlow("")
    val serverTailscaleHost: StateFlow<String> = _serverTailscaleHost

    /** Local proxy port that tunnels through tsnet */
    private val _proxyPort = MutableStateFlow(0)
    val proxyPort: StateFlow<Int> = _proxyPort

    /**
     * Whether API calls should route through the local tsnet proxy.
     */
    val shouldUseTailscale: Boolean
        get() = _enabled.value && _status.value == "Connected" && _proxyPort.value > 0

    /**
     * Returns the local proxy URL, or null if not available.
     * OkHttp connects to localhost:<proxyPort> which tunnels through tsnet.
     */
    fun getTailscaleBaseUrl(): String? {
        val port = _proxyPort.value
        if (!shouldUseTailscale || port <= 0) return null
        return "http://127.0.0.1:$port"
    }

    fun updateStatus(connected: Boolean, statusText: String, ipAddr: String, orgName: String) {
        _enabled.value = connected || _enabled.value
        _status.value = statusText
        _ip.value = ipAddr
        _org.value = orgName
        Log.d(TAG, "Status: $statusText, IP: $ipAddr, org: $orgName")
    }

    fun setEnabled(value: Boolean) {
        _enabled.value = value
        if (!value) {
            _status.value = "Off"
            _ip.value = ""
            _org.value = ""
        }
    }

    fun setStatus(value: String) {
        _status.value = value
    }

    fun setServerTailscaleHost(hostname: String) {
        _serverTailscaleHost.value = hostname
        Log.d(TAG, "Server tailscale host: $hostname")
    }

    fun setProxyPort(port: Int) {
        _proxyPort.value = port
        Log.d(TAG, "Proxy port: $port")
    }

    /** Discovered PAN server IP on the tailnet */
    private val _serverIp = MutableStateFlow("")
    val serverIp: StateFlow<String> = _serverIp

    fun refreshFromVpn() {
        val status = PanVpn.getStatus()
        _ip.value = status.ip
        _org.value = status.org
        if (status.connected) {
            _enabled.value = true
        }
        // Update proxy port — only say "Connected" when proxy is actually working
        try {
            val port = Panvpn.getProxyPort().toInt()
            _proxyPort.value = port
            if (status.connected && port > 0) {
                _status.value = "Connected"
            } else if (status.connected) {
                _status.value = "Connecting..."
            } else if (_enabled.value) {
                _status.value = "Connecting..."
            } else {
                _status.value = "Off"
            }
        } catch (e: Exception) {
            _proxyPort.value = 0
            _status.value = if (_enabled.value) "Connecting..." else "Off"
        }

        if (!status.connected) {
            _proxyPort.value = 0
        }
    }
}
