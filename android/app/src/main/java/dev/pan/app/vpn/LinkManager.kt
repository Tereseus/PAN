package dev.pan.app.vpn

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject
import panvpn.Panvpn
import javax.inject.Inject
import javax.inject.Singleton

/**
 * PAN Link on the phone: plain WireGuard to the hub (pan-link, docs/INSTALL-PLAN.md).
 *
 * The phone pairs once with the text of the hub's pairing QR (a pan://pair link, handled
 * by PairActivity). After that the link gives the app a local port that forwards to PAN on
 * the hub, used exactly like the Tailscale proxy port, and PAN knows which device is
 * calling from the link's key instead of trusting addresses.
 *
 * It needs only internet access, not the VPN permission. Packets for the hub's Tailscale
 * address go through the app's own Tailscale (tsnet) when it runs, which on home Wi-Fi
 * that keeps devices apart, or away from a home that lets nothing in, is the only way.
 */
@Singleton
class LinkManager @Inject constructor(
    @ApplicationContext private val context: Context,
    // Lazy: the log shipper sends through the HTTP client, whose hub finder asks this class.
    private val logShipper: dagger.Lazy<dev.pan.app.network.LogShipper>,
) {
    companion object {
        private const val TAG = "PanLink"
        /** How long a status check is trusted, so per-request callers stay cheap. */
        private const val STATUS_TTL_MS = 2_000L
    }

    /** The pairing holds the phone's private key, so it stays in app-private storage. */
    private val dataDir: String get() = context.filesDir.absolutePath

    private val _port = MutableStateFlow(0)
    /** The link's local port, 0 while it is down. */
    val port: StateFlow<Int> = _port

    @Volatile private var lastCheck = 0L
    @Volatile private var lastConnected = false
    @Volatile private var lastState = ""
    @Volatile private var lastLookup = ""
    @Volatile private var lastMeet = ""
    @Volatile private var callbackRegistered = false

    /**
     * Logs a link event here and on the hub (PAN's /api/v1/logs, source "pan-link"), so a
     * test away from home can be read back afterwards. Unsent lines wait for the hub.
     */
    private fun note(msg: String) {
        Log.i(TAG, msg)
        runCatching { logShipper.get().info("pan-link", msg) }
    }

    fun isPaired(): Boolean = runCatching { Panvpn.linkPaired(dataDir) }.getOrDefault(false)

    /** Starts the link if this phone is paired. Safe to call again; returns the port or 0. */
    @Synchronized
    fun startIfPaired(): Int {
        if (!isPaired()) return 0
        return try {
            val p = Panvpn.linkStart(dataDir).toInt()
            if (_port.value != p) note("link up, local port $p")
            _port.value = p
            registerNetworkCallback()
            p
        } catch (e: Exception) {
            note("link start failed: ${e.message}")
            0
        }
    }

    /**
     * Pairs with a pan://pair code, then starts the link. Blocking: call it off the main
     * thread. Returns the device id the hub gave this phone.
     */
    fun pair(code: String): String {
        waitForTailscale()
        val name = android.os.Build.MODEL
        val id = Panvpn.linkPair(dataDir, code, name)
        note("paired as $id ($name)")
        startIfPaired()
        return id
    }

    /**
     * Pairs through the app's current way to PAN (the Tailscale proxy at [baseUrl]): PAN
     * asks pan-link on the hub for a code (POST /api/v1/link/pair, owner only) and this
     * phone uses it at once, so a phone that already reaches PAN needs no QR. Blocking:
     * call it off the main thread. Returns the device id the hub gave this phone.
     */
    fun pairThroughPan(baseUrl: String): String {
        val name = android.os.Build.MODEL
        val c = java.net.URL("$baseUrl/api/v1/link/pair").openConnection() as java.net.HttpURLConnection
        try {
            c.requestMethod = "POST"
            c.doOutput = true
            c.connectTimeout = 10_000
            c.readTimeout = 20_000
            c.setRequestProperty("Content-Type", "application/json")
            c.setRequestProperty("X-Device-Name", name)
            c.outputStream.use { it.write(JSONObject().put("name", name).toString().toByteArray()) }
            val status = c.responseCode
            val body = (if (status in 200..299) c.inputStream else c.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            val json = runCatching { JSONObject(body) }.getOrNull()
            if (status != 200 || json == null || !json.has("uri")) {
                throw IllegalStateException(json?.optString("error")?.ifBlank { null } ?: "PAN answered $status")
            }
            note("pairing code from PAN, pairing")
            return pair(json.getString("uri"))
        } finally {
            c.disconnect()
        }
    }

    /**
     * The hub's Tailscale address may be the only way in, and the app's Tailscale starts
     * with the app. When remote access is on but not up yet, give it a moment first.
     */
    private fun waitForTailscale() {
        val wanted = context.getSharedPreferences("pan_vpn", Context.MODE_PRIVATE)
            .getBoolean("enabled", false)
        if (!wanted) return
        val until = SystemClock.elapsedRealtime() + 20_000
        while (SystemClock.elapsedRealtime() < until) {
            val up = runCatching { Panvpn.isRunning() && Panvpn.getStatus().connected }.getOrDefault(false)
            if (up) return
            Thread.sleep(500)
        }
        Log.w(TAG, "Tailscale not up after 20 s; pairing over the other addresses")
    }

    /** JSON from the Go side: paired, running, device_id, port, via, since_handshake_s, connected. */
    fun status(): String = runCatching { Panvpn.linkStatus(dataDir) }.getOrDefault("{}")

    /**
     * The local port's URL while the link has had a handshake with the hub in the last
     * three minutes, else null (callers then use the Tailscale proxy as before).
     */
    fun baseUrlIfConnected(): String? {
        val p = _port.value
        if (p <= 0) return null
        val now = SystemClock.elapsedRealtime()
        if (now - lastCheck > STATUS_TTL_MS) {
            lastCheck = now
            val s = runCatching { JSONObject(status()) }.getOrNull()
            lastConnected = s?.optBoolean("connected") ?: false
            val state = if (lastConnected) "connected, ${s?.optString("path")} path ${s?.optString("via")}" else "not connected"
            if (state != lastState) {
                lastState = state
                note("link $state")
            }
            // When the hub can't be reached on any saved address, the link looks it up
            // through its address record (pan-link record.go); say what that found.
            val lookup = s?.optString("lookup").orEmpty()
            if (lookup.isNotEmpty() && lookup != lastLookup) {
                lastLookup = lookup
                note("address record: $lookup")
            }
            // Meeting in the middle (pan-link punch.go): this phone's outside address and
            // what the link last did about it, so the hub's log shows it.
            val meet = listOf(s?.optString("outside").orEmpty(), if (s?.optBoolean("hard") == true) "hard network" else "",
                s?.optString("meet").orEmpty()).filter { it.isNotEmpty() }.joinToString("; ")
            if (meet.isNotEmpty() && meet != lastMeet) {
                lastMeet = meet
                note("meet: $meet")
            }
        }
        return if (lastConnected) "http://127.0.0.1:$p" else null
    }

    /** Which way the link goes while connected ("over your home network"...), else null. */
    fun pathWords(): String? {
        val s = runCatching { JSONObject(status()) }.getOrNull() ?: return null
        if (!s.optBoolean("connected")) return null
        return when (s.optString("path")) {
            "local" -> "over your home network"
            "tailscale" -> "through the backup route"
            "internet" -> "over the internet"
            else -> null
        }
    }

    /** One plain line for the app's screens: whether the link works and which way it goes. */
    fun summary(): String {
        if (!isPaired()) return "Not paired. Open the pairing code from PAN on your computer on this phone."
        val s = runCatching { JSONObject(status()) }.getOrNull() ?: return "Paired. Status unknown."
        val hub = "\"" + s.optString("hub_name").ifBlank { "your PAN computer" } + "\""
        if (!s.optBoolean("running")) return "Paired with $hub. Starting…"
        val since = s.optLong("since_handshake_s", -1)
        if (!s.optBoolean("connected")) {
            val last = if (since >= 0) " Last contact ${ago(since)}." else ""
            // "away": pan-link's own words for why (link.AwayWords): finding a direct way,
            // or this network cannot reach the home at all.
            val away = s.optString("away").ifBlank { "The app uses the backup route meanwhile." }
            return "Paired with $hub, but not reaching it.$last $away"
        }
        val way = when (s.optString("path")) {
            "local" -> " over your home network"
            "tailscale" -> " through the backup route"
            "internet" -> " directly, from outside your home"
            else -> ""
        }
        return "Connected to $hub$way. Last handshake ${ago(since)}."
    }

    private fun ago(s: Long): String = if (s < 90) "$s s ago" else "${s / 60} min ago"

    /** Stops the link and deletes this phone's pairing. */
    fun forget() {
        runCatching { Panvpn.linkForget(dataDir) }
        _port.value = 0
        lastConnected = false
        Log.i(TAG, "pairing forgotten")
    }

    /** Network events arrive and are acted on here, off the main thread. */
    private val netHandler by lazy {
        Handler(HandlerThread("PanLinkNet").apply { start() }.looper)
    }

    private val moveLink = Runnable {
        runCatching { Panvpn.linkNetworkChanged() }
        lastCheck = 0L
    }

    /**
     * When the phone changes networks (leaves home Wi-Fi, mobile data comes back), move the
     * link to whichever hub address works now. Without this it still moves, after ~15 s.
     * It follows the network the phone's own traffic uses (the best one that isn't a VPN),
     * so a second network coming and going in the background (mobile data that keeps
     * failing to connect, say) doesn't touch a link that works.
     */
    private fun registerNetworkCallback() {
        if (callbackRegistered) return
        callbackRegistered = true
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        try {
            cm.registerBestMatchingNetworkCallback(request, object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = changed("now on ${describe(cm, network)}")
                override fun onLost(network: Network) = changed("lost")
            }, netHandler)
        } catch (e: Exception) {
            callbackRegistered = false
            Log.w(TAG, "network callback not registered: ${e.message}")
        }
    }

    private fun describe(cm: ConnectivityManager, network: Network): String {
        val caps = runCatching { cm.getNetworkCapabilities(network) }.getOrNull() ?: return "network $network"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile data"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Ethernet"
            else -> "network $network"
        }
    }

    /**
     * The app's own Tailscale just came up, so the hub's Tailscale addresses work now.
     * Away from home they are the only way in, and the link's first tries went out before
     * Tailscale could carry them; without this the link waits for WireGuard's next try.
     */
    fun tailscaleReady() {
        if (_port.value > 0) changed("Tailscale up")
    }

    /**
     * One switch fires several events (the old network lost, the new one available). The
     * link moves once, half a second after the last of them, when the new routes are in.
     */
    private fun changed(why: String) {
        note("network: $why")
        netHandler.removeCallbacks(moveLink)
        netHandler.postDelayed(moveLink, 500)
        changedAt = android.os.SystemClock.elapsedRealtime()
        netHandler.removeCallbacks(recheck)
        netHandler.postDelayed(recheck, LinkRecovery.CHECK_MS)
    }

    /** Debug builds only (TEST_NET_CHANGE): a network change, and with dead=true the next check sees no handshake. */
    @Volatile private var testDeadOnce = false
    fun testNetworkChange(dead: Boolean) {
        testDeadOnce = dead
        changed("test change${if (dead) " (link treated as dead)" else ""}")
        if (dead) changedAt -= LinkRecovery.GRACE_MS
    }

    @Volatile private var changedAt = 0L
    @Volatile private var restartedAt = 0L

    /**
     * After a network change: logs how the link stands, and restarts it when it has not shaken
     * hands with the hub since the change (LinkRecovery). Runs every 15 s until a handshake
     * comes or 10 minutes have passed.
     */
    private val recheck: Runnable = object : Runnable {
        override fun run() {
            if (_port.value <= 0) return
            val now = android.os.SystemClock.elapsedRealtime()
            val sinceChange = now - changedAt
            val s = runCatching { org.json.JSONObject(status()) }.getOrNull() ?: return
            val hs = if (testDeadOnce) { testDeadOnce = false; -1L } else s.optLong("since_handshake_s", -1)
            if (LinkRecovery.shookHandsSince(hs, sinceChange)) {
                note("link connected after the network change, ${s.optString("path")} path ${s.optString("via")}")
                return
            }
            note("link: no handshake ${sinceChange / 1000} s after the network change (last ${if (hs < 0) "never" else "$hs s ago"}), via ${s.optString("via")}")
            if (LinkRecovery.shouldRestart(hs, sinceChange, now - restartedAt)) {
                restartedAt = now
                note("link: restarting it on the new network")
                synchronized(this@LinkManager) {
                    runCatching { Panvpn.linkStop() }
                    _port.value = 0
                    lastCheck = 0L
                }
                startIfPaired()
            }
            if (sinceChange < LinkRecovery.GIVE_UP_MS) netHandler.postDelayed(this, LinkRecovery.CHECK_MS)
        }
    }
}
