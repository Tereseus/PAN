package dev.pan.app.update

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatePolicyTest {
    @Test fun onWifiAndNotInACallItFetches() = assertTrue(UpdatePolicy.fetchAtLaunch(metered = false, inCall = false))
    @Test fun onMobileDataOrAHotspotItWaits() = assertFalse(UpdatePolicy.fetchAtLaunch(metered = true, inCall = false))
    @Test fun duringACallItWaitsEvenOnWifi() = assertFalse(UpdatePolicy.fetchAtLaunch(metered = false, inCall = true))
    @Test fun meteredAndInACallItWaits() = assertFalse(UpdatePolicy.fetchAtLaunch(metered = true, inCall = true))
}
