package dev.pan.app.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

private data class SmartChoice(
    val id: String, val name: String, val note: String, val bench: String,
    val own: String, val testMin: Int,
)

/** The hub's test that is running now (smart-model-test.js), or null. */
private data class SmartTest(val id: String, val done: Int, val of: Int, val waiting: Boolean)

/**
 * The smart model picker (task 1091): the big model ΠAN hands hard problems to. The hub lists
 * what it can use (the person's own Claude, Codex or Antigravity sign in, or a big model on their
 * own Ollama; service/src/smart-model-pick.js) and keeps the pick. Owner only: a person's device
 * shows nothing here.
 */
@Composable
internal fun SmartModelSection(viewModel: SettingsViewModel, snackbar: SnackbarHostState) {
    val scope = rememberCoroutineScope()
    var choices by remember { mutableStateOf<List<SmartChoice>>(emptyList()) }
    var current by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var testing by remember { mutableStateOf<SmartTest?>(null) }

    fun readTest(o: JSONObject?): SmartTest? {
        if (o == null || o.optBoolean("finished", true)) return null
        return SmartTest(o.optString("id"), o.optInt("done"), o.optInt("of"), o.optBoolean("waiting"))
    }

    suspend fun load() {
        if (!viewModel.ownersDevice()) return
        val r = viewModel.hub("GET", "/api/v1/setup/smart-model/choices") ?: return
        if (r.first != 200) return
        val arr = r.second.optJSONArray("choices") ?: return
        choices = (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            SmartChoice(o.optString("id"), o.optString("name"), o.optString("note"), o.optString("bench"),
                o.optString("own"), o.optInt("test_min", 2))
        }
        current = r.second.optString("current")
        testing = readTest(r.second.optJSONObject("test"))
    }

    // "Test it on this computer" (task 1098): the hub runs the made-up twin bench with this choice.
    suspend fun test(id: String) {
        val r = viewModel.hub("POST", "/api/v1/setup/smart-model/test", JSONObject().put("id", id))
        when {
            r == null -> snackbar.showSnackbar("ΠAN could not start the test right now.")
            r.first == 409 -> snackbar.showSnackbar("A test is already running.")
            r.first != 200 -> snackbar.showSnackbar("ΠAN could not start the test right now.")
            else -> testing = SmartTest(id, 0, r.second.optInt("of", 20), false)
        }
    }

    suspend fun pick(id: String) {
        busy = true
        val r = viewModel.hub("PUT", "/api/v1/setup/smart-model", JSONObject().put("id", id))
        busy = false
        if (r == null || r.first != 200) snackbar.showSnackbar("ΠAN could not change that right now.")
        else current = r.second.optString("current", id)
    }

    LaunchedEffect(Unit) { load() }
    // While a test runs, ask the hub how far it is every 10 s; when it ends, read the choices again.
    LaunchedEffect(testing?.id) {
        while (testing != null) {
            delay(10_000)
            val r = viewModel.hub("GET", "/api/v1/setup/smart-model/test") ?: continue
            if (r.first != 200) continue
            val now = readTest(r.second.optJSONObject("test"))
            if (now == null) { testing = null; load() } else testing = now
        }
    }
    if (choices.isEmpty()) return

    Text("Smart model", style = MaterialTheme.typography.titleMedium)
    Text("The big model ΠAN hands hard problems to, with your own sign in. ΠAN pays nobody for it.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant)
    choices.forEach { c ->
        Row(
            Modifier.fillMaxWidth().clickable(enabled = !busy && c.id != current) { scope.launch { pick(c.id) } }.padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = c.id == current, enabled = !busy, onClick = { scope.launch { pick(c.id) } })
            Column {
                Text(c.name, style = MaterialTheme.typography.bodyLarge)
                Text(c.note, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                // Our own numbers for this choice (the hub's bench-reference.json, task 1098).
                if (c.bench.isNotBlank()) Text(c.bench, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                // The person's own test of it on this computer, and the button to run one.
                if (c.own.isNotBlank()) Text(c.own, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                val t = testing
                when {
                    t != null && t.id == c.id -> Text(
                        if (t.waiting) "Testing, waits while you talk (${t.done} of ${t.of} done)"
                        else "Testing, about ${c.testMin} minutes (${t.done} of ${t.of} done)",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    else -> TextButton(onClick = { scope.launch { test(c.id) } }, enabled = t == null) {
                        Text("Test it on this computer")
                    }
                }
            }
        }
    }
    HorizontalDivider()
}
