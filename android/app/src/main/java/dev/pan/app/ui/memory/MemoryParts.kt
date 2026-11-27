package dev.pan.app.ui.memory

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.pan.app.ui.settings.rememberDeveloperMode
import dev.pan.app.util.LastCrash
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** The three parts of the Memory tab (task 1093, the owner Nov 27): one drop down, like People's. */
enum class MemoryPart(val label: String) { MEMORY("Memory"), DIVIDEND("Data dividend"), REPORTS("Reports") }

@Composable
internal fun MemoryPartPicker(part: MemoryPart, onPick: (MemoryPart) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }, contentPadding = PaddingValues(0.dp)) {
            Text(part.label, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface)
            Icon(Icons.Default.ArrowDropDown, contentDescription = "Choose what to show")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            MemoryPart.entries.forEach { p ->
                DropdownMenuItem(text = { Text(p.label, fontWeight = if (p == part) FontWeight.SemiBold else FontWeight.Normal) },
                    onClick = { open = false; onPick(p) })
            }
        }
    }
}

private val WHEN = DateTimeFormatter.ofPattern("MMM d, h:mm a")
private fun whenText(ms: Long) = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).format(WHEN)

@Composable
private fun Note(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
}

// ---- Reports ------------------------------------------------------------------------------------

private data class Fault(val id: Long, val part: String, val what: String, val version: String,
                         val detail: String, val lastAt: Long, val times: Int)

/**
 * Faults ΠAN noticed in itself (the hub's fault-reports.js, task 1092), and this phone's last
 * crash. Nothing personal is in them. They are kept here and sent nowhere: where they would go is
 * not decided. Tapping one shows exactly what a report would carry.
 */
@Composable
internal fun ReportsPart(viewModel: MemoryViewModel) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var faults by remember { mutableStateOf<List<Fault>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var showing by remember { mutableStateOf<Fault?>(null) }
    val crash = remember { LastCrash.read(context)?.lineSequence()?.firstOrNull { it.isNotBlank() }?.take(160) }

    suspend fun load() {
        val r = viewModel.hub("GET", "/api/v1/reports")
        if (r == null || r.first != 200) { failed = true; return }
        val arr = r.second.optJSONArray("reports")
        faults = (0 until (arr?.length() ?: 0)).map { i ->
            val o = arr!!.getJSONObject(i)
            Fault(o.optLong("id"), o.optString("part"), o.optString("what"), o.optString("version"),
                o.optString("detail"), o.optLong("last_at"), o.optInt("times", 1))
        }
    }
    LaunchedEffect(Unit) { load() }

    Column(Modifier.fillMaxSize()) {
        Note("Faults ΠAN noticed in itself. Nothing you said is in them. They stay here: nothing is sent anywhere yet.")
        if (crash != null) {
            ListItem(headlineContent = { Text("The app crashed on this phone") },
                supportingContent = { Text(crash, style = MaterialTheme.typography.bodySmall) })
            HorizontalDivider()
        }
        val list = faults
        when {
            list == null && failed -> Note("ΠAN could not be reached. Its reports show here when it can.")
            list == null -> LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 20.dp))
            list.isEmpty() && crash == null -> Note("No faults. ΠAN has not noticed anything broken.")
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(list, key = { it.id }) { f ->
                    ListItem(
                        modifier = Modifier.clickable { showing = f },
                        headlineContent = { Text(f.what) },
                        supportingContent = {
                            Text("${f.part}, version ${f.version}. " +
                                (if (f.times > 1) "${f.times} times, last ${whenText(f.lastAt)}" else whenText(f.lastAt)),
                                style = MaterialTheme.typography.bodySmall)
                        },
                        trailingContent = {
                            IconButton(onClick = { scope.launch {
                                val r = viewModel.hub("DELETE", "/api/v1/reports/${f.id}")
                                if (r != null && r.first == 200) faults = faults?.filterNot { it.id == f.id }
                            } }) { Icon(Icons.Default.Delete, contentDescription = "Remove this report") }
                        },
                    )
                    HorizontalDivider()
                }
            }
        }
    }

    showing?.let { f ->
        val json = JSONObject().put("part", f.part).put("what", f.what).put("version", f.version)
            .put("detail", f.detail).put("times", f.times).toString(2)
        AlertDialog(
            onDismissRequest = { showing = null },
            title = { Text(f.what) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text("This is all a report would carry. It is not sent: where reports go is not decided yet.",
                        style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(8.dp))
                    Text(json, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = { TextButton(onClick = { showing = null }) { Text("Close") } },
        )
    }
}

// ---- Data dividend ------------------------------------------------------------------------------

/** One buyer question and what each yes would let happen (the hub's dividend.js). */
private data class Ask(val buyer: String, val question: String, val step: String,
                       val runSummary: String, val runJson: String, val answerSummary: String, val answerJson: String)

private val EXAMPLE = Ask(
    buyer = "A sleep study (example)",
    question = "On average, how many hours a night does this person sleep, over the last 30 days?",
    step = "waiting_run",
    runSummary = "It reads when your phone was put down and picked up at night, for the last 30 days, and counts the hours. It reads nothing you said, no names, no places.",
    runJson = JSONObject().put("reads", org.json.JSONArray().put("phone_idle_at_night")).put("days", 30)
        .put("returns", "average_hours").toString(2),
    answerSummary = "One number: 7.1 hours a night. Nothing else leaves.",
    answerJson = JSONObject().put("average_sleep_hours", 7.1).toString(2),
)

private fun stepText(step: String) = when (step) {
    "waiting_run" -> "Waiting for your first yes: may it run?"
    "waiting_send" -> "Waiting for your second yes: may the answer leave?"
    "sent" -> "Answered"
    "declined" -> "You said no"
    else -> step
}

/**
 * Data dividend (tasks 1093 and 1095). Off until turned on in Settings > Privacy. With it on, a
 * buyer's question lands here and nothing runs: two yeses, each shown as a plain summary first and
 * then the exact JSON. There is no market yet, so no buyer can ask; developers can walk through an
 * example (nothing runs, nothing is sent).
 */
@Composable
internal fun DividendPart(viewModel: MemoryViewModel) {
    val developer by rememberDeveloperMode()
    var on by remember { mutableStateOf<Boolean?>(null) }
    var asks by remember { mutableStateOf<List<Ask>>(emptyList()) }
    var failed by remember { mutableStateOf(false) }
    var review by remember { mutableStateOf<Ask?>(null) }

    LaunchedEffect(Unit) {
        val r = viewModel.hub("GET", "/api/v1/dividend")
        if (r == null || r.first != 200) { failed = true; return@LaunchedEffect }
        on = r.second.optBoolean("on", false)
        val arr = r.second.optJSONArray("questions")
        asks = (0 until (arr?.length() ?: 0)).map { i ->
            val o = arr!!.getJSONObject(i)
            Ask(o.optString("buyer"), o.optString("question"), o.optString("step"), o.optString("run_summary"),
                o.optString("run_json"), o.optString("answer_summary"), o.optString("answer_json"))
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        when (on) {
            null -> if (failed) Note("ΠAN could not be reached.") else LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 20.dp))
            false -> Note("Data dividend is off, so nothing is shared and no buyer can ask. You can turn it on in Settings, Privacy.")
            true -> if (asks.isEmpty()) Note("No buyer has asked anything yet. A question shows here first, and nothing runs until you say yes twice.")
        }
        asks.forEach { a ->
            ListItem(headlineContent = { Text(a.question) },
                supportingContent = { Text("${a.buyer}. ${stepText(a.step)}", style = MaterialTheme.typography.bodySmall) })
            HorizontalDivider()
        }
        Note("When a buyer asks, you see what their algorithm would read, then the exact JSON, and say yes or no. If it runs, you see the answer the same way before it leaves. You get 99 of every 100 it pays.")
        if (developer) {
            OutlinedButton(onClick = { review = EXAMPLE }, modifier = Modifier.padding(horizontal = 20.dp)) { Text("Walk through an example") }
        }
    }

    review?.let { a -> TwoYeses(a) { review = null } }
}

/** The two reviews, each a summary page and then the exact JSON. The example only: nothing runs. */
@Composable
private fun TwoYeses(a: Ask, onDone: () -> Unit) {
    // 0 run summary, 1 run JSON, 2 answer summary, 3 answer JSON, 4 done, 5 said no
    var page by remember { mutableIntStateOf(0) }
    val title = when (page) { 0, 1 -> "May it run?"; 2, 3 -> "May the answer leave?"; 4 -> "Done"; else -> "Stopped" }
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text(title) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (page <= 3) {
                    Text("${a.buyer} asks: ${a.question}", style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(8.dp))
                }
                when (page) {
                    0 -> Text(a.runSummary)
                    1 -> { Text("Exactly what it would run:", style = MaterialTheme.typography.bodySmall)
                           Text(a.runJson, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                    2 -> Text(a.answerSummary)
                    3 -> { Text("Exactly what would leave:", style = MaterialTheme.typography.bodySmall)
                           Text(a.answerJson, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                    4 -> Text("This was an example: nothing ran and nothing was sent.")
                    else -> Text("Nothing ran and nothing was sent.")
                }
            }
        },
        confirmButton = {
            when (page) {
                0, 2 -> TextButton(onClick = { page++ }) { Text("Show the JSON") }
                1 -> TextButton(onClick = { page = 2 }) { Text("Yes, let it run") }
                3 -> TextButton(onClick = { page = 4 }) { Text("Yes, let it leave") }
                else -> TextButton(onClick = onDone) { Text("Close") }
            }
        },
        dismissButton = { if (page <= 3) TextButton(onClick = { page = 5 }) { Text("No") } },
    )
}
