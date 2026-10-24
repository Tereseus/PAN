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
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.*
import panvpn.Panvpn

@AndroidEntryPoint
class PanVpnService : VpnService() {

    // The service is the ONLY thing that knows the proxy port, and it never told
    // anyone. Every caller of refreshFromVpn() lived in a ViewModel, so the port
    // was learned only while the UI happened to be open; in the background
    // getTailscaleBaseUrl() stayed null, HubLocator lost its proxy candidate and
    // fell back to LAN addresses that AP isolation blocks, failed three times,
    // re-probed, and repeated forever. That is the connect/disconnect churn.
    @Inject lateinit var remoteAccessManager: RemoteAccessManager

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
            val srvPort = getServerPort()

            // WAIT for tsnet to actually come up before discovering anything.
            //
            // getStatus().ip is empty until the netmap arrives. Discovery used to run
            // immediately, so every step failed in MILLISECONDS - saved server in 1ms,
            // peer scan in 4ms - not because the hub was absent but because there was
            // no network yet. It then logged 'No PAN server found' and RETURNED,
            // so startProxy() never ran, proxy stayed 0, and the app fell back to
            // LAN-only forever. Observed 2026-09-15: tsnet reported its IP a full two
            // seconds AFTER discovery had already given up.
            var myIp = ""
            for (attempt in 1..40) {
                myIp = try { Panvpn.getStatus().ip } catch (_: Exception) { "" }
                if (myIp.isNotEmpty()) break
                delay(500)
            }
            if (myIp.isEmpty()) {
                Log.e(TAG, "tsnet never reported an IP after 20s")
                updateNotification("Tailscale did not come up")
                return
            }
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
                // 'pan-hub' is the name the hub SHOULD have; 'minipc-pan-hub' is what
                // the machine is actually called in Tailscale today. Trying only the
                // aspirational name meant this step never once succeeded.
                var hubIp = Panvpn.findServerIP("pan-hub")
                if (hubIp.isEmpty()) hubIp = Panvpn.findServerIP("minipc-pan-hub")
                Log.i(TAG, "FindServerIP = '$hubIp'")
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
                // Peers can take a while to populate even after the IP appears, and a
                // hub that is briefly down should not disable remote access until the
                // next manual reconnect. Retry rather than returning.
                Log.w(TAG, "No PAN server found; retrying in 15s")
                updateNotification("Looking for the hub...")
                delay(15_000)
                serviceScope.launch { connect() }
                return
            }

            val proxyPort = Panvpn.startProxy(serverHost, srvPort.toLong())
            Log.i(TAG, "Proxy: localhost:$proxyPort -> $serverHost:$srvPort")

            // Publish it. refreshFromVpn() reads the live port, ip and org and is
            // what flips status to "Connected" - which getTailscaleBaseUrl()
            // requires before HubLocator will even consider the proxy.
            try {
                remoteAccessManager.refreshFromVpn()
                Log.i(TAG, "Published proxy to RemoteAccessManager: ${remoteAccessManager.getTailscaleBaseUrl()}")
            } catch (e: Exception) {
                Log.w(TAG, "Could not publish proxy port: ${e.message}")
            }
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
