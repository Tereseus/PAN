package dev.pan.app.vpn

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import dagger.hilt.android.AndroidEntryPoint
import dev.pan.app.service.PanForegroundService
import dev.pan.app.ui.theme.PanTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import javax.inject.Inject

/**
 * Opens for a pan://pair link: scanning the hub's pairing QR with the camera, or tapping
 * the link. It asks first: any web page or message can hold such a link, and a pairing
 * decides which computer this phone sends everything to. Then it pairs over PAN Link,
 * says how it went, and closes. The question is its only screen.
 */
@AndroidEntryPoint
class PairActivity : ComponentActivity() {

    @Inject lateinit var link: LinkManager

    private var asking by mutableStateOf(true)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val code = intent?.dataString
        if (code == null || !code.startsWith("pan://pair")) {
            finish()
            return
        }
        // The name comes from whoever made the code, so it vouches for nothing. What keeps
        // a link from pairing the phone on its own is that a person has to say yes.
        val name = runCatching { Uri.parse(code).getQueryParameter("n") }.getOrNull()
            ?.trim()?.takeIf { it.isNotEmpty() }?.take(60) ?: "a PAN computer"
        val current = if (link.isPaired()) currentHubName() else null
        setContent {
            PanTheme {
                if (asking) {
                    AlertDialog(
                        onDismissRequest = { finish() },
                        title = { Text("Pair with \"$name\"?") },
                        text = {
                            Text(buildString {
                                append("Only use a code shown by PAN on your own computer. ")
                                append("This phone will send what you say and do in PAN to that computer.")
                                if (current != null) append("\n\nThis replaces the pairing with \"$current\".")
                            })
                        },
                        confirmButton = { TextButton(onClick = { pair(code, name) }) { Text("Pair") } },
                        dismissButton = { TextButton(onClick = { finish() }) { Text("Cancel") } },
                    )
                }
            }
        }
    }

    private fun currentHubName(): String =
        runCatching { JSONObject(link.status()).optString("hub_name") }.getOrNull()
            ?.takeIf { it.isNotBlank() } ?: "your PAN computer"

    private fun pair(code: String, name: String) {
        if (!asking) return
        asking = false
        // The app's Tailscale may be the only way to the hub, and it starts with this service.
        runCatching { startForegroundService(Intent(this, PanForegroundService::class.java)) }
        toast("Pairing with \"$name\"…")
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { link.pair(code) } }
            result
                .onSuccess { toast("Paired. This phone reaches PAN over PAN Link now.") }
                .onFailure {
                    Log.e("PanLink", "pairing failed: ${it.message}")
                    toast("Pairing failed: ${it.message}")
                }
            finish()
        }
    }

    private fun toast(message: String) =
        Toast.makeText(applicationContext, message, Toast.LENGTH_LONG).show()
}
