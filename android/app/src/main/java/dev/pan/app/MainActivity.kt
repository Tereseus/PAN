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
import androidx.lifecycle.lifecycleScope
import dagger.hilt.android.AndroidEntryPoint
import dev.pan.app.service.PanForegroundService
import dev.pan.app.tts.TtsManager
import dev.pan.app.ui.navigation.PanNavGraph
import dev.pan.app.ui.theme.PanTheme
import dev.pan.app.update.UpdateChecker
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var tts: TtsManager
    @Inject lateinit var updateChecker: UpdateChecker

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
            Manifest.permission.READ_CALENDAR,
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

        // Self-update check — non-blocking, runs once per launch.
        // Delay 8s so Tailscale has time to come up (UpdateChecker prefers
        // the tailnet base URL and falls back to LAN if it isn't ready).
        lifecycleScope.launch {
            delay(8_000)
            updateChecker.checkAndInstall(this@MainActivity, silent = true)
        }
    }

    /**
     * Only the power button silences TTS.
     *
     * This used to catch EVERY key and `return true`, which consumed the event.
     * So reaching for volume-up while PAN was talking both cut it off AND threw
     * the keypress away, meaning the volume never actually changed - you could
     * not turn it up, only mute it by accident.
     *
     * KEYCODE_POWER is normally swallowed by the system and never reaches an
     * app, so the screen-off receiver below is what makes "power stops it"
     * actually work. This branch is kept for the devices that do deliver it.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_POWER && tts.isSpeaking) {
            tts.stop()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    /** Pressing power turns the screen off, which is the signal we can actually see. */
    private val screenOffReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(c: android.content.Context?, i: Intent?) {
            if (i?.action == Intent.ACTION_SCREEN_OFF && tts.isSpeaking) tts.stop()
        }
    }

    override fun onStart() {
        super.onStart()
        // ACTION_SCREEN_OFF is not sent to manifest-declared receivers, so it
        // has to be registered at runtime.
        registerReceiver(screenOffReceiver, android.content.IntentFilter(Intent.ACTION_SCREEN_OFF))
    }

    override fun onStop() {
        super.onStop()
        try { unregisterReceiver(screenOffReceiver) } catch (_: IllegalArgumentException) {}
    }

    private fun startPanService() {
        val intent = Intent(this, PanForegroundService::class.java)
        startForegroundService(intent)
    }
}
