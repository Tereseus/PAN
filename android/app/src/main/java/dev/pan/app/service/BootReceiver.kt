package dev.pan.app.service

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Log.i("PAN", "Boot completed — starting PAN service")
            val serviceIntent = Intent(context, PanForegroundService::class.java)
            context.startForegroundService(serviceIntent)
        }
    }
}
