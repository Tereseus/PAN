package dev.pan.app.vpn

/**
 * After the network changes, the link must shake hands with the hub again on the new network.
 * In the car (Nov 21) the USB tether dropped, the unit moved to the phone's hotspot, and the app
 * said "not connected" until ΠAN was restarted by hand. [LinkManager] checks the link after a
 * change and restarts it when no handshake has come since the change.
 *
 * The app's own Tailscale is checked too (task 1100): on Nov 27 the car unit woke from a sleep
 * with its Tailscale dead since the morning, the link had no other way out of the car's network,
 * and the checks gave up after 10 minutes. Now they never stop while the link is down, only slow
 * down, and a dead Tailscale is restarted (same node, no new sign in).
 * Pure; tested in LinkRecoveryTest.
 */
object LinkRecovery {
    const val CHECK_MS = 15_000L
    /** Time the link gets after a change to shake hands on its own. */
    const val GRACE_MS = 20_000L
    /** At most one restart this often, so a dead network doesn't restart it in a loop. */
    const val RESTART_EVERY_MS = 60_000L
    /** At most one Tailscale restart this often (it takes up to about 15 s). */
    const val TAILSCALE_RESTART_EVERY_MS = 2 * 60_000L
    /** A gap this long between the clock that counts sleep and the one that doesn't: the device slept. */
    const val SLEEP_MS = 60_000L

    /** A handshake came after the change: [sinceHandshakeS] is -1 when there was none at all. */
    fun shookHandsSince(sinceHandshakeS: Long, sinceChangeMs: Long): Boolean =
        sinceHandshakeS >= 0 && sinceHandshakeS * 1000 < sinceChangeMs

    fun shouldRestart(sinceHandshakeS: Long, sinceChangeMs: Long, sinceRestartMs: Long): Boolean =
        sinceChangeMs >= GRACE_MS && !shookHandsSince(sinceHandshakeS, sinceChangeMs) && sinceRestartMs >= RESTART_EVERY_MS

    /** The next check: every 15 s for 10 minutes, every minute until 30, then every 5 minutes, never stopping. */
    fun nextCheckMs(sinceChangeMs: Long): Long = when {
        sinceChangeMs < 10 * 60_000L -> CHECK_MS
        sinceChangeMs < 30 * 60_000L -> 60_000L
        else -> 5 * 60_000L
    }

    /**
     * Tailscale needs a restart: off, not Running, no address, or the hub's Tailscale address did
     * not answer a ping ([pingMs] -1; -2 means there was nothing to ping). Waiting for a sign in
     * or the admin's approval is not something a restart fixes.
     */
    fun tailscaleUnhealthy(running: Boolean, state: String, ip: String, pingMs: Long): Boolean {
        if (state == "NeedsLogin" || state == "NeedsMachineAuth") return false
        return !running || state != "Running" || ip.isEmpty() || pingMs == -1L
    }

    /** At most every 2 minutes, slower as the checks slow down, so a car with no signal for hours isn't restarting it nonstop. */
    fun shouldRestartTailscale(unhealthy: Boolean, sinceChangeMs: Long, sinceTailscaleRestartMs: Long): Boolean =
        unhealthy && sinceChangeMs >= GRACE_MS &&
            sinceTailscaleRestartMs >= maxOf(TAILSCALE_RESTART_EVERY_MS, nextCheckMs(sinceChangeMs))

    /** How long the device slept between two ticks, from the gap between elapsedRealtime and uptimeMillis. */
    fun sleptMs(previousGapMs: Long, gapMs: Long): Long = gapMs - previousGapMs
}
