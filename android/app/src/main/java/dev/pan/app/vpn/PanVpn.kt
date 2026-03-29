package dev.pan.app.vpn

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import panvpn.Panvpn

/**
 * PAN Remote Access — powered by Tailscale tsnet via Android VpnService.
 * All connect/disconnect calls go through PanVpnService to get the
 * elevated network permissions (netlink) that tsnet requires on Android.
 */
object PanVpn {

    private const val TAG = "PanVpn"
    private const val PREFS_NAME = "pan_vpn"
    private const val KEY_AUTH_KEY = "auth_key"
    private const val KEY_HOSTNAME = "hostname"
    private const val KEY_SERVER_HOSTNAME = "server_hostname"
    private const val KEY_ENABLED = "enabled"
    private const val DEFAULT_SERVER_HOSTNAME = "tedgl"

    /** VPN consent request code for Activity.startActivityForResult */
    const val VPN_REQUEST_CODE = 0x50414E  // "PAN" in hex

    data class VpnStatus(
        val connected: Boolean,
        val hostname: String = "",
        val ip: String = "",
        val org: String = "",
        val error: String = ""
    )

    /**
     * Check if VPN permission has been granted by the user.
     * Returns null if already granted, or an Intent for the consent dialog.
     */
    fun prepareVpn(context: Context): Intent? = PanVpnService.prepare(context)

    /**
     * Connect to the PAN tailnet via VpnService.
     * Returns a login URL if interactive Tailscale auth is needed, null if already authenticated.
     * Throws if VPN permission not granted — call prepareVpn() first from an Activity.
     */
    suspend fun connect(context: Context): String? = withContext(Dispatchers.IO) {
        try {
            Log.i(TAG, "Starting VPN service...")

            val intent = Intent(context, PanVpnService::class.java).apply {
                action = PanVpnService.ACTION_CONNECT
            }
            context.startForegroundService(intent)

            // Wait for the service to establish VPN and connect tsnet
            var attempts = 0
            while (attempts < 60) {
                delay(500)
                attempts++

                val svc = PanVpnService.instance ?: continue

                // Check if login URL is available from the service
                val url = svc.getLoginUrl()
                if (url != null) {
                    Log.i(TAG, "Login required: $url")
                    return@withContext url
                }

                // Once tsnet is running, check its actual status
                if (isRunning()) {
                    val status = getStatus()
                    if (status.connected) {
                        // Also check if proxy is running
                        val proxyPort = try { Panvpn.getProxyPort().toInt() } catch (_: Exception) { 0 }
                        Log.i(TAG, "Connected: ip=${status.ip}, proxy=$proxyPort")
                        return@withContext null
                    }
                }
            }

            // If tsnet started but isn't connected, it likely needs auth
            if (isRunning()) {
                Log.w(TAG, "tsnet running but not connected — may need Tailscale auth key")
                return@withContext null
            }

            throw Exception("Connection timed out after 30s")
        } catch (e: Exception) {
            Log.e(TAG, "Connection failed", e)
            throw e
        }
    }

    /**
     * Disconnect from the PAN tailnet.
     */
    suspend fun disconnect(context: Context) = withContext(Dispatchers.IO) {
        try {
            val intent = Intent(context, PanVpnService::class.java).apply {
                action = PanVpnService.ACTION_DISCONNECT
            }
            context.startService(intent)
            Log.i(TAG, "Disconnected")
        } catch (e: Exception) {
            Log.e(TAG, "Disconnect failed", e)
        }
    }

    /**
     * Get current connection status.
     */
    fun getStatus(): VpnStatus {
        return try {
            val status = Panvpn.getStatus()
            val org = try {
                status.javaClass.getMethod("getOrg").invoke(status) as? String ?: ""
            } catch (_: Throwable) { "" }
            VpnStatus(
                connected = status.connected,
                hostname = status.hostname,
                ip = status.ip,
                org = org,
                error = status.error
            )
        } catch (e: Exception) {
            VpnStatus(connected = false, error = e.message ?: "Unknown error")
        }
    }

    /**
     * Check if tsnet is currently running.
     */
    fun isRunning(): Boolean {
        return try {
            Panvpn.isRunning()
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Make an HTTP request to the PAN server through the tailnet.
     */
    suspend fun serverRequest(context: Context, path: String): String = withContext(Dispatchers.IO) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val serverHostname = prefs.getString(KEY_SERVER_HOSTNAME, "pan-desktop") ?: "pan-desktop"
        Panvpn.dialHTTP(serverHostname, 7777, path)
    }

    /**
     * Make an HTTP request to a specific peer on the tailnet.
     */
    suspend fun request(context: Context, peerHostname: String, port: Int, path: String): String =
        withContext(Dispatchers.IO) {
            Panvpn.dialHTTP(peerHostname, port.toLong(), path)
        }

    fun setAuthKey(context: Context, authKey: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(KEY_AUTH_KEY, authKey).apply()
    }

    fun setHostname(context: Context, hostname: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(KEY_HOSTNAME, hostname).apply()
    }

    fun setServerHostname(context: Context, hostname: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(KEY_SERVER_HOSTNAME, hostname).apply()
    }

    fun getServerHostname(context: Context): String {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_SERVER_HOSTNAME, DEFAULT_SERVER_HOSTNAME) ?: DEFAULT_SERVER_HOSTNAME
    }

    /**
     * Auto-connect if previously enabled (call on app startup).
     */
    suspend fun autoConnect(context: Context) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (prefs.getBoolean(KEY_ENABLED, false)) {
            try {
                connect(context)
            } catch (e: Exception) {
                Log.w(TAG, "Auto-connect failed", e)
            }
        }
    }

    fun openLoginUrl(context: Context, url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}
