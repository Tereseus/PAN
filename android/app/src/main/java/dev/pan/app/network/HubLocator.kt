package dev.pan.app.network

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.net.HttpURLConnection
import java.net.URL
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Finds the PAN hub instead of assuming where it is.
 *
 * WHY THIS EXISTS (2026-08-10):
 * The hub moved from the Dell to the mini PC and the phone went dark for nine
 * days. Constants.DEFAULT_SERVER_URL was hardcoded to 192.168.1.248 in four
 * separate Kotlin files, and RemoteAccessManager._serverTailscaleHost — the one
 * variable actually designed to hold this — defaulted to "" and was never set
 * by anything. There was also no way to fix it from the phone: the hub cannot
 * push a new address to a device that does not know where the hub is, and the
 * phone exposes no inbound port (verified: every port closed over the tailnet).
 * So one wrong constant meant a rebuild.
 *
 * Resolution order, first that answers /health wins:
 *   1. lastGood      — whatever worked last time, persisted
 *   2. MagicDNS name — "pan-hub", stable across machines. Move the hub to a new
 *                      box, rename that box in the Tailscale admin console, and
 *                      the phone follows with no rebuild. This is the one you
 *                      want to be true.
 *   3. tsnet proxy   — RemoteAccessManager's local 127.0.0.1:<port> tunnel
 *   4. LAN fallbacks — only for when Tailscale is down on the same network
 *
 * Anything that answers /health also gets asked /api/v1/hub-address, so a stale
 * instance can redirect us to the real hub rather than silently serving an old
 * database.
 */
@Singleton
class HubLocator @Inject constructor(
    private val context: Context,
) {
    companion object {
        private const val TAG = "HubLocator"
        private const val PREFS = "pan_hub"
        private const val KEY_LAST_GOOD = "last_good_base_url"

        /** Stable MagicDNS name. Rename the hub machine to this in Tailscale. */
        const val MAGIC_DNS_NAME = "pan-hub"
        const val PORT = 7777

        /** Last-resort LAN guesses. Deliberately short — discovery, not a scan. */
        private val LAN_FALLBACKS = listOf(
            "http://192.168.1.83:$PORT",
            "http://192.168.1.248:$PORT",
        )

        private const val PROBE_TIMEOUT_MS = 2500L
    }

    private val prefs get() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Volatile private var cached: String? = null

    fun lastGood(): String? = prefs.getString(KEY_LAST_GOOD, null)

    private fun remember(baseUrl: String) {
        cached = baseUrl
        prefs.edit().putString(KEY_LAST_GOOD, baseUrl).apply()
        Log.i(TAG, "hub is $baseUrl")
    }

    /** Forget the cache so the next resolve() re-probes. Call on repeated failures. */
    fun invalidate() {
        cached = null
        prefs.edit().remove(KEY_LAST_GOOD).apply()
    }

    /**
     * Current best hub base URL, probing if needed.
     * @param proxyBase RemoteAccessManager.getTailscaleBaseUrl(), if the tsnet
     *                  proxy is up. Passed in rather than injected to avoid a
     *                  dependency cycle.
     */
    suspend fun resolve(proxyBase: String? = null): String? {
        cached?.let { return it }

        val candidates = buildList {
            lastGood()?.let { add(it) }
            proxyBase?.let { add(it) }
            add("http://$MAGIC_DNS_NAME:$PORT")
            addAll(LAN_FALLBACKS)
        }.distinct()

        for (base in candidates) {
            if (!probe(base)) continue
            // Ask it where the real hub is. An instance that knows it is not
            // canonical can hand us the right address.
            val canonical = askCanonical(base)
            val chosen = canonical ?: base
            if (chosen != base && !probe(chosen)) {
                remember(base); return base       // redirect was wrong, keep what works
            }
            remember(chosen)
            return chosen
        }
        Log.w(TAG, "no hub found among ${candidates.size} candidates")
        return null
    }

    private suspend fun probe(base: String): Boolean = withContext(Dispatchers.IO) {
        withTimeoutOrNull(PROBE_TIMEOUT_MS) {
            try {
                val c = (URL("$base/health").openConnection() as HttpURLConnection).apply {
                    connectTimeout = PROBE_TIMEOUT_MS.toInt()
                    readTimeout = PROBE_TIMEOUT_MS.toInt()
                    requestMethod = "GET"
                }
                val ok = c.responseCode in 200..299 &&
                    c.inputStream.bufferedReader().readText().contains("\"ok\"")
                c.disconnect()
                ok
            } catch (e: Exception) { false }
        } ?: false
    }

    private suspend fun askCanonical(base: String): String? = withContext(Dispatchers.IO) {
        withTimeoutOrNull(PROBE_TIMEOUT_MS) {
            try {
                val c = (URL("$base/api/v1/hub-address").openConnection() as HttpURLConnection).apply {
                    connectTimeout = PROBE_TIMEOUT_MS.toInt()
                    readTimeout = PROBE_TIMEOUT_MS.toInt()
                }
                if (c.responseCode !in 200..299) return@withTimeoutOrNull null
                val body = c.inputStream.bufferedReader().readText()
                c.disconnect()
                Regex("\"base_url\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
            } catch (e: Exception) { null }
        }
    }
}
