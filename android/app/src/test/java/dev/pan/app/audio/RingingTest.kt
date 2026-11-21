package dev.pan.app.audio

import android.media.AudioAttributes
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RingingTest {
    @Test fun aTimerOrAlarmPlayingIsRinging() {
        assertTrue(Ringing.isRinging(listOf(AudioAttributes.USAGE_MEDIA, AudioAttributes.USAGE_ALARM)))
    }

    @Test fun musicSpeechAndCallsAreNot() {
        assertFalse(Ringing.isRinging(listOf(AudioAttributes.USAGE_MEDIA, AudioAttributes.USAGE_ASSISTANT,
            AudioAttributes.USAGE_VOICE_COMMUNICATION, AudioAttributes.USAGE_NOTIFICATION_RINGTONE)))
        assertFalse(Ringing.isRinging(emptyList()))
    }
}
