package dev.pan.app.util

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LastCrashTest {
    @Test fun keepsKindsAndCodeLinesButNoMessages() {
        val e = IllegalStateException("said: call my mum at 100.64.0.1",
            java.io.IOException("failed to connect to /100.101.102.103:7777"))
        val s = LastCrash.format(e)
        assertTrue(s.startsWith("java.lang.IllegalStateException\n"))
        assertTrue(s.contains("Caused by: java.io.IOException"))
        assertTrue(s.contains("\tat dev.pan.app.util.LastCrashTest"))
        assertFalse(s.contains("mum"))
        assertFalse(s.contains("100."))
        assertFalse(s.contains("7777"))
    }
}
