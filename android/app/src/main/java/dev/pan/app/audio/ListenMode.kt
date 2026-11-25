package dev.pan.app.audio

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * ΠAN's listening modes (the owner, 2026-11-24; the hub's side is service/src/listen-mode.js).
 *
 *  NORMAL  hears everything, speaks when the hub judges it is spoken to.
 *  LISTEN  "Listen only": everything still goes to the hub (kept, voice ID), nothing is said.
 *          Out: the person's own release words, or the button.
 *  NAME    "Name only": the hub answers only a line that starts with the name or the person's word.
 *          Out: "back to normal", or the button.
 *  FORGET  "Don't remember": hears and talks as in NORMAL, but nothing is kept, here (no lines on
 *          Home, no history, no uploads, no log lines to the hub) or on the hub (its no-trace turn).
 *          Out: the button only (owner, 2026-11-25), or after FORGET_LIMIT_MS.
 *  Mute is not here: it is the mic being off (PanForegroundService.micEnabled), and only the
 *  button turns it back on.
 *
 * The mode and the words live on the device and go to the hub with every turn.
 */
object ListenMode {
    enum class Mode(val wire: String, val label: String) {
        NORMAL("normal", "Normal"), LISTEN("listen", "Listen only"), NAME("name", "Name only"),
        FORGET("forget", "Don't remember");
        companion object { fun of(w: String?) = values().firstOrNull { it.wire == w } }
    }

    private const val PREFS = "pan_listen_mode"
    val mode = MutableStateFlow(Mode.NORMAL)
    /** The person's own words, any language: lines that start with one wake Name only. */
    val nameWords = MutableStateFlow<List<String>>(emptyList())
    /** The person's own words that end Listen only ("you can talk" and the like always do). */
    val releaseWords = MutableStateFlow<List<String>>(emptyList())
    /** The person's own words that end Don't remember ("remember again" always does). */
    val rememberWords = MutableStateFlow<List<String>>(emptyList())
    /** Don't remember ends by itself after an hour, the hub's incognito default. */
    const val FORGET_LIMIT_MS = 60 * 60 * 1000L
    @Volatile var forgetSince = 0L
        private set

    /** True while nothing may be kept (Don't remember). Read by every place that stores a line. */
    fun forgetting(): Boolean = mode.value == Mode.FORGET

    fun load(ctx: Context) {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        mode.value = Mode.of(p.getString("mode", null)) ?: Mode.NORMAL
        nameWords.value = split(p.getString("name_words", "") ?: "")
        releaseWords.value = split(p.getString("release_words", "") ?: "")
        rememberWords.value = split(p.getString("remember_words", "") ?: "")
        forgetSince = p.getLong("forget_since", 0L)
    }

    fun set(ctx: Context, m: Mode) {
        if (m == Mode.FORGET && mode.value != Mode.FORGET) forgetSince = System.currentTimeMillis()
        mode.value = m
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("mode", m.wire)
            .putLong("forget_since", forgetSince).apply()
    }

    /** Don't remember has run its hour. */
    fun forgetRanOut(now: Long = System.currentTimeMillis()): Boolean =
        mode.value == Mode.FORGET && forgetSince > 0L && now - forgetSince > FORGET_LIMIT_MS

    fun setWords(ctx: Context, name: String, release: String, remember: String) {
        nameWords.value = split(name)
        releaseWords.value = split(release)
        rememberWords.value = split(remember)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("name_words", nameWords.value.joinToString("\n"))
            .putString("release_words", releaseWords.value.joinToString("\n"))
            .putString("remember_words", rememberWords.value.joinToString("\n")).apply()
    }

    /** One word or phrase per line (commas too), at most 12, each at most 60 characters. */
    fun split(s: String): List<String> =
        s.split('\n', ',').map { it.trim() }.filter { it.isNotEmpty() && it.length <= 60 }.distinct().take(12)

    fun wordsJson(): JSONObject = JSONObject()
        .put("name", JSONArray(nameWords.value))
        .put("release", JSONArray(releaseWords.value))
        .put("remember", JSONArray(rememberWords.value))

    private val LEAD = "^(?:(?:hey|ok|okay|so|now|just|and)[,]?\\s+)*(?:(?:pan|pam)[,.]?\\s+)?(?:(?:can|could|would|will) you\\s+)?(?:please\\s+)?(?:just\\s+)?"
    private val TAIL = "(?:\\s+(?:please|now))*(?:[,]?\\s+(?:pan|pam))?[.!]?$"
    private val TO_LISTEN = Regex("$LEAD(?:(?:only|just) listen(?: only)?|listen[- ]only(?: mode)?|listening mode|(?:go|switch) (?:in)?to listen(?:ing)?[- ]?(?:only )?mode)$TAIL")
    private val TO_NAME = Regex("$LEAD(?:only (?:answer|respond|talk|reply) (?:to|when you hear) your name|only (?:answer|respond|talk|reply)(?: to me)? when i (?:say|call|use) your name|name[- ]only(?: mode)?|(?:go|switch) (?:in)?to name[- ]?(?:only )?mode)$TAIL")
    private val TO_FORGET = Regex("$LEAD(?:(?:don't|do not) remember (?:this|any of this|anything)|(?:go )?incognito(?: mode)?|(?:this is )?off the record|(?:don't|do not) (?:save|keep|record) (?:this|any of this|anything))$TAIL")
    private val TO_REMEMBER = Regex("$LEAD(?:(?:you can |okay you can |ok you can )?(?:remember|start remembering)(?: again| now)?|(?:back )?on the record|stop (?:being )?incognito)$TAIL")
    private val TO_NORMAL = Regex("$LEAD(?:back to normal(?: mode)?|normal mode|(?:you can|okay you can|ok you can) (?:talk|speak)(?: again| now| to me)?|talk (?:to me )?again|talk normally)$TAIL")

    /** The device's own check of a whole line that is a mode command (the hub checks too). */
    fun commandIn(lower: String): Mode? {
        val l = lower.trim().replace('’', '\'')
        // Don't remember ends only with the button (owner, 2026-11-25): no line said in it changes the
        // mode. "Just listen" used to switch it to Listen only, which keeps everything.
        if (mode.value == Mode.FORGET) return null
        return when {
            TO_FORGET.matches(l) -> Mode.FORGET
            TO_LISTEN.matches(l) -> Mode.LISTEN
            TO_NAME.matches(l) -> Mode.NAME
            TO_NORMAL.matches(l) -> Mode.NORMAL
            else -> null
        }
    }

    /** Listen only / Don't remember: the whole line is one of the person's own words that end it. */
    fun isOwnRelease(lower: String): Boolean {
        val l = fold(lower)
        val words = when (mode.value) { Mode.LISTEN -> releaseWords.value; else -> emptyList() }
        return words.any { fold(it) == l }
    }

    private fun fold(s: String): String =
        java.text.Normalizer.normalize(s.lowercase(), java.text.Normalizer.Form.NFKD)
            .replace(Regex("\\p{M}+"), "").replace(Regex("[^\\p{L}\\p{N}\\s]"), " ").replace(Regex("\\s+"), " ").trim()

    fun ack(m: Mode, from: Mode = mode.value): String = when (m) {
        Mode.LISTEN -> "Okay, just listening."
        Mode.NAME -> "Okay, only when you say my name."
        Mode.FORGET -> "Okay, I won't remember any of this."
        Mode.NORMAL -> if (from == Mode.FORGET) "Okay, I'm remembering again." else "I'm back."
    }
}
