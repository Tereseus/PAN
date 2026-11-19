package dev.pan.app.vpn

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import dev.pan.app.R
import dev.pan.app.di.TailscaleHostnameHolder
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.*
import panvpn.Panvpn

/**
 * Runs the app's own Tailscale (tsnet, userspace) as a foreground service.
 *
 * It was an Android VpnService until 0.4.98, with a dummy interface (100.100.100.1,
 * a route to 198.51.100.0/24 only) that carried nothing: tsnet keeps its own network
 * stack and plain sockets, and never needed netlink (panvpn.go reads interfaces through
 * anet). The dummy still cost a lot: Android blocked IPv6 for every app on the phone,
 * PAN Link's own IPv6 path included (its table had only "unreachable default"), it took
 * the phone's one VPN slot, and it needed a VPN consent dialog.
 */
@AndroidEntryPoint
class PanVpnService : Service() {

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

    }

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loginUrl: String? = null
    /** PAN Link was told this Tailscale is up (once per start: each telling makes it handshake again). */
    @Volatile private var tailscaleAnnounced = false

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

    override fun onBind(intent: Intent?): IBinder? = null

    private suspend fun connect() {
        try {
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
            // The retry below comes back here with Tailscale already running. Starting it
            // again throws "already running", which ended the retries and left
            // "Error: already running" on the notification.
            var result = if (Panvpn.isRunning()) "" else Panvpn.start(dataDir, hostname, authKey)
            prefs.edit().putBoolean("enabled", true).apply()

            // A key from the hub (PAN Link hands one out) but Tailscale is stuck on an old login:
            // waiting for a sign-in, or signed in and waiting for the admin's approval. Tailscale
            // ignores a key then, so start it fresh with the key. The owner, Nov 15: people must never
            // see Tailscale; the OnePlus Pad sat in NeedsMachineAuth with a fresh key unused.
            if (authKey.isNotEmpty()) {
                var state = ""
                for (i in 1..10) {
                    state = try { PanVpn.getStatus().state } catch (_: Exception) { "" }
                    if (state == "Running" || state == "NeedsLogin" || state == "NeedsMachineAuth") break
                    delay(500)
                }
                if (state == "NeedsLogin" || state == "NeedsMachineAuth") {
                    Log.i(TAG, "Tailscale $state with a key from the hub: starting fresh with the key")
                    runCatching { Panvpn.stop() }
                    java.io.File(dataDir, "tailscale/tailscaled.state").delete()
                    delay(500)
                    result = Panvpn.start(dataDir, hostname, authKey)
                }
                // Single use: never try it again after this start.
                prefs.edit().remove("auth_key").apply()
            }

            if (result.isNotEmpty()) {
                // No key and Tailscale wants a sign-in. Nobody is asked: PAN Link is the way in,
                // and Tailscale stays off until the hub can hand this device a key. The link is
                // only for Settings > Advanced.
                loginUrl = result
                Log.i(TAG, "Tailscale needs a sign-in; waiting for a key from the hub instead")
                updateNotification("PAN Link only")
                var loggedIn = false
                for (attempt in 1..40) {
                    delay(3000)
                    try {
                        val status = Panvpn.getStatus()
                        if (status.connected && status.ip.isNotEmpty()) {
                            loggedIn = true
                            Log.i(TAG, "Tailscale signed in after ${attempt * 3}s, IP=${status.ip}")
                            loginUrl = null
                            break
                        }
                    } catch (_: Exception) {}
                }
                if (!loggedIn) {
                    Log.i(TAG, "Tailscale still not signed in; PAN Link only")
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

            // PAN Link's packets for the hub's Tailscale addresses ride on this Tailscale and
            // need nothing below: the hub's port $srvPort may not answer over Tailscale at all
            // (PAN_HOST=127.0.0.1 on the hub). Tell the link now, not after finding that port.
            if (!tailscaleAnnounced) {
                tailscaleAnnounced = true
                remoteAccessManager.link.tailscaleReady()
            }

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

            // 2. The person's own tailnet is asked, machine by machine. (Two names of the first
            // hub were tried before this until 0.5.40; the scan finds any hub, whatever it is called.)
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

            if (serverHost.isEmpty() && remoteAccessManager.link.isPaired()) {
                // PAN Link is the way in, and this port is only a backup that a hub with
                // PAN_HOST=127.0.0.1 never answers. Retrying would scan every Tailscale
                // peer every 15 s for nothing.
                Log.i(TAG, "PAN doesn't answer on port $srvPort over Tailscale; PAN Link carries everything")
                updateNotification("Connected")
                return
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
        tailscaleAnnounced = false
        serviceScope.launch {
            try { Panvpn.stopProxy() } catch (_: Exception) {}
            try { Panvpn.stop() } catch (e: Exception) { Log.e(TAG, "Stop failed", e) }
            getSharedPreferences("pan_vpn", Context.MODE_PRIVATE)
                .edit().putBoolean("enabled", false).apply()
        }
        loginUrl = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    fun getLoginUrl(): String? = loginUrl

    override fun onDestroy() {
        serviceScope.cancel()
        try { Panvpn.stop() } catch (_: Exception) {}
        instance = null
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "ΠAN connection", NotificationManager.IMPORTANCE_LOW)
            .apply { description = "The secure route to your computer" }
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
    }

    private fun buildNotification(status: String) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("ΠAN connection")
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
