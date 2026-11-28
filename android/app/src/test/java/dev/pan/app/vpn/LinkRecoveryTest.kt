package dev.pan.app.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkRecoveryTest {
    @Test fun aHandshakeAfterTheChangeNeedsNothing() {
        assertTrue(LinkRecovery.shookHandsSince(sinceHandshakeS = 5, sinceChangeMs = 30_000))
        assertFalse(LinkRecovery.shouldRestart(5, 30_000, Long.MAX_VALUE))
    }

    @Test fun noHandshakeSinceTheChangeRestartsAfterTheGrace() {
        // The last handshake was before the change (200 s ago, change 25 s ago).
        assertFalse(LinkRecovery.shouldRestart(200, 10_000, Long.MAX_VALUE))
        assertTrue(LinkRecovery.shouldRestart(200, 25_000, Long.MAX_VALUE))
        assertTrue(LinkRecovery.shouldRestart(-1, 25_000, Long.MAX_VALUE))
    }

    @Test fun neverRestartsTwiceInAMinute() {
        assertFalse(LinkRecovery.shouldRestart(200, 40_000, 30_000))
        assertTrue(LinkRecovery.shouldRestart(200, 100_000, 61_000))
    }

    @Test fun checksSlowDownButNeverStop() {
        assertEquals(15_000L, LinkRecovery.nextCheckMs(9 * 60_000L))
        assertEquals(60_000L, LinkRecovery.nextCheckMs(11 * 60_000L))
        assertEquals(5 * 60_000L, LinkRecovery.nextCheckMs(31 * 60_000L))
        assertEquals(5 * 60_000L, LinkRecovery.nextCheckMs(10 * 60 * 60_000L))
    }

    @Test fun aDeadTailscaleIsUnhealthy() {
        assertTrue(LinkRecovery.tailscaleUnhealthy(running = false, state = "", ip = "", pingMs = -2))
        assertTrue(LinkRecovery.tailscaleUnhealthy(true, "Starting", "", -2))
        assertTrue(LinkRecovery.tailscaleUnhealthy(true, "Running", "", -2))
        // Running with an address, but the hub's Tailscale address didn't answer (the car, Nov 27).
        assertTrue(LinkRecovery.tailscaleUnhealthy(true, "Running", "100.64.0.9", -1))
        assertFalse(LinkRecovery.tailscaleUnhealthy(true, "Running", "100.64.0.9", 40))
        assertFalse(LinkRecovery.tailscaleUnhealthy(true, "Running", "100.64.0.9", -2))
    }

    @Test fun aSignInIsNotFixedByARestart() {
        assertFalse(LinkRecovery.tailscaleUnhealthy(true, "NeedsLogin", "", -2))
        assertFalse(LinkRecovery.tailscaleUnhealthy(true, "NeedsMachineAuth", "", -2))
    }

    @Test fun tailscaleRestartsAtMostEveryTwoMinutesThenSlower() {
        assertFalse(LinkRecovery.shouldRestartTailscale(true, sinceChangeMs = 10_000, sinceTailscaleRestartMs = Long.MAX_VALUE))
        assertTrue(LinkRecovery.shouldRestartTailscale(true, 25_000, Long.MAX_VALUE))
        assertFalse(LinkRecovery.shouldRestartTailscale(true, 5 * 60_000L, 90_000))
        assertTrue(LinkRecovery.shouldRestartTailscale(true, 5 * 60_000L, 121_000))
        // An hour of no signal: every 5 minutes, not every 2.
        assertFalse(LinkRecovery.shouldRestartTailscale(true, 60 * 60_000L, 3 * 60_000L))
        assertTrue(LinkRecovery.shouldRestartTailscale(true, 60 * 60_000L, 5 * 60_000L))
        assertFalse(LinkRecovery.shouldRestartTailscale(false, 60 * 60_000L, Long.MAX_VALUE))
    }

    @Test fun aSleepShowsAsAGrowingGap() {
        assertEquals(0L, LinkRecovery.sleptMs(1_000, 1_000))
        assertTrue(LinkRecovery.sleptMs(1_000, 1_000 + 20 * 60_000L) > LinkRecovery.SLEEP_MS)
    }
}
