package dev.pan.app.util

import android.media.AudioFormat

object Constants {
    // BLE UUIDs (must match ESP32 firmware)
    const val PAN_SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
    const val PAN_PHOTO_CHAR_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8"
    const val PAN_SENSOR_CHAR_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a9"
    const val PAN_COMMAND_CHAR_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26aa"
    const val PAN_AUDIO_CHAR_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26ab"

    // Audio capture
    const val SAMPLE_RATE = 16000
    const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
    const val AUDIO_ENCODING = AudioFormat.ENCODING_PCM_16BIT
    const val VAD_ENERGY_THRESHOLD = 50.0

    // Network
    const val DEFAULT_SERVER_URL = "http://192.168.1.248:7777"
    const val SYNC_INTERVAL_MS = 5000L

    // Notification
    const val NOTIFICATION_CHANNEL_ID = "pan_foreground"
    const val NOTIFICATION_ID = 1
}
