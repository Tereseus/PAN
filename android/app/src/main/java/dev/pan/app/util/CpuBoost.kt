package dev.pan.app.util

import android.content.Context
import android.os.Build
import android.os.PerformanceHintManager
import android.util.Log
import java.io.File

/**
 * Asks for full CPU speed during the few hundred ms a voice turn is computed on the phone.
 *
 * With the screen off (the phone in a pocket, which is the normal case) PAN is a foreground
 * service, not the top app, and its bursts finish before the governor has ramped up. Measured
 * on the Pixel 10 Pro (voicebench, 2026-11-02): Smart Turn took 470-526 ms with the screen off
 * against 136-204 ms with it on, and Supertonic took 2-2.5x longer per sentence.
 *
 * ADPF (PerformanceHintManager) is the platform's way to say "this work is latency-bound". The
 * public API has no "boost now" call, only "the work took this long against this target", and
 * the platform raises the floor for the session's threads in proportion to the overrun. So the
 * target is the latency wanted (TARGET_NS), and burst() reports the last burst's real duration
 * just before the next one starts - unboosted, that is several times the target.
 *
 * A session only accepts this process's own thread ids, and ONNX Runtime and the coroutine pools
 * make threads of their own, so it is pointed at every thread the process has. An idle thread
 * costs nothing boosted; only the ones doing the work run.
 *
 * Best effort: if the platform refuses a session, burst() and done() do nothing.
 */
object CpuBoost {
    private const val TAG = "CpuBoost"
    // The latency wanted for one burst: a Smart Turn verdict or one sentence of speech.
    private const val TARGET_NS = 40_000_000L
    // What an unboosted burst took when nothing has been measured yet (Smart Turn, screen off).
    private const val FIRST_REPORT_NS = 480_000_000L

    private var session: PerformanceHintManager.Session? = null
    private var failed = false
    private var threadCount = 0
    @Volatile private var lastNs = FIRST_REPORT_NS

    private fun threadIds(): IntArray =
        File("/proc/self/task").list()?.mapNotNull { it.toIntOrNull() }?.toIntArray() ?: IntArray(0)

    /** Call right before latency-bound work. */
    @Synchronized
    fun burst(context: Context) {
        if (failed) return
        try {
            val s = session ?: run {
                val phm = context.getSystemService(PerformanceHintManager::class.java)
                // A thread can exit between listing and the call; one retry covers that race.
                val made = phm?.let { m ->
                    runCatching { m.createHintSession(threadIds(), TARGET_NS) }.getOrNull()
                        ?: runCatching { m.createHintSession(threadIds(), TARGET_NS) }.getOrNull()
                }
                if (made == null) {
                    failed = true
                    Log.w(TAG, "no hint session - running unboosted")
                    return
                }
                threadCount = threadIds().size
                Log.i(TAG, "hint session over $threadCount threads")
                made.also { session = it }
            }
            // Model loads and coroutine pools add threads after the session is made.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val tids = threadIds()
                if (tids.size != threadCount) {
                    runCatching { s.setThreads(tids); threadCount = tids.size }
                }
            }
            s.reportActualWorkDuration(lastNs)
        } catch (e: Exception) {
            Log.w(TAG, "boost failed: ${e.message}")
        }
    }

    /** Call when the work finishes, with how long it took, so the next burst reports real data. */
    fun done(ms: Long) {
        if (ms <= 0) return
        lastNs = ms * 1_000_000L
        runCatching { session?.reportActualWorkDuration(lastNs) }
    }
}
