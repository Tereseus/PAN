package dev.pan.app.ui.settings

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/**
 * Developer options (Settings > Updates and about). The owner, Nov 26: everything marked
 * developer in docs/UI-INVENTORY.md is shown only while this is on. It hides things; it never
 * changes what they do. The switch itself shows once it is on; seven taps on the version line
 * in Updates and about turn it on.
 */
object DevOptions {
    const val PREFS = "pan_ui"
    const val KEY = "developer"
    /** Taps on the version line that turn Developer options on. */
    const val TAPS_TO_TURN_ON = 7

    fun on(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY, false)

    fun set(ctx: Context, on: Boolean) { prefs(ctx).edit().putBoolean(KEY, on).apply() }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}

/** Developer options as Compose state: any screen follows a change at once. */
@Composable
fun rememberDeveloperMode(): State<Boolean> {
    val ctx = LocalContext.current
    val state = remember { mutableStateOf(DevOptions.on(ctx)) }
    DisposableEffect(ctx) {
        val prefs = ctx.getSharedPreferences(DevOptions.PREFS, Context.MODE_PRIVATE)
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { p, key ->
            if (key == DevOptions.KEY) state.value = p.getBoolean(DevOptions.KEY, false)
        }
        prefs.registerOnSharedPreferenceChangeListener(listener)
        state.value = DevOptions.on(ctx)
        onDispose { prefs.unregisterOnSharedPreferenceChangeListener(listener) }
    }
    return state
}
