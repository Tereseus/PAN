package dev.pan.app.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class FeedbackSounds @Inject constructor(
    @ApplicationContext private val context: Context
) {
    companion object {
        private const val TAG = "PanFeedback"
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    // The Sound Effects and Vibration switches in Settings. Until 0.5.0 nothing read them: sounds and
    // vibration played whatever the switches said. Kept in SharedPreferences so the service has them at once.
    private val prefs = context.getSharedPreferences("pan_feedback", Context.MODE_PRIVATE)
    @Volatile var soundOn: Boolean = prefs.getBoolean("sound", true)
        private set
    @Volatile var vibrationOn: Boolean = prefs.getBoolean("vibration", true)
        private set
    fun setSound(on: Boolean) { soundOn = on; prefs.edit().putBoolean("sound", on).apply() }
    fun setVibration(on: Boolean) { vibrationOn = on; prefs.edit().putBoolean("vibration", on).apply() }

    fun onWakeWord() {
        Log.i(TAG, "Playing wake word feedback")
        mainHandler.post {
            playSystemSound()
            vibrate(200)
        }
    }

    fun onCommandSent() {
        Log.i(TAG, "Playing command sent feedback")
        mainHandler.post {
            playSystemSound()
        }
    }

    fun onCommandFailed() {
        Log.i(TAG, "Playing command failed feedback")
        mainHandler.post {
            vibrate(500)
        }
    }

    /** Muted: two soft notes going down, so it is heard as "off". */
    fun onMuted() {
        Log.i(TAG, "Playing muted feedback")
        if (!soundOn) return
        Thread { playTone(Tone.muteNotes()) }.start()
    }

    // No sound on a reply or a quick answer (owner, Nov 26: "I don't want it making sounds every
    // time it replies"). It used to be the device's notification sound, which on the car unit sounds
    // like a system error. Only mute has a sound now ([onMuted]).
    private fun playSystemSound() {}

    private fun playTone(pcm: ShortArray) {
        try {
            val track = android.media.AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                .setAudioFormat(android.media.AudioFormat.Builder()
                    .setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(Tone.RATE)
                    .setChannelMask(android.media.AudioFormat.CHANNEL_OUT_MONO).build())
                .setTransferMode(android.media.AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(pcm.size * 2)
                .build()
            track.write(pcm, 0, pcm.size)
            track.play()
            Thread.sleep(pcm.size * 1000L / Tone.RATE + 50)
            track.release()
        } catch (e: Exception) {
            Log.e(TAG, "Sound failed: ${e.message}")
        }
    }

    private fun vibrate(ms: Long) {
        if (!vibrationOn) return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
                vm.defaultVibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
                Log.d(TAG, "Vibrating ${ms}ms")
            } else {
                @Suppress("DEPRECATION")
                val v = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Vibrate failed: ${e.message}")
        }
    }
}
