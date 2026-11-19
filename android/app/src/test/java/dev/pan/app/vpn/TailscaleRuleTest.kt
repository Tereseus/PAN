package dev.pan.app.vpn

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TailscaleRuleTest {
    @Test fun aNewPersonsPhoneNeverStartsIt() = assertFalse(TailscaleRule.starts(haveKey = false, usedBefore = false, byHand = false))
    @Test fun aKeyFromTheHubStartsIt() = assertTrue(TailscaleRule.starts(haveKey = true, usedBefore = false, byHand = false))
    @Test fun aDeviceThatUsedItBeforeKeepsIt() = assertTrue(TailscaleRule.starts(haveKey = false, usedBefore = true, byHand = false))
    @Test fun turnedOnByHandStartsIt() = assertTrue(TailscaleRule.starts(haveKey = false, usedBefore = false, byHand = true))
}
