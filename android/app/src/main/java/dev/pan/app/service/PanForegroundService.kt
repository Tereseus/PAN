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
    @Inject lateinit var sensorContext: dev.pan.app.sensor.SensorContext

    private val serviceScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val mainHandler = Handler(Looper.getMainLooper())
    private var wakeLock: PowerManager.WakeLock? = null
    private var notificationManager: NotificationManager? = null
    private lateinit var resistanceClient: ResistanceClient
    @Inject lateinit var localLlm: dev.pan.app.ai.LocalLlm

    // Dedup: prevent duplicate commands within 3 seconds
    private var lastProcessedText = ""
    private var lastProcessedTime = 0L
    private val DEDUP_WINDOW_MS = 3000L
    private val convoTracker = ConversationTracker()
    private var isMuted = false
    private var flashlightOn = false
    private var lastActionContext = "" // tracks what "it" / "that" refers to
    private var lastTtsDoneTime = 0L  // When TTS last finished speaking
    private val TTS_COOLDOWN_MS = 600L  // Ignore speech for 600ms after TTS finishes

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

    // Screen off receiver — stops TTS when power button is pressed
    private val screenOffReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(ctx: android.content.Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_SCREEN_OFF) {
                if (tts.isSpeaking) {
                    tts.stop()
                    panLog("TTS stopped — screen off (power button)")
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        panLog("PAN service created")

        // Register screen off receiver for power button TTS stop
        registerReceiver(screenOffReceiver, android.content.IntentFilter(Intent.ACTION_SCREEN_OFF))

        // Initialize resistance client for path-of-least-resistance routing
        resistanceClient = ResistanceClient(this)
        resistanceClient.syncFromServer()

        // Initialize local LLM — auto-download and load model
        serviceScope.launch {
            val model = localLlm.getSelectedModel()
            if (!localLlm.isModelDownloaded(model)) {
                Log.d("PAN-LLM", "Downloading ${model.name} (${model.sizeBytes / 1_000_000}MB)...")
                var lastLoggedPercent = -1
                val success = localLlm.downloadModel(model) { progress ->
                    val percent = (progress * 100).toInt()
                    if (percent / 25 > lastLoggedPercent / 25) {
                        lastLoggedPercent = percent
                        Log.d("PAN-LLM", "Download: $percent%")
                    }
                }
                if (success) {
                    Log.d("PAN-LLM", "${model.name} downloaded, loading...")
                    localLlm.loadModel()
                } else {
                    Log.d("PAN-LLM", "Download failed, will use server for routing")
                }
            } else {
                Log.d("PAN-LLM", "${model.name} found, loading...")
                localLlm.loadModel()
            }
        }

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
                val initStart = System.currentTimeMillis()
                val ready = geminiBrain.initialize()
                val initElapsed = System.currentTimeMillis() - initStart
                panLog("GeminiBrain init: ${initElapsed}ms — ${if (ready) "READY" else "not available, using server"}")
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

        // Start sensor collection (GPS, compass, accelerometer, etc.)
        sensorContext.start()
        panLog("Sensors started")

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

        // Permission prompt polling — check every 5 seconds, show Android notification
        startPermissionPolling()
    }

    private var lastPermId: Long = 0

    private fun startPermissionPolling() {
        serviceScope.launch {
            while (isActive) {
                delay(5000)
                try {
                    val response = serverClient.api.getPermissions()
                    val perms = response.body()?.permissions ?: continue
                    if (perms.isEmpty()) continue
                    val latest = perms.last()
                    if (latest.id == lastPermId) continue
                    lastPermId = latest.id
                    showPermissionNotification(latest)
                } catch (_: Exception) {}
            }
        }
    }

    private fun showPermissionNotification(perm: dev.pan.app.network.dto.PermissionPrompt) {
        // Create a high-priority notification channel for permissions
        val permChannelId = "pan_permissions"
        val permChannel = NotificationChannel(
            permChannelId, "PAN Permissions",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Claude Code permission prompts"
            enableVibration(true)
        }
        notificationManager?.createNotificationChannel(permChannel)

        // Allow action (sends "1" via SendInput)
        val allowIntent = Intent(this, PanForegroundService::class.java).apply {
            action = "PERMISSION_RESPOND"
            putExtra("response", "1")
            putExtra("perm_id", perm.id)
        }
        val allowPending = PendingIntent.getService(
            this, 100, allowIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Deny action (sends "3" via SendInput)
        val denyIntent = Intent(this, PanForegroundService::class.java).apply {
            action = "PERMISSION_RESPOND"
            putExtra("response", "3")
            putExtra("perm_id", perm.id)
        }
        val denyPending = PendingIntent.getService(
            this, 101, denyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, permChannelId)
            .setContentTitle("ΠΑΝ Permission Required")
            .setContentText(perm.prompt)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .addAction(0, "Allow", allowPending)
            .addAction(0, "Deny", denyPending)
            .build()

        notificationManager?.notify(999, notification)
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

        // "That didn't work" — report failure to resistance system
        if (lower.contains("didn't work") || lower.contains("that didn't") || lower.contains("try something else") || lower.contains("not working")) {
            val feedback = resistanceClient.reportLastFailed("play_music")
            mainHandler.post { panSpeak(feedback) }
            addToHistory("User", text)
            addToHistory("PAN", feedback)
            return
        }

        // Strip "hey pan/pam/ben" prefix so local command matching works
        val stripped = lower
            .replace(Regex("^(?:hey |hi |ok |okay )?(?:pan|pam|ben|pen)[,.]?\\s*"), "")
            .replace(Regex("^(?:can you |could you |please )?"), "")
            .trim()

        val lowerStripped = stripped.lowercase()

        // Google/Microsoft app queries → try local Android APIs first, fall back to terminal MCP
        // But NOT "open gmail" / "open calendar" — those are just app launches, handled by LLM classifier
        val isOpenCommand = lowerStripped.startsWith("open ") || lowerStripped.startsWith("launch ") || lowerStripped.startsWith("go to ")
        val isGoogleQuery = !isOpenCommand && (
            lowerStripped.contains("calendar") || lowerStripped.contains("schedule") ||
            lowerStripped.contains("meeting") || lowerStripped.contains("appointment") ||
            lowerStripped.contains("email") || lowerStripped.contains("gmail") ||
            lowerStripped.contains("outlook") || lowerStripped.contains("inbox") ||
            lowerStripped.contains("send email") || lowerStripped.contains("send a message") ||
            lowerStripped.contains("check my") || lowerStripped.contains("read my") ||
            lowerStripped.contains("what's on my")
        )
        if (isGoogleQuery) {
            // Try reading calendar directly from Android CalendarProvider (instant, no network)
            if (lowerStripped.contains("calendar") || lowerStripped.contains("schedule") ||
                lowerStripped.contains("meeting") || lowerStripped.contains("appointment")) {
                try {
                    val calResult = readPhoneCalendar()
                    if (calResult != null) {
                        panLog("Calendar → local Android provider")
                        mainHandler.post { panSpeak(calResult) }
                        addToHistory("User", text)
                        addToHistory("PAN", calResult)
                        logToServer(text, "calendar", calResult, "phone_calendar")
                        return
                    }
                } catch (e: Exception) {
                    panLog("Local calendar read failed: ${e.message}")
                }
            }
            panLog("Google/Calendar query → terminal (MCP)")
            serviceScope.launch {
                try {
                    val sent = serverClient.sendTerminalCommand(stripped)
                    if (sent) {
                        mainHandler.post { panSpeak("Let me check.") }
                        // Wait for Claude's response — poll manually since Retrofit timeout may be too short
                        var answer: String? = null
                        val startWait = System.currentTimeMillis()
                        while (System.currentTimeMillis() - startWait < 45000) { // 45 second max
                            delay(2000) // check every 2 seconds
                            try {
                                // Get the most recent Stop event from the server
                                val sinceTime = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).apply {
                                    timeZone = java.util.TimeZone.getDefault()
                                }.format(java.util.Date(startWait - 5000)) // 5 seconds before we started
                                val resp = serverClient.api.waitTerminalResponse(sinceTime, 2000)
                                val body = resp.body()
                                if (body?.ok == true && !body.response.isNullOrBlank()) {
                                    answer = body.response
                                    break
                                }
                            } catch (_: Exception) {}
                        }
                        if (!answer.isNullOrBlank()) {
                            panLog("Terminal MCP response: ${answer!!.take(100)}")
                            mainHandler.post { panSpeak(answer!!) }
                            addToHistory("User", text)
                            addToHistory("PAN", answer!!)
                        } else {
                            panLog("Terminal MCP response timeout")
                            mainHandler.post { panSpeak("I checked but didn't get a response in time. Check the terminal.") }
                        }
                    } else {
                        // Fallback to server if terminal isn't available
                        val response = serverClient.askPanWithContext(stripped, "calendar", getHistoryContext())
                        if (response != null) {
                            mainHandler.post { panSpeak(response.response_text) }
                        } else {
                            mainHandler.post { panSpeak("I couldn't access your calendar right now.") }
                        }
                        addToHistory("User", text)
                    }
                } catch (e: Exception) {
                    mainHandler.post { panSpeak("Calendar lookup failed.") }
                }
            }
            return
        }

        // Location queries need sensor data — always route to server
        if (lowerStripped.contains("where am i") || lowerStripped.contains("my location") ||
            lowerStripped.contains("my gps") || lowerStripped.contains("my coordinates") ||
            lowerStripped.contains("what city") || lowerStripped.contains("what address")) {
            val gps = if (sensorContext.gpsEnabled) sensorContext.gps else null
            val addr = if (sensorContext.gpsEnabled) sensorContext.address else null
            panLog("Location query → server (GPS=${gps != null} addr=$addr gpsEnabled=${sensorContext.gpsEnabled})")
            serviceScope.launch {
                try {
                    // Append sensor data directly to the query text so Claude sees it
                    var queryWithSensors = stripped
                    if (gps != null) {
                        queryWithSensors += "\n[SENSOR DATA: GPS lat=${gps.lat}, lng=${gps.lng}"
                        if (gps.altitude != null) queryWithSensors += ", alt=${gps.altitude}m"
                        if (gps.speed != null) queryWithSensors += ", speed=${gps.speed}m/s"
                        if (addr != null) queryWithSensors += ", address=$addr"
                        queryWithSensors += "]"
                    }
                    val response = serverClient.askPanWithContext(queryWithSensors, "query", getHistoryContext())
                    if (response != null) {
                        mainHandler.post { panSpeak(response.response_text) }
                        addToHistory("User", text)
                        addToHistory("PAN", response.response_text)
                    } else {
                        mainHandler.post { panSpeak("I couldn't get your location right now.") }
                    }
                } catch (e: Exception) {
                    mainHandler.post { panSpeak("Location lookup failed: ${e.message}") }
                }
            }
            return
        }

        // Hardware-only instant commands (no LLM needed, zero latency)
        val instantResponse = handleInstantHardware(stripped)
        if (instantResponse != null) {
            if (instantResponse == "CAMERA_ASYNC") {
                logToServer(text, "camera", "taking photo", "phone_camera")
                return
            }
            panLog("Instant: $instantResponse")
            logToServer(text, "instant", instantResponse, "phone_instant")
            feedbackSounds.onCommandSent()
            mainHandler.post { panSpeak(instantResponse) }
            addToHistory("User", text)
            addToHistory("PAN", instantResponse)
            serviceScope.launch { dataRepository.addPanResponse(instantResponse) }
            return
        }

        addToHistory("User", text)

        serviceScope.launch {
            try {
            val historyContext = getHistoryContext()

            // Skip llama.cpp classifier — was adding 9s overhead
            // Return dummy "unknown" so everything falls through to GeminiBrain/server
            val localIntent = dev.pan.app.ai.LocalLlm.IntentResult(intent = "unknown", query = stripped, service = null, local = false, elapsedMs = 0)

            // Override: force recall if user mentions conversations/history/remember
            val recallKeywords = listOf("conversation", "conversations", "what did we talk", "what did i say",
                "do you remember", "remember when", "look up what", "find what i said", "search for what",
                "what we said about", "what i asked", "look in the", "were we talking about",
                "were we saying about", "what were we saying", "what were we talking",
                "we talked about", "we discussed", "we were discussing", "did i mention",
                "did we mention", "did we discuss", "search in the", "find in the",
                "what did we say", "said about", "talk about", "say about")
            val forceRecall = recallKeywords.any { stripped.contains(it) }
            val effectiveIntent = if (forceRecall && localIntent.intent != "recall") {
                panLog("Override: ${localIntent.intent} → recall (keyword match)")
                localIntent.copy(intent = "recall", local = true)
            } else localIntent

            if (effectiveIntent.local && effectiveIntent.intent != "unknown") {
                val elapsed = effectiveIntent.elapsedMs
                panLog("Local LLM (${elapsed}ms): ${effectiveIntent.intent} | ${effectiveIntent.query}")
                logToServer(text, "local_llm_${effectiveIntent.intent}", effectiveIntent.query, "local_llm")

                when (effectiveIntent.intent) {
                    "play_music" -> {
                        val result = resistanceClient.tryPlayMusic(
                            this@PanForegroundService,
                            effectiveIntent.query,
                            effectiveIntent.service
                        )
                        val msg = result.message ?: result.error ?: "Could not play."
                        addToHistory("PAN", "$msg (${elapsed}ms local)")
                        dataRepository.addPanResponse(msg)
                        feedbackSounds.onCommandSent()
                        mainHandler.post { panSpeak(msg) }
                        return@launch
                    }
                    "ambient" -> {
                        panLog("Local LLM: ambient (ignored)")
                        return@launch
                    }
                    "query" -> {
                        val answerSource = kotlinx.coroutines.runBlocking {
                            dataRepository.getSetting("query_answer_source") ?: "cloud"
                        }
                        if (answerSource.equals("local", ignoreCase = true)) {
                            // Answer with local LLM (swaps to conversation model)
                            val answer = localLlm.chat(stripped, historyContext)
                            if (answer.isNotBlank()) {
                                addToHistory("PAN", "$answer (${elapsed}ms local)")
                                dataRepository.addPanResponse(answer)
                                mainHandler.post { panSpeak(answer) }
                                return@launch
                            }
                        }
                        // "cloud" or "auto" or blank local answer → fall through to server
                        panLog("Query → cloud (${elapsed}ms classify)")
                    }
                    "open_app" -> {
                        val appName = effectiveIntent.query
                        val launched = launchPhoneApp(appName)
                        val msg = if (launched) "Opening $appName." else "Couldn't find $appName."
                        addToHistory("PAN", "$msg (${elapsed}ms local)")
                        feedbackSounds.onCommandSent()
                        mainHandler.post { panSpeak(msg) }
                        return@launch
                    }
                    "navigate" -> {
                        val destination = effectiveIntent.query
                        try {
                            val navIntent = Intent(Intent.ACTION_VIEW).apply {
                                data = Uri.parse("google.navigation:q=${Uri.encode(destination)}")
                                setPackage("com.google.android.apps.maps")
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            startActivity(navIntent)
                            val msg = "Navigating to $destination."
                            addToHistory("PAN", "$msg (${elapsed}ms local)")
                            feedbackSounds.onCommandSent()
                            mainHandler.post { panSpeak(msg) }
                        } catch (e: Exception) {
                            mainHandler.post { panSpeak("Couldn't open navigation.") }
                        }
                        return@launch
                    }
                    "search" -> {
                        val query = effectiveIntent.query
                        try {
                            val searchIntent = Intent(Intent.ACTION_VIEW).apply {
                                data = Uri.parse("https://www.google.com/search?q=${Uri.encode(query)}")
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            startActivity(searchIntent)
                            val msg = "Searching for $query."
                            addToHistory("PAN", "$msg (${elapsed}ms local)")
                            feedbackSounds.onCommandSent()
                            mainHandler.post { panSpeak(msg) }
                        } catch (e: Exception) {
                            mainHandler.post { panSpeak("Couldn't open the search.") }
                        }
                        return@launch
                    }
                    "send_message" -> {
                        // Extract recipient from query if possible
                        val target = effectiveIntent.query
                        try {
                            val smsIntent = Intent(Intent.ACTION_SENDTO).apply {
                                data = Uri.parse("smsto:${Uri.encode(target)}")
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            startActivity(smsIntent)
                            val msg = "Opening a message to $target."
                            addToHistory("PAN", "$msg (${elapsed}ms local)")
                            feedbackSounds.onCommandSent()
                            mainHandler.post { panSpeak(msg) }
                        } catch (e: Exception) {
                            mainHandler.post { panSpeak("Couldn't open messaging.") }
                        }
                        return@launch
                    }
                    "recall" -> {
                        // Server does everything: keyword extraction, DB search, summarization
                        panLog("Recall → server: '$stripped'")
                        try {
                            val result = serverClient.recall(stripped)
                            val msg = result ?: "Couldn't search conversations."
                            addToHistory("PAN", msg)
                            dataRepository.addPanResponse(msg)
                            mainHandler.post { panSpeak(msg) }
                        } catch (e: Exception) {
                            panLog("Recall failed: ${e.message}")
                            mainHandler.post { panSpeak("Couldn't search conversations.") }
                        }
                        return@launch
                    }
                    "terminal" -> {
                        // Send to the active desktop terminal session
                        try {
                            val res = serverClient.sendTerminalCommand(stripped)
                            val msg = if (res) "Sent to terminal." else "No active terminal session."
                            addToHistory("PAN", "$msg (${elapsed}ms)")
                            feedbackSounds.onCommandSent()
                            mainHandler.post { panSpeak(msg) }
                        } catch (e: Exception) {
                            mainHandler.post { panSpeak("Couldn't reach the terminal.") }
                        }
                        return@launch
                    }
                    "system", "calendar", "camera" -> {
                        // These are already handled by handleLocally regex above
                        // If we got here, regex didn't catch it — fall through to server
                    }
                }
            }

            // Gemini Nano / server fallback
            panLog("GeminiBrain: isAvailable=${geminiBrain.isAvailable()}, evaluating...")
            val geminiStartTime = System.currentTimeMillis()
            val decision = geminiBrain.evaluate(text, historyContext)
            val geminiElapsed = System.currentTimeMillis() - geminiStartTime
            panLog("GeminiBrain: ${geminiElapsed}ms | ${decision.action} | ${decision.response?.take(80) ?: ""}")
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
                    // Send to PAN server — Claude classifies and responds
                    val startTime = System.currentTimeMillis()
                    try {
                        val sensorData = sensorContext.getContextEnvelope()
                        panLog("Sensors: GPS=${sensorContext.gps != null} addr=${sensorContext.address} compass=${sensorContext.compass != null}")
                        val response = serverClient.askPanWithContext(text, null, historyContext, sensorData)
                        val elapsed = System.currentTimeMillis() - startTime
                        if (response != null) {
                            val responseText = response.response_text
                            panLog("Server (${elapsed}ms): ${responseText.take(100)}")

                            // Check if server returned a phone-executable action
                            val route = response.route ?: ""
                            if (route == "music" || route == "play_music" || responseText.startsWith("Playing ")) {
                                // Server classified as music — execute through resistance
                                val songQuery = response.query ?: responseText.removePrefix("Playing ").removeSuffix(".")
                                val explicitService = when {
                                    lower.contains("youtube") -> "youtube"
                                    lower.contains("spotify") -> "spotify"
                                    else -> null
                                }
                                val result = resistanceClient.tryPlayMusic(this@PanForegroundService, songQuery, explicitService)
                                val msg = result.message ?: result.error ?: responseText
                                addToHistory("PAN", "$msg (${elapsed}ms)")
                                dataRepository.addPanResponse(msg)
                                feedbackSounds.onCommandSent()
                                mainHandler.post { panSpeak(msg) }
                                logToServer(text, "music_resistance", songQuery, "phone_music")
                                return@launch
                            }

                            addToHistory("PAN", "$responseText (${elapsed}ms)")
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

        // Check if camera is enabled in PAN sensor settings
        if (!sensorContext.cameraEnabled) {
            panLog("Camera is disabled in PAN sensor settings")
            mainHandler.post { panSpeak("The camera is turned off in sensor settings.") }
            return
        }

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

    // Only truly instant hardware commands — everything else goes to LLM
    private fun handleInstantHardware(text: String): String? {
        var lower = wordsToNumbers(text.lowercase())

        // Context resolution — "turn it off"
        if (lastActionContext.isNotBlank() &&
            (lower.contains("turn it") || lower.contains("turn that") ||
             lower == "turn it off" || lower == "turn it on" ||
             lower == "off" || lower == "on" ||
             lower.matches(Regex(".*\\b(it|that|this)\\b.*(on|off).*")))) {
            lower = lower.replace("it", lastActionContext).replace("that", lastActionContext).replace("this", lastActionContext)
            if (lower == "off") lower = "turn $lastActionContext off"
            if (lower == "on") lower = "turn $lastActionContext on"
        }

        // Camera / vision
        if (isCameraCommand(lower)) {
            handleCameraCommand(text)
            return "CAMERA_ASYNC"
        }

        // Flashlight
        if (lower.contains("flashlight") || (lower.contains("flash") && lower.contains("light")) || lower.contains("torch")) {
            try {
                val cameraManager = getSystemService(CAMERA_SERVICE) as CameraManager
                val cameraId = cameraManager.cameraIdList.firstOrNull() ?: return "No camera found."
                flashlightOn = if (lower.contains("off")) {
                    cameraManager.setTorchMode(cameraId, false); false
                } else if (lower.contains("on") || lower.contains("turn on")) {
                    cameraManager.setTorchMode(cameraId, true); true
                } else {
                    flashlightOn = !flashlightOn; cameraManager.setTorchMode(cameraId, flashlightOn); flashlightOn
                }
                lastActionContext = "flashlight"
                return if (flashlightOn) "Flashlight on." else "Flashlight off."
            } catch (e: Exception) { return "Couldn't control the flashlight." }
        }

        // Media controls (instant, no LLM needed)
        if (lower == "play" || lower == "play music" || lower == "resume" || lower == "resume music") {
            dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PLAY); return "Playing."
        }
        if (lower == "pause" || lower == "pause music" || lower == "stop music") {
            dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PAUSE); return "Paused."
        }
        if (lower == "next" || lower == "next song" || lower == "skip") {
            dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_NEXT); return "Skipping to next."
        }
        if (lower == "previous" || lower == "previous song") {
            dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PREVIOUS); return "Going to previous."
        }

        // Time
        if (lower.contains("what time") || lower.contains("what's the time")) {
            return "It's ${java.text.SimpleDateFormat("h:mm a", java.util.Locale.getDefault()).format(java.util.Date())}."
        }

        // Date
        if (lower.contains("what day") || lower.contains("what's the date") || lower.contains("what date")) {
            return "It's ${java.text.SimpleDateFormat("EEEE, MMMM d", java.util.Locale.getDefault()).format(java.util.Date())}."
        }

        // Battery
        if (lower.contains("battery") && (lower.contains("how much") || lower.contains("what") || lower.contains("level"))) {
            val bm = getSystemService(BATTERY_SERVICE) as android.os.BatteryManager
            return "Battery is at ${bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)} percent."
        }

        return null // Everything else → LLM classification
    }

    @Deprecated("Replaced by handleInstantHardware + LLM classification")
    private fun handleLocally(text: String, intent: String): String? {
        var lower = wordsToNumbers(text.lowercase())

        // Context resolution — "turn it off", "do that again", etc.
        if (lastActionContext.isNotBlank() &&
            (lower.contains("turn it") || lower.contains("turn that") ||
             lower == "turn it off" || lower == "turn it on" ||
             lower == "off" || lower == "on" ||
             lower.matches(Regex(".*\\b(it|that|this)\\b.*(on|off).*")))) {
            lower = lower.replace("it", lastActionContext).replace("that", lastActionContext).replace("this", lastActionContext)
            if (lower == "off") lower = "turn $lastActionContext off"
            if (lower == "on") lower = "turn $lastActionContext on"
        }

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

        // --- Music commands --- routed through resistance system in onSpeech
        // handleLocally returns null for music so it's handled by the resistance router above

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
                lastActionContext = "flashlight"
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

    private fun readPhoneCalendar(): String? {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALENDAR)
            != PackageManager.PERMISSION_GRANTED) {
            return null
        }
        try {
            val now = System.currentTimeMillis()
            val weekEnd = now + 7 * 24 * 60 * 60 * 1000L
            val projection = arrayOf(
                android.provider.CalendarContract.Events.TITLE,
                android.provider.CalendarContract.Events.DTSTART,
                android.provider.CalendarContract.Events.DTEND,
                android.provider.CalendarContract.Events.ALL_DAY,
                android.provider.CalendarContract.Events.EVENT_LOCATION
            )
            val selection = "${android.provider.CalendarContract.Events.DTSTART} >= ? AND ${android.provider.CalendarContract.Events.DTSTART} <= ?"
            val selectionArgs = arrayOf(now.toString(), weekEnd.toString())
            val cursor = contentResolver.query(
                android.provider.CalendarContract.Events.CONTENT_URI,
                projection, selection, selectionArgs,
                "${android.provider.CalendarContract.Events.DTSTART} ASC"
            ) ?: return null

            val events = mutableListOf<String>()
            val dateFormat = java.text.SimpleDateFormat("EEEE, MMM d 'at' h:mm a", java.util.Locale.US)
            cursor.use { c ->
                while (c.moveToNext()) {
                    val title = c.getString(0) ?: "Untitled"
                    val start = c.getLong(1)
                    val location = c.getString(4)
                    val dateStr = dateFormat.format(java.util.Date(start))
                    val locStr = if (!location.isNullOrBlank()) " at $location" else ""
                    events.add("$title on $dateStr$locStr")
                }
            }

            return if (events.isEmpty()) {
                "Your calendar is clear for the rest of the week. Nothing scheduled."
            } else {
                "You have ${events.size} event${if (events.size > 1) "s" else ""} this week: ${events.joinToString(". ")}"
            }
        } catch (e: Exception) {
            Log.e(TAG, "Calendar read failed: ${e.message}")
            return null
        }
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

        if (intent?.action == "PERMISSION_RESPOND") {
            val response = intent.getStringExtra("response") ?: "3"
            val permId = intent.getLongExtra("perm_id", 0)
            serviceScope.launch {
                try {
                    serverClient.api.respondPermission(
                        dev.pan.app.network.dto.PermissionRespondRequest(response, permId)
                    )
                    panLog("Permission ${if (response == "1") "allowed" else "denied"} via notification")
                } catch (e: Exception) {
                    panLog("Permission respond failed: ${e.message}")
                }
            }
            // Dismiss the notification
            notificationManager?.cancel(999)
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
        sensorContext.stop()
        try { unregisterReceiver(screenOffReceiver) } catch (_: Exception) {}
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
