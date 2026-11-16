package dev.pan.app.assist

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import dev.pan.app.service.PanForegroundService

/**
 * The assistant button: a car's steering wheel voice button, a headset's long press, or the
 * phone's own assistant gesture, once ΠAN is picked as the assistant.
 *
 * The owner's Joying head unit (Nov 14): the wheel button makes com.car.service start VOICE_ASSIST with
 * no package, and Android asks which app. No screen here: it tells PanForegroundService that the
 * next line is for ΠAN (ADDRESS_PAN: mic on if muted, PAN stops talking, a beep) and closes.
 */
class VoiceAssistActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i("VoiceAssist", "assistant button: ${intent?.action}")
        runCatching {
            startForegroundService(Intent(this, PanForegroundService::class.java).setAction(PanForegroundService.ACTION_ADDRESS_PAN))
        }.onFailure { Log.w("VoiceAssist", "could not reach the service: ${it.message}") }
        finish()
        overridePendingTransition(0, 0)
    }
}
