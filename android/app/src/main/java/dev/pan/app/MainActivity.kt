package dev.pan.app

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import dagger.hilt.android.AndroidEntryPoint
import dev.pan.app.service.PanForegroundService
import dev.pan.app.tts.TtsManager
import dev.pan.app.ui.navigation.PanNavGraph
import dev.pan.app.ui.theme.PanTheme
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var tts: TtsManager

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        // Start the service regardless — it'll handle missing permissions gracefully
        startPanService()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Request all permissions upfront
        val permissions = mutableListOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            permissions.add(Manifest.permission.BLUETOOTH_SCAN)
            permissions.add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        permissionLauncher.launch(permissions.toTypedArray())

        setContent {
            PanTheme {
                PanNavGraph()
            }
        }
    }

    // Any hardware key press (volume, power) stops TTS
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (tts.isSpeaking) {
            tts.stop()
            return true // consume the event
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun startPanService() {
        val intent = Intent(this, PanForegroundService::class.java)
        startForegroundService(intent)
    }
}
