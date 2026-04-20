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
import dev.pan.app.di.TailscaleHostnameHolder
import kotlinx.coroutines.*
import panvpn.Panvpn

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
            if (vpnInterface == null) {
                vpnInterface = Builder()
                    .setSession("PAN Remote Access")
                    .addAddress("100.100.100.1", 32)
                    .addRoute("198.51.100.0", 24)
                    .addDnsServer("8.8.8.8")
                    .addDnsServer("1.1.1.1")
                    .setMtu(1280)
                    .setBlocking(false)
                    .establish()

                if (vpnInterface == null) {
                    Log.e(TAG, "VPN permission denied")
                    updateNotification("VPN permission denied")
                    stopSelf()
                    return
                }
                Log.i(TAG, "VPN interface established")
            }

            val prefs = getSharedPreferences("pan_vpn", Context.MODE_PRIVATE)
            // Human-readable hostname: "pan-pixel-10-pro" — recognizable in Tailscale admin
            // Uses device model name so you can identify every device at a glance
            val modelSlug = android.os.Build.MODEL.lowercase()
                .replace(Regex("[^a-z0-9]+"), "-")
                .trim('-')
            val hostname = "pan-$modelSlug"
            prefs.edit().putString("hostname", hostname).apply()
            val authKey = prefs.getString("auth_key", "") ?: ""

            // Use external storage for tsnet state — survives app reinstalls
            // This prevents creating a new Tailscale node identity on every install
            val externalDir = getExternalFilesDir("tsnet")
            val dataDir = if (externalDir != null && (externalDir.exists() || externalDir.mkdirs())) {
                Log.i(TAG, "Using external tsnet state: ${externalDir.absolutePath}")
                externalDir.absolutePath
            } else {
                Log.w(TAG, "External storage unavailable, falling back to internal")
                filesDir.absolutePath
            }

            os.Setenv("TMPDIR", dataDir)
            os.Setenv("HOME", dataDir)

            Log.i(TAG, "Starting tsnet as '$hostname'...")
            TailscaleHostnameHolder.hostname = hostname
            val result = Panvpn.start(dataDir, hostname, authKey)
            prefs.edit().putBoolean("enabled", true).apply()

            if (result.isNotEmpty()) {
                loginUrl = result
                Log.i(TAG, "Login required: $result")
                updateNotification("Login required - opening browser...")

                // Open login URL in browser
                try {
                    val loginIntent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(result))
                    loginIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(loginIntent)
                } catch (e: Exception) {
                    Log.e(TAG, "Couldn't open login URL: ${e.message}")
                }

                // Poll for login completion — check every 3 seconds for up to 2 minutes
                Log.i(TAG, "Waiting for login to complete...")
                updateNotification("Waiting for login...")
                var loggedIn = false
                for (attempt in 1..40) {
                    delay(3000)
                    try {
                        val status = Panvpn.getStatus()
                        if (status.connected && status.ip.isNotEmpty()) {
                            loggedIn = true
                            Log.i(TAG, "Login succeeded after ${attempt * 3}s, IP=${status.ip}")
                            loginUrl = null
                            break
                        }
                    } catch (_: Exception) {}
                }
                if (!loggedIn) {
                    Log.e(TAG, "Login timed out after 120s")
                    updateNotification("Login timed out")
                    return
                }
            }

            // Now connected (either no login needed, or login completed) — find the PAN server
            loginUrl = null
            val myIp = Panvpn.getStatus().ip
            val srvPort = getServerPort()
            Log.i(TAG, "Connected. Self=$myIp port=$srvPort")

            var serverHost = ""

            // 1. Try saved verified IP first (instant)
            val savedIp = prefs.getString("verified_server_ip", "") ?: ""
            if (savedIp.isNotEmpty() && savedIp != myIp) {
                Log.i(TAG, "Trying saved server $savedIp...")
                try {
                    val health = Panvpn.dialHTTP(savedIp, srvPort.toLong(), "/health")
                    if (health.isNotEmpty()) {
                        serverHost = savedIp
                        Log.i(TAG, "Saved server OK: $savedIp")
                    }
                } catch (_: Exception) {
                    Log.i(TAG, "Saved server $savedIp failed")
                }
            }

            // 2. Try pan-hub hostname
            if (serverHost.isEmpty()) {
                val hubIp = Panvpn.findServerIP("pan-hub")
                Log.i(TAG, "FindServerIP(pan-hub) = '$hubIp'")
                if (hubIp.isNotEmpty() && hubIp != myIp) {
                    try {
                        val health = Panvpn.dialHTTP(hubIp, srvPort.toLong(), "/health")
                        if (health.isNotEmpty()) {
                            serverHost = hubIp
                            Log.i(TAG, "pan-hub OK: $hubIp")
                        }
                    } catch (_: Exception) {}
                }
            }

            // 3. Scan all online peers
            if (serverHost.isEmpty()) {
                Log.i(TAG, "Scanning all peers...")
                val peers = Panvpn.listPeers()
                for (entry in peers.split("|")) {
                    val m = Regex("""(.+?)=(.+?)\((.+?)\)""").find(entry) ?: continue
                    val (name, ip, st) = m.destructured
                    if (st != "online" || ip == myIp || ip.isEmpty()) continue
                    try {
                        val h = Panvpn.dialHTTP(ip, srvPort.toLong(), "/health")
                        if (h.isNotEmpty()) {
                            serverHost = ip
                            Log.i(TAG, "Found: $name at $ip")
                            break
                        }
                    } catch (_: Exception) {}
                }
            }

            if (serverHost.isEmpty()) {
                Log.e(TAG, "No PAN server found")
                updateNotification("No server found")
                return
            }

            val proxyPort = Panvpn.startProxy(serverHost, srvPort.toLong())
            Log.i(TAG, "Proxy: localhost:$proxyPort -> $serverHost:$srvPort")
            prefs.edit().putString("verified_server_ip", serverHost).apply()
            updateNotification("Connected")
        } catch (e: Exception) {
            Log.e(TAG, "Connection failed", e)
            updateNotification("Error: ${e.message}")
        }
    }

    private fun getServerPort(): Int {
        return try {
            getSharedPreferences("pan_vpn", Context.MODE_PRIVATE).getInt("server_port", 7777)
        } catch (_: Exception) { 7777 }
    }

    private fun disconnect() {
        serviceScope.launch {
            try { Panvpn.stopProxy() } catch (_: Exception) {}
            try { Panvpn.stop() } catch (e: Exception) { Log.e(TAG, "Stop failed", e) }
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
        Log.w(TAG, "VPN revoked")
        disconnect()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "PAN VPN", NotificationManager.IMPORTANCE_LOW)
            .apply { description = "PAN remote access status" }
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
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

    private object os {
        fun Setenv(key: String, value: String) = System.setProperty(key, value)
    }
}
