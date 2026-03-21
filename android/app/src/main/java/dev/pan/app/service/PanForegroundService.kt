package dev.pan.app.service

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.AlarmClock
import android.util.Log
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import dagger.hilt.android.AndroidEntryPoint
import dev.pan.app.MainActivity
import dev.pan.app.audio.FeedbackSounds
import dev.pan.app.camera.CameraCapture
import dev.pan.app.data.DataRepository
import dev.pan.app.network.PanServerClient
import dev.pan.app.network.SyncManager
import dev.pan.app.network.dto.AudioUpload
import dev.pan.app.ai.GeminiBrain
import dev.pan.app.audio.VoiceCollector
import dev.pan.app.stt.GoogleStreamingStt
import dev.pan.app.tts.TtsManager
import dev.pan.app.util.Constants
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import javax.inject.Inject

@AndroidEntryPoint
class PanForegroundService : Service() {

    companion object {
        private const val TAG = "PanService"
        val lastAction = MutableStateFlow("")
        val micEnabled = MutableStateFlow(true)
    }

    @Inject lateinit var serverClient: PanServerClient
    @Inject lateinit var syncManager: SyncManager
    @Inject lateinit var dataRepository: DataRepository
    @Inject lateinit var sttEngine: GoogleStreamingStt
    @Inject lateinit var feedbackSounds: FeedbackSounds
    @Inject lateinit var tts: TtsManager
    @Inject lateinit var geminiBrain: GeminiBrain
    @Inject lateinit var voiceCollector: VoiceCollector
    @Inject lateinit var cameraCapture: CameraCapture

    private val serviceScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val mainHandler = Handler(Looper.getMainLooper())
    private var wakeLock: PowerManager.WakeLock? = null
    private var notificationManager: NotificationManager? = null

    // Dedup: prevent duplicate commands within 3 seconds
    private var lastProcessedText = ""
    private var lastProcessedTime = 0L
    private val DEDUP_WINDOW_MS = 3000L
    private val convoTracker = ConversationTracker()
    private var isMuted = false
    private var flashlightOn = false
    private var lastTtsDoneTime = 0L  // When TTS last finished speaking
    private val TTS_COOLDOWN_MS = 1000L  // Ignore speech for 1s after TTS finishes

    // Recent conversation history — sent to server so Claude has context
    private val conversationHistory = mutableListOf<Pair<String, String>>() // role, text
    private val MAX_HISTORY = 10

    private fun addToHistory(role: String, text: String) {
        conversationHistory.add(role to text)
        while (conversationHistory.size > MAX_HISTORY) conversationHistory.removeAt(0)
    }

    private fun getHistoryContext(): String {
        if (conversationHistory.isEmpty()) return ""
        return conversationHistory.joinToString("\n") { (role, text) ->
            "$role: ${text.take(200)}"
        }
    }

    // Persistent log — sends to PAN server so logs are always available
    private fun panLog(msg: String) {
        Log.i(TAG, msg)
        serviceScope.launch {
            try {
                serverClient.sendAudio(AudioUpload(
                    transcript = msg,
                    timestamp = System.currentTimeMillis(),
                    duration_ms = 0,
                    source = "phone_log"
                ))
            } catch (_: Exception) {}
        }
    }

    override fun onCreate() {
        super.onCreate()
        panLog("PAN service created")

        notificationManager = getSystemService(NotificationManager::class.java)
        createNotificationChannel()

        // Request battery optimization exemption so Android doesn't kill our audio
        requestBatteryExemption()

        val hasMicPermission = ContextCompat.checkSelfPermission(
            this, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

        if (hasMicPermission) {
            ServiceCompat.startForeground(
                this,
                Constants.NOTIFICATION_ID,
                buildNotification(listening = true, connected = false),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            )

            // Wire up logging
            sttEngine.onLog = { msg -> panLog(msg) }
            geminiBrain.onLog = { msg -> panLog(msg) }

            // When TTS finishes speaking, restart STT listening
            sttEngine.isTtsSpeaking = { tts.isSpeaking }
            sttEngine.onInterrupt = { panLog("User interrupted TTS"); tts.stop() }
            tts.onSpeakingStateChanged = { speaking ->
                if (!speaking) {
                    lastTtsDoneTime = System.currentTimeMillis()
                    if (sttEngine.enabled && !sttEngine.isListening) {
                        sttEngine.startListening { text, isFinal ->
                            if (text.isNotBlank() && isFinal) onSpeech(text)
                        }
                    }
                }
            }

            // Initialize Gemini Nano for on-device AI
            serviceScope.launch {
                val ready = geminiBrain.initialize()
                panLog("Gemini: ${if (ready) "ready" else "not available, using server"}")
            }

            // Voice collector — DISABLED on phone (Android can't run two AudioRecords)
            // Raw audio for voice training comes from PC mic or pendant
            // Phone only saves transcripts via STT callback
            voiceCollector.onLog = { msg -> panLog(msg) }

            // Google Streaming STT — real-time transcription, no chunks
            sttEngine.startListening { text, isFinal ->
                if (text.isNotBlank() && isFinal) {
                    voiceCollector.onTranscript(text) // Pair audio with transcript
                    onSpeech(text)
                }
            }
            panLog("Google STT + Voice Collector started")
        } else {
            startForeground(Constants.NOTIFICATION_ID, buildNotification(listening = false, connected = false))
            panLog("No mic permission — running without audio")
        }

        acquireWakeLock()
        serviceScope.launch { syncManager.start() }

        // Notification updater
        serviceScope.launch {
            serverClient.isConnected.collect { connected ->
                notificationManager?.notify(
                    Constants.NOTIFICATION_ID,
                    buildNotification(listening = sttEngine.enabled, connected = connected)
                )
            }
        }
    }

    // Stop STT before speaking, restart after TTS finishes
    private fun panSpeak(text: String) {
        sttEngine.registerTtsOutput(text)
        sttEngine.stopListening()  // Stop STT so it doesn't steal audio focus from TTS
        tts.speak(text)
        // STT restarts when TTS finishes via onSpeakingStateChanged + cooldown
    }

    // Log every command to the server so it's always visible for debugging
    private fun logToServer(text: String, intent: String, result: String, handledBy: String) {
        serviceScope.launch {
            try {
                serverClient.sendAudio(AudioUpload(
                    transcript = "[$handledBy|$intent] $text -> $result",
                    timestamp = System.currentTimeMillis(),
                    duration_ms = 0,
                    source = "phone_command_log"
                ))
            } catch (_: Exception) {}
        }
    }

    private fun onSpeech(text: String) {
        val lower = text.lowercase().trim()

        // Dedup — ignore identical text within 3 seconds
        val now = System.currentTimeMillis()
        if (lower == lastProcessedText && now - lastProcessedTime < DEDUP_WINDOW_MS) {
            panLog("Dedup skipped: $lower")
            return
        }
        lastProcessedText = lower
        lastProcessedTime = now

        panLog("Heard: $text")
        lastAction.value = text

        // Cooldown after TTS — ignore echo/residual audio for 2 seconds after PAN stops talking
        if (System.currentTimeMillis() - lastTtsDoneTime < TTS_COOLDOWN_MS) {
            panLog("Cooldown (ignoring post-TTS echo): ${lower.take(30)}")
            return
        }

        // Stop talking — only exact short phrases while TTS is active
        if (tts.isSpeaking) {
            if (lower.contains("stop") || lower.contains("enough") || lower.contains("shut up") || lower.contains("quiet")) {
                tts.stop()
                panLog("TTS stopped by user: $lower")
                return
            }
            // TTS is still talking and user said something else — ignore it (probably echo)
            return
        }

        // Mute / unmute check — before any other processing
        if ((lower.contains("mute") && !lower.contains("unmute")) || lower.contains("shut up") || lower.contains("be quiet")) {
            panLog("PAN muted by voice command")
            isMuted = true
            sttEngine.enabled = false
            micEnabled.value = false
            notificationManager?.notify(Constants.NOTIFICATION_ID, buildNotification(listening = false, connected = serverClient.isConnected.value))
            feedbackSounds.onCommandSent()
            serviceScope.launch { dataRepository.addUserMessage(text) }
            serviceScope.launch { dataRepository.addPanResponse("[PAN muted]") }
            return
        }
        if (lower.contains("unmute") || lower.contains("wake up") || lower.contains("start listening")) {
            panLog("PAN unmuted by voice command")
            isMuted = false
            sttEngine.enabled = true
            micEnabled.value = true
            notificationManager?.notify(Constants.NOTIFICATION_ID, buildNotification(listening = true, connected = serverClient.isConnected.value))
            sttEngine.startListening { t, f -> if (t.isNotBlank() && f) onSpeech(t) }
            feedbackSounds.onWakeWord()
            serviceScope.launch { dataRepository.addUserMessage(text) }
            serviceScope.launch { dataRepository.addPanResponse("[PAN unmuted]") }
            return
        }

        // Always save transcript and user message for conversation screen
        serviceScope.launch {
            dataRepository.addUserMessage(text)
            dataRepository.queueAudioUpload(
                AudioUpload(
                    transcript = text,
                    timestamp = System.currentTimeMillis(),
                    duration_ms = 0,
                    source = "phone_mic"
                )
            )
        }

        // Spotify / music — check BEFORE stripping since "play X on spotify" is clear
        if (lower.contains("play") && (lower.contains("spotify") || lower.contains("song"))) {
            val songQuery = lower
                .replace(Regex("(?:hey |hi |ok )?(?:pan|pam|ben|pen)[,.]?\\s*"), "")
                .replace(Regex("(?:can you |could you |please )?"), "")
                .replace(Regex("(?:play|on spotify|on my phone|the song|song)"), "")
                .trim()
            if (songQuery.isNotBlank()) {
                try {
                    val spotifyIntent = android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
                        data = Uri.parse("spotify:search:${Uri.encode(songQuery)}")
                        setPackage("com.spotify.music")
                        addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(spotifyIntent)
                    feedbackSounds.onCommandSent()
                    mainHandler.post { panSpeak("Playing $songQuery on Spotify.") }
                    addToHistory("User", text)
                    addToHistory("PAN", "Playing $songQuery on Spotify.")
                    logToServer(text, "spotify", songQuery, "phone_spotify")
                    return
                } catch (_: Exception) {}
            }
        }

        // Strip "hey pan/pam/ben" prefix so local command matching works
        val stripped = lower
            .replace(Regex("^(?:hey |hi |ok |okay )?(?:pan|pam|ben|pen)[,.]?\\s*"), "")
            .replace(Regex("^(?:can you |could you |please )?"), "")
            .trim()

        // Quick local handling — use stripped text (no "hey pan" prefix)
        val localResponse = handleLocally(stripped, "")
        if (localResponse != null) {
            // Camera commands are handled asynchronously — don't speak the placeholder
            if (localResponse == "CAMERA_ASYNC") {
                logToServer(text, "camera", "taking photo", "phone_camera")
                return
            }
            panLog("Local: $localResponse")
            logToServer(text, "local", localResponse, "phone_local")
            feedbackSounds.onCommandSent()
            mainHandler.post { panSpeak(localResponse) }
            addToHistory("User", text)
            addToHistory("PAN", localResponse)
            serviceScope.launch { dataRepository.addPanResponse(localResponse) }
            return
        }

        // Gemini Nano on-device — decides if this is for PAN, handles simple stuff,
        // routes complex/PC actions to the server
        addToHistory("User", text)

        serviceScope.launch {
            try {
            val historyContext = getHistoryContext()
            val decision = geminiBrain.evaluate(text, historyContext)
            panLog("Decision: ${decision.action} | ${decision.response?.take(80) ?: ""}")
            logToServer(text, decision.action.name, decision.response ?: "", "gemini_${decision.action.name.lowercase()}")

            when (decision.action) {
                GeminiBrain.Action.AMBIENT -> {
                    panLog("Ambient (ignored): ${text.take(50)}")
                }

                GeminiBrain.Action.RESPOND -> {
                    // Gemini answered directly — speak the response
                    val resp = decision.response ?: return@launch
                    addToHistory("PAN", resp)
                    dataRepository.addPanResponse(resp)
                    mainHandler.post { panSpeak(resp) }
                }

                GeminiBrain.Action.PHONE_COMMAND -> {
                    // Phone action — parse and execute
                    val cmd = decision.response ?: ""
                    if (cmd.startsWith("open:")) {
                        val appName = cmd.removePrefix("open:").trim()
                        val launched = launchPhoneApp(appName)
                        val resp = if (launched) "Opening $appName." else "Couldn't find $appName."
                        addToHistory("PAN", resp)
                        feedbackSounds.onCommandSent()
                        mainHandler.post { panSpeak(resp) }
                    } else {
                        // Unknown phone command — tell user
                        addToHistory("PAN", "I can't do that on the phone yet.")
                        mainHandler.post { panSpeak("I can't do that on the phone yet.") }
                    }
                }

                GeminiBrain.Action.SERVER -> {
                    // Send to PAN server for PC actions
                    try {
                        val response = serverClient.askPanWithContext(text, null, historyContext)
                        if (response != null) {
                            val responseText = response.response_text
                            panLog("Server: ${responseText.take(100)}")
                            addToHistory("PAN", responseText)
                            dataRepository.addPanResponse(responseText)
                            if (responseText != "[AMBIENT]" && responseText.isNotBlank()) {
                                mainHandler.post { panSpeak(responseText) }
                            }
                        } else {
                            panLog("Server returned null for: $text")
                            logToServer(text, "error", "server returned null", "phone_error_null_response")
                            mainHandler.post { panSpeak("Server didn't respond. It might be offline.") }
                        }
                    } catch (e: Exception) {
                        panLog("Server failed for '$text': ${e.message}")
                        logToServer(text, "error", e.message ?: "unknown", "phone_error_server_exception")
                        mainHandler.post { panSpeak("Couldn't reach the server. ${e.message ?: ""}") }
                    }
                }
            }
            } catch (e: Exception) {
                panLog("FATAL onSpeech error for '$text': ${e::class.simpleName} ${e.message}")
                logToServer(text, "error", "${e::class.simpleName}: ${e.message}", "phone_error_fatal")
                mainHandler.post { panSpeak("Something broke. ${e.message ?: ""}") }
            }
        }
    }

    // Determine where a command should run based on settings + context
    // Explicit mentions ("on my computer", "on my phone") always override
    private fun resolveTarget(lower: String): String {
        // Explicit target in the command always wins
        if (lower.contains("on my computer") || lower.contains("on my pc")
            || lower.contains("on the computer") || lower.contains("on the pc")
            || lower.contains("on my desktop") || lower.contains("on the desktop")) {
            return "pc"
        }
        if (lower.contains("on my phone") || lower.contains("on the phone")
            || lower.contains("on my mobile") || lower.contains("on this phone")) {
            return "phone"
        }

        // Project/terminal/dev commands always go to PC
        if (lower.contains("project") || lower.contains("terminal") || lower.contains("dev")) {
            return "pc"
        }

        // Read device_target setting
        val setting = kotlinx.coroutines.runBlocking {
            dataRepository.getSetting("device_target") ?: "auto"
        }

        return when (setting) {
            "phone" -> "phone"
            "pc" -> "pc"
            else -> {
                // Auto: use PC if server is connected, phone otherwise
                if (serverClient.isConnected.value) "pc" else "phone"
            }
        }
    }

    // Handle commands that can be answered locally on the phone — instant response
    // Convert spoken numbers to digits: "five" → "5"
    private fun wordsToNumbers(text: String): String {
        val map = mapOf(
            "one" to "1", "two" to "2", "three" to "3", "four" to "4", "five" to "5",
            "six" to "6", "seven" to "7", "eight" to "8", "nine" to "9", "ten" to "10",
            "eleven" to "11", "twelve" to "12", "fifteen" to "15", "twenty" to "20",
            "thirty" to "30", "forty" to "40", "forty-five" to "45", "fifty" to "50",
            "sixty" to "60", "ninety" to "90",
        )
        var result = text
        for ((word, num) in map) {
            result = result.replace(Regex("\\b$word\\b"), num)
        }
        return result
    }

    // Camera trigger phrases — "what is this?", "what am I looking at?", etc.
    private val cameraPatterns = listOf(
        "what is this", "what's this", "what is that", "what's that",
        "what am i looking at", "what am i seeing",
        "take a photo", "take a picture", "take photo", "take picture",
        "what do you see", "what can you see",
        "look at this", "look at that",
        "identify this", "identify that",
        "what's in front of me", "what is in front of me",
        "describe what you see", "describe this",
        "what's around me", "what is around me",
        "snap a photo", "snap a picture",
        "capture this", "capture that"
    )

    private fun isCameraCommand(text: String): Boolean {
        val lower = text.lowercase().trim()
        return cameraPatterns.any { lower.contains(it) }
    }

    private fun handleCameraCommand(userText: String) {
        val question = userText.ifBlank { "What is this?" }
        panLog("Camera command detected: $question")
        feedbackSounds.onCommandSent()
        // Just chirp — don't speak, avoids TTS/STT feedback loop while photo processes

        serviceScope.launch {
            try {
                // Check camera permission
                val hasCameraPermission = ContextCompat.checkSelfPermission(
                    this@PanForegroundService, Manifest.permission.CAMERA
                ) == PackageManager.PERMISSION_GRANTED

                if (!hasCameraPermission) {
                    panLog("No camera permission")
                    mainHandler.post { panSpeak("I don't have camera permission. Please grant it in settings.") }
                    return@launch
                }

                // Take photo
                panLog("Taking photo...")
                val photoBytes = cameraCapture.takePhoto()
                panLog("Photo captured: ${photoBytes.size} bytes")

                // Convert to base64
                val base64 = android.util.Base64.encodeToString(photoBytes, android.util.Base64.NO_WRAP)
                panLog("Base64 encoded: ${base64.length} chars")

                // Send to server for vision analysis
                val description = serverClient.analyzeImage(base64, question)

                if (description != null && description.isNotBlank()) {
                    panLog("Vision result: ${description.take(100)}")
                    addToHistory("User", "[photo] $question")
                    addToHistory("PAN", description)
                    dataRepository.addPanResponse(description)
                    mainHandler.post { panSpeak(description) }
                } else {
                    panLog("Vision analysis failed — no response")
                    mainHandler.post { panSpeak("I took a photo but couldn't analyze it. The server might be offline.") }
                }
            } catch (e: Exception) {
                panLog("Camera command failed: ${e.message}")
                mainHandler.post { panSpeak("I had trouble with the camera. ${e.message ?: ""}") }
            }
        }
    }

    private fun handleLocally(text: String, intent: String): String? {
        val lower = wordsToNumbers(text.lowercase())

        // Camera / vision commands — handle async, return a placeholder
        if (isCameraCommand(lower)) {
            handleCameraCommand(text)
            return "CAMERA_ASYNC" // signal that this was handled
        }

        // Time queries
        if (lower.contains("what time") || lower.contains("what's the time")) {
            val time = java.text.SimpleDateFormat("h:mm a", java.util.Locale.getDefault())
                .format(java.util.Date())
            return "It's $time."
        }

        // Date queries
        if (lower.contains("what day") || lower.contains("what's the date") || lower.contains("what date")) {
            val date = java.text.SimpleDateFormat("EEEE, MMMM d", java.util.Locale.getDefault())
                .format(java.util.Date())
            return "It's $date."
        }

        // Battery level
        if (lower.contains("battery") && (lower.contains("how much") || lower.contains("what") || lower.contains("level"))) {
            val bm = getSystemService(BATTERY_SERVICE) as android.os.BatteryManager
            val level = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
            return "Battery is at $level percent."
        }

        // "on my computer/pc/desktop" or project/terminal → always server
        if ((lower.contains("computer") || lower.contains("my pc") || lower.contains("on the pc"))
            && !lower.contains("on my phone") && !lower.contains("on the phone")) {
            return null
        }
        if (lower.contains("project") || lower.contains("terminal")) {
            return null
        }

        // Phone app launches — try if it says "open <something>"
        // Works for both "open YouTube" and "open YouTube on my phone"
        if (lower.contains("open") || lower.contains("launch")) {
            val appName = extractAppName(lower)
            if (appName != null) {
                val launched = launchPhoneApp(appName)
                if (launched) return "Opening $appName."
                // App not found on phone — let server try (might be a PC app)
            }
        }

        // --- Spotify / Music commands ---
        if ((lower.contains("play") && (lower.contains("spotify") || lower.contains("song") || lower.contains("music"))) ||
            lower.startsWith("play ")) {
            // Extract song/artist name
            val songQuery = lower
                .replace(Regex("(?:play|on spotify|on my phone|the song|song|please|can you)"), "")
                .trim()
            if (songQuery.isNotBlank()) {
                try {
                    val spotifyIntent = Intent(Intent.ACTION_VIEW).apply {
                        data = Uri.parse("spotify:search:${Uri.encode(songQuery)}")
                        setPackage("com.spotify.music")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(spotifyIntent)
                    return "Searching Spotify for $songQuery."
                } catch (e: Exception) {
                    // Spotify not installed — try YouTube Music or generic
                    try {
                        val ytIntent = Intent(Intent.ACTION_VIEW).apply {
                            data = Uri.parse("https://music.youtube.com/search?q=${Uri.encode(songQuery)}")
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        startActivity(ytIntent)
                        return "Searching YouTube Music for $songQuery."
                    } catch (_: Exception) {}
                }
            }
        }

        // --- Phone automation commands ---

        // Call
        Regex("call\\s+(.+)$").find(lower)?.let { match ->
            val target = match.groupValues[1].trim()
            try {
                val callIntent = Intent(Intent.ACTION_DIAL).apply {
                    data = Uri.parse("tel:${Uri.encode(target)}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(callIntent)
                return "Calling $target."
            } catch (e: Exception) {
                panLog("Call failed: ${e.message}")
                return "Couldn't start the call."
            }
        }

        // Text / Message
        Regex("(?:text|message)\\s+(.+)$").find(lower)?.let { match ->
            val target = match.groupValues[1].trim()
            try {
                val smsIntent = Intent(Intent.ACTION_SENDTO).apply {
                    data = Uri.parse("smsto:${Uri.encode(target)}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(smsIntent)
                return "Opening a message to $target."
            } catch (e: Exception) {
                panLog("Text failed: ${e.message}")
                return "Couldn't open messaging."
            }
        }

        // Timer
        Regex("set\\s+a?\\s*timer\\s+(?:for\\s+)?(\\d+)\\s*(second|minute|hour)s?").find(lower)?.let { match ->
            val amount = match.groupValues[1].toIntOrNull() ?: return@let
            val unit = match.groupValues[2]
            val seconds = when (unit) {
                "hour" -> amount * 3600
                "minute" -> amount * 60
                else -> amount
            }
            try {
                val timerIntent = Intent(AlarmClock.ACTION_SET_TIMER).apply {
                    putExtra(AlarmClock.EXTRA_LENGTH, seconds)
                    putExtra(AlarmClock.EXTRA_SKIP_UI, true)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(timerIntent)
                return "Setting a timer for $amount $unit${if (amount != 1) "s" else ""}."
            } catch (e: Exception) {
                panLog("Timer failed: ${e.message}")
                return "Couldn't set the timer."
            }
        }

        // Alarm
        Regex("set\\s+an?\\s*alarm\\s+(?:for\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?").find(lower)?.let { match ->
            var hour = match.groupValues[1].toIntOrNull() ?: return@let
            val minute = match.groupValues[2].toIntOrNull() ?: 0
            val ampm = match.groupValues[3].replace(".", "").lowercase()
            if (ampm == "pm" && hour < 12) hour += 12
            if (ampm == "am" && hour == 12) hour = 0
            try {
                val alarmIntent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
                    putExtra(AlarmClock.EXTRA_HOUR, hour)
                    putExtra(AlarmClock.EXTRA_MINUTES, minute)
                    putExtra(AlarmClock.EXTRA_SKIP_UI, true)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(alarmIntent)
                val timeStr = String.format("%d:%02d", if (hour % 12 == 0) 12 else hour % 12, minute)
                val suffix = if (hour < 12) "AM" else "PM"
                return "Setting an alarm for $timeStr $suffix."
            } catch (e: Exception) {
                panLog("Alarm failed: ${e.message}")
                return "Couldn't set the alarm."
            }
        }

        // Navigation / Directions
        Regex("(?:navigate|directions?|take me|go)\\s+to\\s+(.+)$").find(lower)?.let { match ->
            val destination = match.groupValues[1].trim()
            try {
                val navIntent = Intent(Intent.ACTION_VIEW).apply {
                    data = Uri.parse("google.navigation:q=${Uri.encode(destination)}")
                    setPackage("com.google.android.apps.maps")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(navIntent)
                return "Navigating to $destination."
            } catch (e: Exception) {
                panLog("Navigation failed: ${e.message}")
                return "Couldn't open navigation."
            }
        }

        // Flashlight
        if (lower.contains("flashlight") || (lower.contains("flash") && lower.contains("light")) ||
            (lower.contains("torch"))) {
            try {
                val cameraManager = getSystemService(CAMERA_SERVICE) as CameraManager
                val cameraId = cameraManager.cameraIdList.firstOrNull() ?: return "No camera found."
                flashlightOn = if (lower.contains("off")) {
                    cameraManager.setTorchMode(cameraId, false)
                    false
                } else if (lower.contains("on") || lower.contains("turn on")) {
                    cameraManager.setTorchMode(cameraId, true)
                    true
                } else {
                    // Toggle
                    flashlightOn = !flashlightOn
                    cameraManager.setTorchMode(cameraId, flashlightOn)
                    flashlightOn
                }
                return if (flashlightOn) "Flashlight on." else "Flashlight off."
            } catch (e: Exception) {
                panLog("Flashlight failed: ${e.message}")
                return "Couldn't control the flashlight."
            }
        }

        // Web search
        Regex("search\\s+(?:for\\s+)?(.+)$").find(lower)?.let { match ->
            val query = match.groupValues[1].trim()
            try {
                val searchIntent = Intent(Intent.ACTION_VIEW).apply {
                    data = Uri.parse("https://www.google.com/search?q=${Uri.encode(query)}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(searchIntent)
                return "Searching for $query."
            } catch (e: Exception) {
                panLog("Search failed: ${e.message}")
                return "Couldn't open the search."
            }
        }

        // --- Media controls ---
        if (lower == "play" || lower == "play music" || lower == "resume" || lower == "resume music") {
            dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PLAY)
            return "Playing."
        }
        if (lower == "pause" || lower == "pause music" || lower == "stop music") {
            dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PAUSE)
            return "Paused."
        }
        if (lower == "next" || lower == "next song" || lower == "skip") {
            dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_NEXT)
            return "Skipping to next."
        }
        if (lower == "previous" || lower == "previous song") {
            dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PREVIOUS)
            return "Going to previous."
        }

        return null // not a local query
    }

    private fun extractAppName(text: String): String? {
        // Find everything after "open" or "launch", strip filler words
        val match = Regex("(?:open|launch)\\s+(.+)", RegexOption.IGNORE_CASE).find(text)
        if (match == null) {
            Log.w(TAG, "extractAppName: no open/launch found in '$text'")
            return null
        }

        var name = match.groupValues[1].trim()
        // Strip trailing context like "on my phone", "on my computer", "at 10:30", etc
        name = name.replace(Regex("\\s+on\\s+(my|the|this)\\s+.*$", RegexOption.IGNORE_CASE), "")
        name = name.replace(Regex("\\s+at\\s+\\d.*$", RegexOption.IGNORE_CASE), "")
        // Strip leading filler: "up", "the", "my", "a"
        name = name.replace(Regex("^(up|the|my|a)\\s+", RegexOption.IGNORE_CASE), "")
        name = name.replace(Regex("\\s+app$", RegexOption.IGNORE_CASE), "")
        name = name.trim()

        if (name.isNotBlank() && name.length < 30) {
            Log.i(TAG, "Extracted app name: '$name' from '$text'")
            return name
        }
        Log.w(TAG, "extractAppName: result too short or long: '$name' from '$text'")
        return null
    }

    private fun launchPhoneApp(name: String): Boolean {
        Log.i(TAG, "Trying to launch phone app: '$name'")
        val pm = packageManager
        val lower = name.lowercase()

        // Map common names to package names
        val knownApps = mapOf(
            "chrome" to "com.android.chrome",
            "google chrome" to "com.android.chrome",
            "youtube" to "com.google.android.youtube",
            "camera" to "com.android.camera",
            "settings" to "com.android.settings",
            "maps" to "com.google.android.apps.maps",
            "google maps" to "com.google.android.apps.maps",
            "gmail" to "com.google.android.gm",
            "messages" to "com.google.android.apps.messaging",
            "phone" to "com.android.dialer",
            "calculator" to "com.google.android.calculator",
            "clock" to "com.google.android.deskclock",
            "spotify" to "com.spotify.music",
            "discord" to "com.discord",
            "whatsapp" to "com.whatsapp",
            "telegram" to "org.telegram.messenger",
            "instagram" to "com.instagram.android",
            "twitter" to "com.twitter.android",
            "x" to "com.twitter.android",
            "files" to "com.google.android.documentsui",
            "drive" to "com.google.android.apps.docs",
            "google drive" to "com.google.android.apps.docs",
            "photos" to "com.google.android.apps.photos",
            "calendar" to "com.google.android.calendar",
        )

        val packageName = knownApps[lower]
        Log.i(TAG, "launchPhoneApp: lookup '$lower' -> package=${packageName ?: "not in known list"}")

        val launchIntent = if (packageName != null) {
            pm.getLaunchIntentForPackage(packageName)
        } else {
            // Try to find by searching installed apps
            val installed = pm.getInstalledApplications(0)
            val match = installed.firstOrNull {
                pm.getApplicationLabel(it).toString().lowercase().contains(lower)
            }
            Log.i(TAG, "launchPhoneApp: searched installed apps, found=${match?.packageName ?: "none"}")
            match?.let { pm.getLaunchIntentForPackage(it.packageName) }
        }

        return if (launchIntent != null) {
            launchIntent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(launchIntent)
            Log.i(TAG, "launchPhoneApp: launched successfully")
            true
        } else {
            Log.w(TAG, "launchPhoneApp: no launch intent found for '$lower'")
            false
        }
    }

    private fun dispatchMediaKey(keyCode: Int) {
        val audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        val downEvent = KeyEvent(KeyEvent.ACTION_DOWN, keyCode)
        val upEvent = KeyEvent(KeyEvent.ACTION_UP, keyCode)
        audioManager.dispatchMediaKeyEvent(downEvent)
        audioManager.dispatchMediaKeyEvent(upEvent)
    }

    // Fast local classification — no API needed
    // Returns "passive" for normal conversation that shouldn't be acted on
    // Must be strict to avoid false positives — only trigger on clear commands
    private fun classifyLocally(text: String): String {
        val lower = text.lowercase()

        // Explicit PAN address — always route
        if (lower.contains("hey pan") || lower.contains("hey pam")) {
            // Check if it's a local-answerable question with "hey pan" prefix
            if (lower.contains("what time") || lower.contains("what's the time")
                || lower.contains("what day") || lower.contains("what date")
                || lower.contains("battery")) {
                return "local"
            }
            return "query"
        }

        // System commands — require action verb + target object together
        // "create a folder" yes, "did not create that" no
        val systemPatterns = listOf(
            Regex("(create|make)\\s+(a\\s+)?(folder|file|directory|dir)"),
            Regex("(delete|remove)\\s+(the\\s+|a\\s+)?(folder|file|directory)"),
            Regex("(rename|move|copy)\\s+(the\\s+|a\\s+)?(folder|file)")
        )
        if (systemPatterns.any { it.containsMatchIn(lower) }) return "system"

        // Terminal — open/launch + a project name
        val terminalPatterns = listOf(
            Regex("(open|launch)\\s+(the\\s+)?(\\w+\\s+)*(project|terminal|dev|code)"),
            Regex("(open|launch)\\s+(the\\s+)?\\w+\\s+(dev|game|project)")
        )
        if (terminalPatterns.any { it.containsMatchIn(lower) }) return "terminal"

        // Memory — explicit save/add commands
        val memoryPatterns = listOf(
            Regex("(add|put)\\s+.+\\s+(to|on|in)\\s+(my\\s+)?(list|grocery|shopping)"),
            Regex("(save|remember|note)\\s+(this|that|the)"),
            Regex("(remind me|don't forget|remember to)")
        )
        if (memoryPatterns.any { it.containsMatchIn(lower) }) return "memory"

        // Calendar
        val calendarPatterns = listOf(
            Regex("(add|create|schedule|set)\\s+.*(event|meeting|appointment|reminder)"),
            Regex("(put|add)\\s+.*(calendar|schedule)")
        )
        if (calendarPatterns.any { it.containsMatchIn(lower) }) return "calendar"

        // Everything else — passive capture only
        return "passive"
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "STOP_TTS") {
            tts.stop()
            panLog("TTS stopped from notification")
        }

        if (intent?.action == "TOGGLE_MIC") {
            val newState = !sttEngine.enabled
            sttEngine.enabled = newState
            micEnabled.value = newState
            isMuted = !newState
            if (newState) {
                sttEngine.startListening { t, f -> if (t.isNotBlank() && f) { voiceCollector.onTranscript(t); onSpeech(t) } }
            } else {
                voiceCollector.stop()
            }
            notificationManager?.notify(
                Constants.NOTIFICATION_ID,
                buildNotification(listening = newState, connected = serverClient.isConnected.value)
            )
            panLog("All sensors toggled: ${if (newState) "ON" else "OFF"}")
        }
        return START_STICKY
    }
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        serviceScope.cancel()
        voiceCollector.stop()
        sttEngine.destroy()
        mainHandler.post { tts.destroy() }
        syncManager.stop()
        releaseWakeLock()
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            Constants.NOTIFICATION_CHANNEL_ID,
            "PAN Service",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "PAN is always listening and remembering"
            setShowBadge(false)
        }
        notificationManager?.createNotificationChannel(channel)
    }

    private fun buildNotification(listening: Boolean, connected: Boolean): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE)

        // Mic toggle action — mute/unmute from notification tray
        val toggleIntent = Intent(this, PanForegroundService::class.java).apply {
            action = "TOGGLE_MIC"
        }
        val togglePendingIntent = PendingIntent.getService(
            this, 1, toggleIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val title = if (listening) "ΠΑΝ Active" else "ΠΑΝ Muted"
        val statusParts = mutableListOf<String>()
        statusParts.add(if (listening) "Listening" else "Silent")
        statusParts.add(if (connected) "Server OK" else "Offline")
        val toggleLabel = if (listening) "Mute All" else "Unmute All"

        return NotificationCompat.Builder(this, Constants.NOTIFICATION_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(statusParts.joinToString(" | "))
            .setSmallIcon(if (listening) android.R.drawable.ic_btn_speak_now else android.R.drawable.ic_media_pause)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(pendingIntent)
            .addAction(0, toggleLabel, togglePendingIntent)
            .addAction(0, "Stop", PendingIntent.getService(
                this, 2,
                Intent(this, PanForegroundService::class.java).apply { action = "STOP_TTS" },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            ))
            .build()
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PAN::ServiceWakeLock")
        wakeLock?.acquire()
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
    }

    @SuppressLint("BatteryLife")
    private fun requestBatteryExemption() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            panLog("Requesting battery optimization exemption")
            val intent = android.content.Intent(
                android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
            ).apply {
                data = android.net.Uri.parse("package:$packageName")
                addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            try {
                startActivity(intent)
            } catch (e: Exception) {
                panLog("Battery exemption request failed: ${e.message}")
            }
        } else {
            panLog("Battery optimization already exempted")
        }
    }
}
