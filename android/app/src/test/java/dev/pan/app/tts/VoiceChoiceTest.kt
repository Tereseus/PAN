package dev.pan.app.tts

import dev.pan.app.tts.VoiceChoice.Engine
import dev.pan.app.tts.VoiceChoice.StartAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The car unit spoke in the Android voice for two days without a word in its log (2026-11-19).
 * These hold every state the voice setting can be in, and every kind of line, to the two rules in
 * VoiceChoice: ΠAN's voice whenever it is on the device, and never a silent case.
 */
class VoiceChoiceTest {
    private val main = VoiceChoice.MAIN
    private val settings = listOf("android", main, "supertonic", "medium", "low", "high", "kokoro", "", "something else")
    // Which voices are on the device: none, ΠAN's, an older one, both.
    private val onDevice = listOf(emptySet(), setOf(main), setOf("supertonic"), setOf(main, "supertonic"))

    @Test fun theCarsState() {
        // ΠAN's voice downloaded, the setting still at what a fresh install starts with.
        val r = VoiceChoice.atStart("android", picked = false) { it == main }
        assertEquals(StartAction.USE, r.action)
        assertEquals(main, r.voice)
        assertEquals("the setting is moved too, so the next start is the plain case", main, r.setting)
    }

    @Test fun pansVoiceWheneverItIsOnTheDevice() {
        for (setting in settings) for (picked in listOf(false, true)) {
            val r = VoiceChoice.atStart(setting, picked) { it == main }
            val androidByHand = setting == "android" && picked
            if (androidByHand) assertEquals(StartAction.KEEP_ANDROID, r.action)
            else {
                assertEquals("setting '$setting' picked=$picked", StartAction.USE, r.action)
                assertEquals("setting '$setting' picked=$picked", main, r.voice)
            }
        }
    }

    @Test fun neverSilentAndNeverAVoiceThatIsNotThere() {
        for (setting in settings) for (picked in listOf(false, true)) for (have in onDevice) {
            val r = VoiceChoice.atStart(setting, picked) { it in have }
            val at = "setting '$setting' picked=$picked on device $have"
            assertTrue("a line for the log: $at", r.say.startsWith("Voice: ") && r.say.length > 12)
            when (r.action) {
                StartAction.USE -> assertTrue("loads a voice that is there: $at", r.voice in have)
                StartAction.DOWNLOAD -> { assertEquals(at, main, r.voice); assertTrue("only when it is missing: $at", main !in have) }
                StartAction.KEEP_ANDROID -> assertTrue("only when chosen by hand: $at", setting == "android" && picked)
            }
            // A setting is only ever moved to ΠAN's voice, or to Android while that downloads.
            r.setting?.let { assertTrue(at, it == main || (it == "android" && r.action == StartAction.DOWNLOAD)) }
            // A voice that speaks nothing is never left as the setting.
            if (setting in VoiceChoice.DEAD) assertNotNull("a dead voice is moved: $at", r.setting)
        }
    }

    @Test fun aVoiceChosenAndPresentIsLeftAlone() {
        val r = VoiceChoice.atStart("supertonic", picked = true) { true }
        assertEquals(StartAction.USE, r.action)
        assertEquals("supertonic", r.voice)
        assertNull(r.setting)
    }

    // ── one line ────────────────────────────────────────────────────────────────────────

    private val reads = setOf("en", "ja", "el", "es", "fr", "de", "ko", "vi", "hi")
    private fun line(pan: Boolean = true, android: Boolean = true, interpreting: Boolean = false, script: String? = null,
                     said: String? = null, other: String? = null, voice: Int? = null) =
        VoiceChoice.forLine(pan, android, interpreting, script, said, other, voice) { it in reads }

    @Test fun pansOwnEnglishLine() {
        val r = line()
        assertEquals(Engine.PAN, r.engine); assertEquals("en", r.lang); assertNull(r.sid); assertNull(r.why)
    }

    @Test fun japaneseIsPansVoiceInterpretingOrNot() {
        // The line that starts interpreting is not marked as interpreted yet, and is still ΠAN's voice.
        for (interpreting in listOf(false, true)) {
            val r = line(interpreting = interpreting, script = "ja", said = if (interpreting) "ja" else null)
            assertEquals("interpreting=$interpreting", Engine.PAN, r.engine)
            assertEquals("ja", r.lang)
            assertNull("ΠAN's own voice, not another", r.sid)
        }
    }

    @Test fun everyLanguagePansVoiceReadsIsPansVoice() {
        for (lang in reads) for (interpreting in listOf(false, true)) for (script in listOf(null, lang)) {
            if (!interpreting && script == null && lang != "en") continue      // a Latin-letter line outside interpreting is read as English
            val r = line(interpreting = interpreting, script = script.takeIf { lang != "en" }, said = lang)
            assertEquals("$lang interpreting=$interpreting script=$script", Engine.PAN, r.engine)
            assertEquals(lang, r.lang)
        }
    }

    @Test fun aPersonsVoiceOnlyWhileInterpreting() {
        assertEquals(6, line(interpreting = true, script = "ja", said = "ja", voice = 6).sid)
        assertNull(line(interpreting = false, script = "ja", voice = 6).sid)
        assertNull(line(interpreting = false, voice = 6).sid)
    }

    @Test fun hanWithNoKanaIsJapaneseWhileInterpretingJapanese() {
        assertEquals("ja", line(interpreting = true, script = "zh", other = "ja").lang)
        assertEquals(Engine.PAN, line(interpreting = true, script = "zh", other = "ja").engine)
    }

    @Test fun theAndroidVoiceOnlyWithAReasonGiven() {
        // A language ΠAN's voice cannot read.
        val zh = line(interpreting = true, script = "zh", said = "zh")
        assertEquals(Engine.ANDROID_OTHER_LANGUAGE, zh.engine); assertEquals("zh", zh.lang); assertNotNull(zh.why)
        val th = line(interpreting = true, said = "th")
        assertEquals(Engine.ANDROID_OTHER_LANGUAGE, th.engine); assertEquals("th", th.lang); assertNotNull(th.why)
        // ΠAN's voice not loaded: what the car did. Every line says why.
        for (script in listOf(null, "ja")) for (interpreting in listOf(false, true)) {
            val r = line(pan = false, interpreting = interpreting, script = script, said = script)
            assertTrue(r.engine == Engine.ANDROID_ENGLISH || r.engine == Engine.ANDROID_OTHER_LANGUAGE)
            assertEquals("PAN's voice is not loaded", r.why)
        }
        // Across everything: ΠAN's voice has no reason to give, the Android voice always has one.
        for (pan in listOf(false, true)) for (android in listOf(false, true)) for (interpreting in listOf(false, true))
            for (script in listOf(null, "ja", "zh", "el", "th")) for (said in listOf(null, "en", "ja", "th")) {
                val r = line(pan, android, interpreting, script, said)
                if (r.engine == Engine.PAN) { assertNull(r.why); assertTrue("ΠAN's voice only when it is loaded", pan) }
                else assertNotNull("pan=$pan android=$android interpreting=$interpreting script=$script said=$said", r.why)
                if (!android) assertTrue(r.engine == Engine.PAN || r.engine == Engine.NOTHING)
            }
    }
}
