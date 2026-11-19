package dev.pan.app.ui.memory

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PinRuleTest {
    @Test fun aPhoneWithNoFingerprintMayUseAPin() = assertTrue(PinRule.allowed(granted = false, isPhone = true))
    @Test fun aCarUnitATvOrATabletMayNot() = assertFalse(PinRule.allowed(granted = false, isPhone = false))
    @Test fun unlessItWasGranted() = assertTrue(PinRule.allowed(granted = true, isPhone = false))
}
