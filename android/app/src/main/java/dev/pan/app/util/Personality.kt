package dev.pan.app.util

import android.content.Context

/**
 * How ΠAN talks on this device (Settings > Voice and sounds > Personality), owner Nov 26.
 *
 * It is this device's own: saved here and sent with every voice turn as the body field
 * `personality` (PanServerClient.askPanStream). The hub uses it for that turn only. The phone
 * no longer writes the hub's global `personality` setting, so one person's choice does not
 * change ΠAN for everyone. An empty text means turned off: the usual ΠAN.
 */
object Personality {
    private const val PREFS = "pan_personality"
    private const val KEY = "text"
    /** Longest text kept; the hub puts it in the prompt as is. */
    const val MAX_CHARS = 2000

    @Volatile var text: String = ""
        private set

    /** True once this device has saved its own text (or saved it off). */
    fun saved(ctx: Context): Boolean = prefs(ctx).contains(KEY)

    fun load(ctx: Context) { text = clean(prefs(ctx).getString(KEY, "")) }

    fun set(ctx: Context, value: String) {
        text = clean(value)
        prefs(ctx).edit().putString(KEY, text).apply()
    }

    /** What goes in the turn body: always a string, "" when turned off. */
    fun forTurn(saved: String? = text): String = clean(saved)

    fun clean(value: String?): String = value?.trim()?.take(MAX_CHARS).orEmpty()

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
