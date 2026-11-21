package dev.pan.app.audio

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.os.Handler
import android.os.Looper
import android.provider.AlarmClock

/**
 * A timer or alarm going off on this device (any app's player with the alarm usage). The app says
 * so on its regular ask to the hub (/slack/pending, `ringing=1`), so that "turn that off" said to
 * ΠAN on any of the person's devices can stop it; the hub answers `stop_ringing` and [stop] ends it
 * with Android's own dismiss actions, which the clock app honours on a locked phone too.
 * Proven by hand on the Pixel 6 Pro, Nov 21: the dismiss timer action stopped a ringing timer, locked.
 */
object Ringing {
    /** Pure: is any of these players a timer or alarm? */
    fun isRinging(usages: Collection<Int>): Boolean = usages.any { it == AudioAttributes.USAGE_ALARM }

    @Volatile var now: Boolean = false
        private set
    /** Bumped on every change, so the hub ask can go out at once instead of waiting its 5 s. */
    @Volatile var changes: Int = 0
        private set

    private var callback: AudioManager.AudioPlaybackCallback? = null

    fun watch(am: AudioManager, log: (String) -> Unit) {
        if (callback != null) return
        fun look(configs: List<AudioPlaybackConfiguration>) {
            val r = isRinging(configs.map { it.audioAttributes.usage })
            if (r != now) { now = r; changes++; log("Ringing: ${if (r) "a timer or alarm went off" else "stopped"}") }
        }
        val cb = object : AudioManager.AudioPlaybackCallback() {
            override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>) = look(configs)
        }
        am.registerAudioPlaybackCallback(cb, Handler(Looper.getMainLooper()))
        callback = cb
        look(am.activePlaybackConfigurations)
    }

    /** The hub asked to stop it: the ringing timer first, then a ringing alarm if it still rings. */
    fun stop(context: Context, log: (String) -> Unit) {
        fun send(action: String) = try {
            context.startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (e: Exception) { log("Ringing: $action failed: ${e.message}"); false }
        log("Ringing: the hub asked to stop it")
        send(AlarmClock.ACTION_DISMISS_TIMER)
        Handler(Looper.getMainLooper()).postDelayed({ if (now) send(AlarmClock.ACTION_DISMISS_ALARM) }, 1500)
    }
}
