package dev.pan.app.ui.settings

import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Settings > Privacy > Data Dividend (task 1095, the owner Nov 27). Off until the person turns it
 * on; with it on a buyer may ASK, and every question waits in Memory > Data Dividend for two
 * yeses. The hub keeps the switch (dividend.js). Owner only: a person's device shows nothing.
 */
@Composable
internal fun DividendSwitch(viewModel: SettingsViewModel, snackbar: SnackbarHostState) {
    val scope = rememberCoroutineScope()
    var on by remember { mutableStateOf<Boolean?>(null) }

    LaunchedEffect(Unit) {
        if (!viewModel.ownersDevice()) return@LaunchedEffect
        val r = viewModel.hub("GET", "/api/v1/dividend")
        if (r != null && r.first == 200) on = r.second.optBoolean("on", false)
    }
    val now = on ?: return

    SettingToggle(
        title = "Data Dividend",
        description = if (now) "On. A buyer may ask a question. It waits in Memory, Data Dividend, and nothing runs or leaves without your yes, twice"
                      else "Off. Nothing is shared and no buyer can ask. Turn it on to be paid when you agree to answer",
        checked = now,
        onToggle = { want ->
            scope.launch {
                val r = viewModel.hub("PUT", "/api/v1/dividend", JSONObject().put("on", want))
                if (r != null && r.first == 200) on = r.second.optBoolean("on", want)
                else snackbar.showSnackbar("ΠAN could not change that right now.")
            }
        }
    )
}
