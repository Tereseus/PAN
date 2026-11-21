package dev.pan.app.ui.settings

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.content.FileProvider
import dev.pan.app.BuildConfig
import dev.pan.app.tts.PiperTtsEngine
import dev.pan.app.tts.VoiceChoice
import dev.pan.app.tts.VoicePace
import dev.pan.app.tts.VoiceTiming
import dev.pan.app.util.LastCrash
import java.io.File
import java.util.Locale

/**
 * "Send a report" (Settings, Updates and about; every user, the owner 2026-11-21). A plain text
 * file with ONLY: the app version, the phone's maker, model and chip, the Android version, its
 * memory, how fast it builds ΠAN's voice, the voice speed setting, and where the app last
 * crashed. Never anything said, ΠAN's replies, names, contacts, places, messages, hub addresses,
 * the device name typed in Settings, or keys. [text] takes plain values so nothing else can slip in.
 */
object PanReport {
    data class Facts(
        val versionName: String, val versionCode: Int,
        val maker: String, val model: String, val chip: String,
        val android: String, val sdk: Int, val ramBytes: Long,
        val timing: VoiceTiming.Stats, val pace: String, val crash: String?,
    )

    fun facts(context: Context): Facts {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val chip = listOf(Build.SOC_MANUFACTURER, Build.SOC_MODEL).filter { it.isNotBlank() && it != Build.UNKNOWN }.joinToString(" ")
        val voice = PiperTtsEngine.VOICES[VoiceChoice.MAIN]
        val pace = voice?.let { VoicePace.describe(VoicePace.current(context, it)) } ?: ""
        return Facts(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE, Build.MANUFACTURER, Build.MODEL, chip,
            Build.VERSION.RELEASE, Build.VERSION.SDK_INT, mem.totalMem, VoiceTiming.stats(context), pace, LastCrash.read(context))
    }

    fun text(f: Facts): String = buildString {
        appendLine("ΠAN report")
        appendLine("App: ${f.versionName} (${f.versionCode})")
        appendLine("Phone: ${f.maker} ${f.model}")
        appendLine("Chip: ${f.chip.ifBlank { "not known" }}")
        appendLine("Android: ${f.android} (API ${f.sdk})")
        appendLine("Memory: ${String.format(Locale.US, "%.1f", f.ramBytes / 1_073_741_824.0)} GB")
        appendLine("Voice speed: ${f.pace.ifBlank { "not known" }}")
        if (f.timing.empty) appendLine("Voice timing: no lines measured yet")
        else appendLine("Voice timing: ${f.timing.ratio} ms to build each second of speech, ${f.timing.medianBuildMs} ms a line, over ${f.timing.count} lines")
        appendLine()
        if (f.crash.isNullOrBlank()) appendLine("Last crash: none kept")
        else { appendLine("Last crash:"); append(f.crash.trimEnd()); appendLine() }
    }

    fun build(context: Context): String = text(facts(context))

    /** The share sheet, with the report as a file and as the text. No address: the person picks one. */
    fun share(context: Context, report: String) {
        val dir = File(context.cacheDir, "reports").apply { mkdirs() }
        val file = File(dir, "pan-report.txt").apply { writeText(report) }
        val uri = FileProvider.getUriForFile(context, "dev.pan.app.fileprovider", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "PAN report ${BuildConfig.VERSION_NAME}")
            putExtra(Intent.EXTRA_TEXT, report)
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = android.content.ClipData.newRawUri("", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(send, "Send the report").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
