package dev.pan.app.ui.hub

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The words the Models tab shows for a machine. Pure, so it is tested (MachineTextTest). */
object MachineText {
    /** "72 tokens a second on pan-phi-r1, tested 6:08 AM", or "Not tested yet". */
    fun speed(tokS: Double, model: String, at: String, zone: ZoneId = ZoneId.systemDefault()): String {
        if (tokS <= 0.0) return "Not tested yet"
        val n = if (tokS >= 10) String.format(Locale.US, "%.0f", tokS) else String.format(Locale.US, "%.1f", tokS)
        val whenText = runCatching { DateTimeFormatter.ofPattern("MMM d, h:mm a", Locale.US).format(Instant.parse(at).atZone(zone)) }.getOrNull()
        return buildString {
            append("$n tokens a second")
            if (model.isNotBlank()) append(" on ${short(model)}")
            if (whenText != null) append(", tested $whenText")
        }
    }

    /** "pan-phi-r1 3.1 GB, all on the card", "gemma4:e4b 6.6 GB, on the processor", "… 72% on the card". */
    fun loaded(l: LoadedModel): String {
        val where = when {
            l.onCardPct >= 100 -> "all on the card"
            l.onCardPct <= 0 -> "on the processor"
            else -> "${l.onCardPct}% on the card"
        }
        val gb = if (l.gb > 0) String.format(Locale.US, " %.1f GB", l.gb) else ""
        return "${short(l.name)}$gb, $where"
    }

    /** "Answer model: pan-phi-r1. The hub takes over if the-box is off." */
    fun run(r: MachineRun): String {
        val line = if (r.model.isBlank()) r.what else "${r.what}: ${short(r.model)}"
        return if (r.note.isBlank()) line else "$line. ${r.note.replaceFirstChar { it.uppercase() }}."
    }

    /** A model name without the "ollama:"/"reader:" prefix and the ":latest" tag. */
    fun short(name: String): String = name.substringAfter("ollama:").substringAfter("reader:").removeSuffix(":latest")
}
