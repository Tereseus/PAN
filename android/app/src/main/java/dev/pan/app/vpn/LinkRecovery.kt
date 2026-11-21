package dev.pan.app.vpn

/**
 * After the network changes, the link must shake hands with the hub again on the new network.
 * In the car (Nov 21) the USB tether dropped, the unit moved to the phone's hotspot, and the app
 * said "not connected" until ΠAN was restarted by hand. [LinkManager] checks the link every
 * [CHECK_MS] after a change and restarts it when no handshake has come since the change.
 * Pure; tested in LinkRecoveryTest.
 */
object LinkRecovery {
    const val CHECK_MS = 15_000L
    /** Time the link gets after a change to shake hands on its own. */
    const val GRACE_MS = 20_000L
    /** At most one restart this often, so a dead network doesn't restart it in a loop. */
    const val RESTART_EVERY_MS = 60_000L
    /** Checks stop this long after the change; the link's own retries carry on. */
    const val GIVE_UP_MS = 10 * 60_000L

    /** A handshake came after the change: [sinceHandshakeS] is -1 when there was none at all. */
    fun shookHandsSince(sinceHandshakeS: Long, sinceChangeMs: Long): Boolean =
        sinceHandshakeS >= 0 && sinceHandshakeS * 1000 < sinceChangeMs

    fun shouldRestart(sinceHandshakeS: Long, sinceChangeMs: Long, sinceRestartMs: Long): Boolean =
        sinceChangeMs >= GRACE_MS && !shookHandsSince(sinceHandshakeS, sinceChangeMs) && sinceRestartMs >= RESTART_EVERY_MS
}
