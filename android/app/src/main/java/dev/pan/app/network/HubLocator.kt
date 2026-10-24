package dev.pan.app.network

import android.content.Context
import android.os.SystemClock
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Finds the PAN hub instead of assuming where it is.
 *
 * WHY THIS EXISTS (2026-08-10):
 * The hub moved from the Dell to the mini PC and the phone went dark for nine
 * days. 192.168.1.248 was hardcoded in four Kotlin files, and
 * RemoteAccessManager._serverTailscaleHost — the one variable designed to hold
 * this — defaulted to "" and was never called by anything.
 *
 * It was also unrecoverable from the phone: the hub cannot push a new address
 * to a device that does not know where the hub is, and the phone exposes no
 * inbound port (verified over the tailnet — every port closed, no ICMP, no
 * device record). One wrong constant meant an APK rebuild.
 *
 * Resolution order, first that answers /health wins:
 *   1. lastGood      — whatever worked last time, persisted across launches
 *   2. tsnet proxy   — RemoteAccessManager's 127.0.0.1:<port> tunnel
 *   3. MagicDNS      — "pan-hub". Move the hub to another machine, rename that
 *                      machine in Tailscale, every client follows. No rebuild.
 *   4. LAN fallbacks — for when Tailscale is down on the same network
 *
 * Whatever answers is also asked /api/v1/hub-address, so a stale instance can
 * redirect us to the real hub rather than quietly serving an old database.
 *
 * SYNCHRONOUS ON PURPOSE. This is called from an OkHttp Interceptor, which is
 * blocking and already runs off the main thread. A suspend API would force
 * runBlocking at the call site, which is strictly worse.
 */
@Singleton
class HubLocator @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    companion object {
        private const val TAG = "HubLocator"
        private const val PREFS = "pan_hub"
        private const val KEY_LAST_GOOD = "last_good_base_url"

        /** Stable MagicDNS name. Rename the hub machine to this in Tailscale. */
        const val MAGIC_DNS_NAME = "pan-hub"
        const val PORT = 7777

        /** Last-resort guesses. Deliberately short — discovery, not a subnet scan. */
        private val LAN_FALLBACKS = listOf(
            "http://192.168.1.83:$PORT",
            "http://192.168.1.248:$PORT",
        )

        private const val PROBE_TIMEOUT_MS = 2500

        /** Consecutive failures before we stop trusting the cached address. */
        private const val FAILURES_BEFORE_REPROBE = 3

        /**
         * How long to stay quiet after a full scan came up empty.
         *
         * A scan that just failed will fail again for the same reason (hub off,
         * wrong network). Without this, every caller re-walks all candidates at
         * PROBE_TIMEOUT_MS each, forever. Observed 2026-09-11 with the hub
         * powered off: five threads each scanning every ~5s, indefinitely.
         */
        private const val EMPTY_SCAN_BACKOFF_MS = 20_000L
    }

    private val prefs by lazy { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    @Volatile private var cached: String? = null
    private val consecutiveFailures = AtomicInteger(0)
    private var lastScanProxy: String? = null

    /** Serialises discovery so N concurrent callers cause ONE scan, not N. */
    private val probeLock = Any()
    @Volatile private var lastEmptyScanAt = 0L

    init {
        // Older builds persisted the per-session proxy port. Clear it once at
        // startup so an upgraded install does not keep probing a dead port.
        forgetStaleProxy()
    }

    fun lastGood(): String? = cached ?: prefs.getString(KEY_LAST_GOOD, null)

    private fun remember(baseUrl: String) {
        cached = baseUrl
        consecutiveFailures.set(0)
        lastEmptyScanAt = 0L
        // NEVER persist the tsnet proxy address. Its port is assigned fresh on
        // every VPN start (34877 one run, 44497 the next), so writing it here
        // meant the FIRST candidate on every later scan was a port nothing was
        // listening on. That cost a 2.5s probe, then the LAN fallbacks that AP
        // client isolation blocks, then "no hub found" and a 20s backoff - which
        // is the disconnected/connected/disconnected flapping. The live proxy is
        // always passed in as proxyBase anyway, so caching it buys nothing and
        // costs a guaranteed miss.
        if (isEphemeralLoopback(baseUrl)) {
            Log.i(TAG, "hub is $baseUrl (proxy — not persisted, port is per-session)")
        } else {
            prefs.edit().putString(KEY_LAST_GOOD, baseUrl).apply()
            Log.i(TAG, "hub is $baseUrl")
        }
    }

    private fun isEphemeralLoopback(url: String): Boolean =
        url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")

    /**
     * Drop a stale persisted proxy address written by an older build. Without
     * this the bad value survives upgrades and keeps costing a probe.
     */
    fun forgetStaleProxy() {
        val saved = prefs.getString(KEY_LAST_GOOD, null) ?: return
        if (isEphemeralLoopback(saved)) {
            prefs.edit().remove(KEY_LAST_GOOD).apply()
            Log.i(TAG, "dropped stale per-session proxy address $saved")
        }
    }

    /**
     * Report a failed call. After enough in a row the cache is dropped so the
     * next resolve() re-probes. This is what turns "wrong address = dead
     * forever, reopen the app" into "recovers on its own within a poll cycle".
     */
    fun reportFailure(addressLooksWrong: Boolean = true) {
        // A slow hub is not a wrong hub. A read timeout (the hub taking 30s to
        // answer a query) used to count here, so three slow answers threw away a
        // perfectly good address and forced a re-probe - turning one slow reply
        // into a disconnect. Only failures that mean "nothing is listening at
        // this address" should invalidate it.
        if (!addressLooksWrong) return
        if (consecutiveFailures.incrementAndGet() >= FAILURES_BEFORE_REPROBE) {
            Log.w(TAG, "$FAILURES_BEFORE_REPROBE consecutive failures — re-probing")
            cached = null
            consecutiveFailures.set(0)
        }
    }

    fun reportSuccess() = consecutiveFailures.set(0)

    /**
     * Best hub base URL, probing only when the cache is empty.
     * @param proxyBase RemoteAccessManager.getTailscaleBaseUrl() when the tsnet
     *                  proxy is up. Passed in rather than injected to avoid a
     *                  dependency cycle (RemoteAccessManager -> OkHttp -> here).
     */
    fun resolve(proxyBase: String? = null): String? {
        cached?.let { return it }

        // Discovery is serialised. resolve() is called from an OkHttp
        // Interceptor, so every in-flight request arrives here at once; before
        // this lock each of them independently walked all candidates at
        // PROBE_TIMEOUT_MS apiece, so one dead hub cost N x 4 x 2.5s of blocked
        // threads and burned battery in a loop that never backed off.
        synchronized(probeLock) {
            // Someone may have found it while we waited for the lock.
            cached?.let { return it }

            val sinceEmpty = SystemClock.elapsedRealtime() - lastEmptyScanAt
            // The backoff means "everything I could try failed, stop burning
            // battery". A proxy address that was NOT available last time is new
            // information, not a retry, so it must not be held behind that
            // timer - the whole reason the last scan failed is that this
            // candidate did not exist yet.
            val haveNewProxy = proxyBase != null && proxyBase != lastScanProxy
            if (lastEmptyScanAt != 0L && sinceEmpty < EMPTY_SCAN_BACKOFF_MS && !haveNewProxy) {
                return null
            }
            return scan(proxyBase)
        }
    }

    /** Caller MUST hold probeLock. */
    private fun scan(proxyBase: String?): String? {
        val candidates = buildList {
            prefs.getString(KEY_LAST_GOOD, null)?.let { add(it) }
            proxyBase?.let { add(it) }
            add("http://$MAGIC_DNS_NAME:$PORT")
            addAll(LAN_FALLBACKS)
        }.distinct()

        for (base in candidates) {
            if (!probe(base)) continue
            val canonical = askCanonical(base)
            if (canonical != null && canonical != base && probe(canonical)) {
                remember(canonical); return canonical
            }
            remember(base); return base
        }
        lastScanProxy = proxyBase
        // Only arm the long backoff if the scan was actually complete. With the
        // proxy still starting up, the candidate most likely to work was not in
        // the list, so going quiet for 20s punishes the VPN for being slow.
        lastEmptyScanAt = if (proxyBase != null) SystemClock.elapsedRealtime() else 0L
        Log.w(TAG, "no hub found among ${candidates.size} candidates" +
            if (proxyBase != null) "; quiet for ${EMPTY_SCAN_BACKOFF_MS / 1000}s"
            else " (proxy not up yet — will retry immediately)")
        return null
    }

    private fun probe(base: String): Boolean = try {
        val c = (URL("$base/health").openConnection() as HttpURLConnection).apply {
            connectTimeout = PROBE_TIMEOUT_MS
            readTimeout = PROBE_TIMEOUT_MS
            requestMethod = "GET"
        }
        val ok = c.responseCode in 200..299 &&
            c.inputStream.bufferedReader().use { it.readText() }.contains("\"ok\"")
        c.disconnect()
        ok
    } catch (e: Exception) { false }

    private fun askCanonical(base: String): String? = try {
        val c = (URL("$base/api/v1/hub-address").openConnection() as HttpURLConnection).apply {
            connectTimeout = PROBE_TIMEOUT_MS
            readTimeout = PROBE_TIMEOUT_MS
        }
        val body = if (c.responseCode in 200..299)
            c.inputStream.bufferedReader().use { it.readText() } else ""
        c.disconnect()
        Regex("\"base_url\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
    } catch (e: Exception) { null }
}
