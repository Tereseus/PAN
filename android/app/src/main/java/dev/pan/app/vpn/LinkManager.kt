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
    @Volatile private var callbackRegistered = false

    fun isPaired(): Boolean = runCatching { Panvpn.linkPaired(dataDir) }.getOrDefault(false)

    /** Starts the link if this phone is paired. Safe to call again; returns the port or 0. */
    @Synchronized
    fun startIfPaired(): Int {
        if (!isPaired()) return 0
        return try {
            val p = Panvpn.linkStart(dataDir).toInt()
            if (_port.value != p) Log.i(TAG, "link up, local port $p")
            _port.value = p
            registerNetworkCallback()
            p
        } catch (e: Exception) {
            Log.e(TAG, "link start failed: ${e.message}")
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
        Log.i(TAG, "paired as $id ($name)")
        startIfPaired()
        return id
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
            val was = lastConnected
            lastConnected = runCatching { JSONObject(status()).optBoolean("connected") }.getOrDefault(false)
            if (was != lastConnected) Log.i(TAG, if (lastConnected) "link connected: ${status()}" else "link not connected")
        }
        return if (lastConnected) "http://127.0.0.1:$p" else null
    }

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
        Log.i(TAG, "network: $why")
        netHandler.removeCallbacks(moveLink)
        netHandler.postDelayed(moveLink, 500)
    }
}
