package dev.pan.app.vpn

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.app.NotificationCompat
import dev.pan.app.R
import kotlinx.coroutines.*
import panvpn.Panvpn

/**
 * Android VpnService that establishes a TUN interface, granting the process
 * elevated network permissions (netlink access) required by tsnet/Tailscale.
 *
 * Without VpnService, SELinux blocks netlink_route_socket on Android,
 * causing tsnet to SIGABRT.
 */
class PanVpnService : VpnService() {

    companion object {
        private const val TAG = "PanVpnService"
        private const val CHANNEL_ID = "pan_vpn"
        private const val NOTIFICATION_ID = 2
        const val ACTION_CONNECT = "dev.pan.app.vpn.CONNECT"
        const val ACTION_DISCONNECT = "dev.pan.app.vpn.DISCONNECT"

        @Volatile
        var instance: PanVpnService? = null
            private set

        /** Returns null if already authorized, or an Intent for the VPN consent dialog. */
        fun prepare(context: Context): Intent? = VpnService.prepare(context)

        fun isEstablished(): Boolean = instance?.vpnInterface != null
    }

    private var vpnInterface: ParcelFileDescriptor? = null
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loginUrl: String? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_DISCONNECT -> {
                disconnect()
                return START_NOT_STICKY
            }
            else -> {
                startForeground(NOTIFICATION_ID, buildNotification("Connecting..."))
                serviceScope.launch { connect() }
                return START_STICKY
            }
        }
    }

    private suspend fun connect() {
        try {
            // Establish TUN interface — this grants the process VPN-level permissions
            if (vpnInterface == null) {
                vpnInterface = Builder()
                    .setSession("PAN Remote Access")
                    .addAddress("100.100.100.1", 32)
                    // Use a dummy route (RFC 5737 TEST-NET-2) — tsnet uses userspace
                    // networking and does NOT need TUN routing. The real Tailscale CGNAT
                    // range (100.64.0.0/10) was black-holing tsnet's own Dial() calls.
                    .addRoute("198.51.100.0", 24)
                    .setMtu(1280)
                    .setBlocking(false)
                    .establish()

                if (vpnInterface == null) {
                    Log.e(TAG, "VPN establish() returned null — user may not have granted permission")
                    updateNotification("VPN permission denied")
                    stopSelf()
                    return
                }
                Log.i(TAG, "VPN interface established — netlink now available")
            }

            // Now start tsnet with the elevated permissions
            val prefs = getSharedPreferences("pan_vpn", Context.MODE_PRIVATE)
            val hostname = prefs.getString("hostname", "pan-phone") ?: "pan-phone"
            val authKey = prefs.getString("auth_key", "") ?: ""
            val dataDir = filesDir.absolutePath

            Log.i(TAG, "Starting tsnet as '$hostname'...")
            val result = Panvpn.start(dataDir, hostname, authKey)

            prefs.edit().putBoolean("enabled", true).apply()

            if (result.isNotEmpty()) {
                loginUrl = result
                Log.i(TAG, "Login required: $result")
                updateNotification("Waiting for login...")
            } else {
                loginUrl = null
                // Start local proxy that tunnels through tsnet to the PAN server
                val serverHost = prefs.getString("server_hostname", "tedgl") ?: "tedgl"
                try {
                    val proxyPort = Panvpn.startProxy(serverHost, 7777)
                    Log.i(TAG, "Proxy started on localhost:$proxyPort → $serverHost:7777")
                } catch (e: Exception) {
                    Log.e(TAG, "Proxy start failed: ${e.message}")
                }
                Log.i(TAG, "Connected to tailnet")
                updateNotification("Connected")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Connection failed", e)
            updateNotification("Error: ${e.message}")
            // Don't stop the service — let the user see the error and retry
        }
    }

    private fun disconnect() {
        serviceScope.launch {
            try { Panvpn.stopProxy() } catch (_: Exception) {}
            try {
                Panvpn.stop()
            } catch (e: Exception) {
                Log.e(TAG, "Stop failed", e)
            }
            getSharedPreferences("pan_vpn", Context.MODE_PRIVATE)
                .edit().putBoolean("enabled", false).apply()
        }
        vpnInterface?.close()
        vpnInterface = null
        loginUrl = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    fun getLoginUrl(): String? = loginUrl

    override fun onDestroy() {
        serviceScope.cancel()
        try { Panvpn.stop() } catch (_: Exception) {}
        vpnInterface?.close()
        vpnInterface = null
        instance = null
        super.onDestroy()
    }

    override fun onRevoke() {
        Log.w(TAG, "VPN revoked by system")
        disconnect()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID, "PAN VPN",
            NotificationManager.IMPORTANCE_LOW
        ).apply { description = "PAN remote access VPN status" }
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
            .createNotificationChannel(channel)
    }

    private fun buildNotification(status: String) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("PAN Remote Access")
            .setContentText(status)
            .setOngoing(true)
            .build()

    private fun updateNotification(status: String) {
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIFICATION_ID, buildNotification(status))
    }
}
