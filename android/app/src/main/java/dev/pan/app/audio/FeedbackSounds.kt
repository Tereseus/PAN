package dev.pan.app.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
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

    private fun playSystemSound() {
        try {
            // Use the default notification sound — guaranteed to play
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val ringtone = RingtoneManager.getRingtone(context, uri)
            if (ringtone != null) {
                ringtone.play()
                Log.d(TAG, "Ringtone playing")
            } else {
                Log.w(TAG, "No ringtone available")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Sound failed: ${e.message}")
        }
    }

    private fun vibrate(ms: Long) {
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
