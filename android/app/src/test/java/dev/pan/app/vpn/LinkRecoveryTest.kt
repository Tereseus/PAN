package dev.pan.app.vpn

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
}
