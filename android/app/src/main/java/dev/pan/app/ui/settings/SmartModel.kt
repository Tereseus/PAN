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
import kotlinx.coroutines.launch
import org.json.JSONObject

private data class SmartChoice(val id: String, val name: String, val note: String)

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

    suspend fun load() {
        if (!viewModel.ownersDevice()) return
        val r = viewModel.hub("GET", "/api/v1/setup/smart-model/choices") ?: return
        if (r.first != 200) return
        val arr = r.second.optJSONArray("choices") ?: return
        choices = (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            SmartChoice(o.optString("id"), o.optString("name"), o.optString("note"))
        }
        current = r.second.optString("current")
    }

    suspend fun pick(id: String) {
        busy = true
        val r = viewModel.hub("PUT", "/api/v1/setup/smart-model", JSONObject().put("id", id))
        busy = false
        if (r == null || r.first != 200) snackbar.showSnackbar("ΠAN could not change that right now.")
        else current = r.second.optString("current", id)
    }

    LaunchedEffect(Unit) { load() }
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
            }
        }
    }
    HorizontalDivider()
}
