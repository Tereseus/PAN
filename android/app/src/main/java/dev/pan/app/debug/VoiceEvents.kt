package dev.pan.app.debug

import android.os.SystemClock
import android.util.Log
import dev.pan.app.BuildConfig
import org.json.JSONObject

/**
 * One JSON line per moment of the voice loop, for the conversation benchmark
 * (service/src/evals/voicebench). Logcat tag PANEVT.
 *
 * t is SystemClock.elapsedRealtime() in ms: the phone's monotonic clock, so the
 * injected audio, the turn decision, the hub round trip and the voice of one run
 * all sit on one timeline. The benchmark scores timing from these lines; it does
 * not trust any number the app computes about itself.
 *
 * Debug builds only.
 */
object VoiceEvents {
    const val TAG = "PANEVT"

    fun emit(ev: String, vararg fields: Pair<String, Any?>) {
        if (!BuildConfig.DEBUG) return
        try {
            val o = JSONObject()
            o.put("t", SystemClock.elapsedRealtime())
            o.put("ev", ev)
            for ((k, v) in fields) {
                o.put(k, when (v) {
                    null -> JSONObject.NULL
                    is String -> v.take(300)
                    is Float -> if (v.isFinite()) v.toDouble() else JSONObject.NULL
                    is Double -> if (v.isFinite()) v else JSONObject.NULL
                    else -> v
                })
            }
            Log.i(TAG, o.toString())
        } catch (_: Exception) {
            // Instrumentation must never take the voice loop down with it.
        }
    }
}
