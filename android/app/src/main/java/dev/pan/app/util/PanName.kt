package dev.pan.app.util

import android.content.Context

/**
 * This device's own name for ΠAN (Settings > Voice and sounds > ΠAN's name), task 1082, owner Nov 26:
 * "every individual's pendant or phone can have their own version of that".
 *
 * Sent with every voice turn as the body field `pan_name` (PanServerClient.askPanStream). The hub
 * reads it where ΠAN is called (service/src/pan-name.js) and ΠAN calls itself by it. Once a device
 * has its own name, "Pan" on it is someone else's name and gets no answer. Empty = ΠAN.
 */
object PanName {
    private const val PREFS = "pan_name"
    private const val KEY = "name"
    const val MAX_CHARS = 24

    @Volatile var name: String = ""
        private set

    fun load(ctx: Context) { name = clean(prefs(ctx).getString(KEY, "")) }

    fun set(ctx: Context, value: String) {
        name = clean(value)
        prefs(ctx).edit().putString(KEY, name).apply()
    }

    /** Letters, spaces, hyphens and apostrophes, at most three words; ΠAN itself counts as none. */
    fun clean(value: String?): String {
        val n = value.orEmpty().replace(Regex("[^\\p{L}\\p{M}' -]"), " ").replace(Regex("\\s+"), " ").trim().take(MAX_CHARS)
        if (n.isEmpty() || n.split(" ").size > 3) return ""
        if (Regex("^(?:pan|pam|πan|παν|pan ai)$", RegexOption.IGNORE_CASE).matches(n)) return ""
        return n
    }

    /**
     * The words the phone's own commands accept as ΠAN's name ("mute", "be quiet" with the name
     * in front or behind): the device's own name, or pan and pam when it has none.
     */
    fun namePattern(saved: String = name): String =
        if (saved.isEmpty()) "(?:pan|pam)" else "(?:" + Regex.escape(saved.lowercase()).replace(" ", "\\E\\s+\\Q") + ")"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
