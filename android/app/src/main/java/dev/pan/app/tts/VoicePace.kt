package dev.pan.app.tts

import android.content.Context
import kotlin.math.roundToInt

/**
 * How fast ΠAN's voice talks and how many steps it builds each line with (the owner, 2026-11-21).
 * Saved on the device: Auto (the default) or a speed picked by hand, and steps picked by hand or
 * left to the voice. A hand pick wins over Auto.
 *
 * The decision is [choose], one plain function with tests (VoicePaceTest). TEST_TTS (debug) still
 * sets a live override in PiperTtsEngine on top of this, lost on restart, for tuning by ear.
 */
object VoicePace {
    const val MIN = 0.9f
    const val MAX = 1.6f
    const val STEP = 0.05f
    private const val PREFS = "pan_tts_prefs"
    private const val KEY_SPEED = "pace_speed"   // 0 = Auto
    private const val KEY_STEPS = "pace_steps"   // 0 = the voice's own

    data class Pick(val speed: Float, val steps: Int, val auto: Boolean)

    /** What was saved: a speed by hand (null = Auto) and steps by hand (null = the voice's own). */
    data class Saved(val speed: Float?, val steps: Int?)

    /**
     * The pace for a line. [manual] is the speed picked by hand, null for Auto; [manualSteps] the
     * steps picked by hand, null for the voice's own. [voiceSpeed] and [voiceSteps] are the voice's
     * own (PiperTtsEngine.VOICES). [timing] is how this device has been building lines.
     */
    fun choose(manual: Float?, manualSteps: Int?, voiceSpeed: Float, voiceSteps: Int, timing: VoiceTiming.Stats): Pick {
        val steps = manualSteps?.takeIf { it > 0 } ?: voiceSteps
        if (manual != null && manual > 0f) return Pick(snap(manual), steps, auto = false)
        // TODO(auto pace): the automatic rule goes here, built from real numbers from the owner's
        // slow car unit (timing.ratio is build ms per second of sound; over 1000 the device cannot
        // keep up with its own voice). Until those numbers exist, Auto is exactly what it was
        // before: the voice's own speed and steps. `timing` is unused on purpose.
        return Pick(voiceSpeed, steps, auto = true)
    }

    /** A speed on the 0.05 grid between [MIN] and [MAX]. */
    fun snap(speed: Float): Float {
        val c = speed.coerceIn(MIN, MAX)
        return ((c / STEP).roundToInt() * STEP * 100).roundToInt() / 100f
    }

    fun saved(context: Context): Saved {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return Saved(p.getFloat(KEY_SPEED, 0f).takeIf { it > 0f }, p.getInt(KEY_STEPS, 0).takeIf { it > 0 })
    }

    /** [speed] null = Auto. [steps] null = the voice's own. */
    fun save(context: Context, speed: Float?, steps: Int? = saved(context).steps) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putFloat(KEY_SPEED, speed?.let { snap(it) } ?: 0f)
            .putInt(KEY_STEPS, steps?.takeIf { it > 0 } ?: 0)
            .apply()
    }

    /** The pace a plain line gets now on this device, for [voice]. */
    fun current(context: Context, voice: PiperTtsEngine.VoiceModel): Pick {
        val s = saved(context)
        return choose(s.speed, s.steps, voice.speed, voice.steps, VoiceTiming.stats(context))
    }

    /** "Auto, 1.20, 4 steps" or "Manual, 1.30, 4 steps". */
    fun describe(p: Pick): String = "${if (p.auto) "Auto" else "Manual"}, speed ${"%.2f".format(java.util.Locale.US, p.speed)}, ${p.steps} steps"
}
