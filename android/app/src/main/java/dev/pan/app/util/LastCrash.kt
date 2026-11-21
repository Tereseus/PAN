package dev.pan.app.util

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The last time the app crashed, kept on the device for "Send a report" (the owner, 2026-11-21).
 * PanApplication's crash handler writes it; the report reads it.
 *
 * Only where in the code it broke: the kinds of error and the lines of code, never their messages.
 * A message can carry anything (a line ΠAN was saying, a hub address), and the report must not.
 */
object LastCrash {
    private const val FILE = "last_crash.txt"
    private const val MAX_FRAMES = 40

    /** The error and its causes as kinds and code lines only. No messages. */
    fun format(t: Throwable): String = buildString {
        var e: Throwable? = t
        var depth = 0
        val seen = HashSet<Throwable>()
        while (e != null && depth < 6 && seen.add(e)) {
            append(if (depth == 0) "" else "Caused by: ").append(e.javaClass.name).append('\n')
            e.stackTrace.take(MAX_FRAMES).forEach { append("\tat ").append(it.toString()).append('\n') }
            if (e.stackTrace.size > MAX_FRAMES) append("\t... ").append(e.stackTrace.size - MAX_FRAMES).append(" more\n")
            e = e.cause
            depth++
        }
    }

    /** Called from the crash handler: quick, and never throws. */
    fun write(context: Context, thread: Thread, t: Throwable, version: String) {
        runCatching {
            val at = SimpleDateFormat("yyyy-MM-dd HH:mm:ss 'UTC'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
            File(context.filesDir, FILE).writeText("$at, app $version, thread ${thread.name.take(40)}\n${format(t)}")
        }
    }

    fun read(context: Context): String? = runCatching { File(context.filesDir, FILE).takeIf { it.exists() }?.readText() }.getOrNull()
}
