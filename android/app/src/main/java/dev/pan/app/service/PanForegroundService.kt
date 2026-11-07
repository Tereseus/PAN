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
import androidx.core.app.RemoteInput
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import dagger.hilt.android.AndroidEntryPoint
import dev.pan.app.MainActivity
import dev.pan.app.audio.FeedbackSounds
import dev.pan.app.camera.CameraCapture
import dev.pan.app.data.DataRepository
import dev.pan.app.debug.TestAudio
import dev.pan.app.debug.VoiceEvents
import dev.pan.app.network.LogShipper
import dev.pan.app.network.PanServerClient
import dev.pan.app.network.SyncManager
import dev.pan.app.network.dto.Action
import dev.pan.app.network.dto.AudioUpload
import dev.pan.app.network.dto.HistoryRequest
// GeminiBrain/MediaPipe REMOVED — all AI via server (Cerebras/Gemini through Tailscale)
import dev.pan.app.audio.VoiceCollector
import dev.pan.app.audio.BargeInMonitor
import dev.pan.app.stt.GoogleStreamingStt
import dev.pan.app.tts.TtsManager
import dev.pan.app.util.Constants
import dev.pan.app.util.CpuBoost
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import javax.inject.Inject

@AndroidEntryPoint
class PanForegroundService : Service() {

    companion object {
        private const val TAG = "PanService"
        val lastAction = MutableStateFlow("")
        val micEnabled = MutableStateFlow(false) // Start muted — user unmutes when ready
        // STT engine status surface — read by MainViewModel for the UI badge.
        // Updated by the streaming STT loop with strings like "idle" / "listening" / "error: ...".
        val sttStatus = MutableStateFlow("idle")

        // PAN deliberation surfaces — drives the native PanThinkingCard.
        // Set true when a query is in flight to the server; flips false when the
        // first response chunk arrives.
        val isThinking = MutableStateFlow(false)
        // Conversational filler picked when a query goes out; cleared when first
        // chunk lands. Shown in the UI only — never spoken.
        val currentFiller = MutableStateFlow("")
        // What the user just asked (post-strip wake word).
        val lastQueryText = MutableStateFlow("")
        // What PAN replied with on the previous turn.
        val lastResponseText = MutableStateFlow("")
        // Wall-clock ms from query-send to stream complete. Drives the
        // ↳ X.Xs response-time badge in the native UI.
        val lastResponseMs = MutableStateFlow(0L)
        // ms until the first streaming chunk arrived (time-to-first-token-ish).
        val lastFirstChunkMs = MutableStateFlow(0L)

        // Conversational fillers — randomized per query so it doesn't feel robotic.
        private val CHAT_FILLERS = listOf(
            "Hold on, let me look that up.",
            "One sec, checking on that.",
            "Give me a moment.",
            "Let me think about that.",
            "Looking that up now.",
            "Pulling that up for you."
        )
        fun pickFiller(): String = CHAT_FILLERS.random()

        // (The audible filler was removed — see panSpeak/query path. The list
        // above is still used for the on-screen thinking card.)

        // Slack bridge — dedicated notification channel + RemoteInput plumbing.
        const val SLACK_CHANNEL_ID = "pan_slack"
        const val SLACK_REPLY_KEY = "slack_reply_text"   // RemoteInput result key
        const val SLACK_NOTIF_BASE = 2000                // notification-id namespace for Slack
        const val SLACK_POLL_INTERVAL_MS = 5000L

        // Generic alerts (meeting reminders, etc.) relayed through the SAME poll
        // queue as Slack but rendered as PLAIN notifications (no reply box).
        // Distinct channel + notif-id namespace so they never collide with Slack.
        const val ALERT_CHANNEL_ID = "pan_alerts"
        const val ALERT_NOTIF_BASE = 3000                // notification-id namespace for alerts
    }

    @Inject lateinit var serverClient: PanServerClient
    @Inject lateinit var syncManager: SyncManager
    @Inject lateinit var logShipper: LogShipper
    @Inject lateinit var dataRepository: DataRepository
    @Inject lateinit var googleStt: GoogleStreamingStt
    @Inject lateinit var sherpaStt: dev.pan.app.stt.SherpaStreamingStt

    // Which recogniser is live.
    //
    // Google's is turn-based: it recognises ONE utterance and restarts, and that
    // restart is a real seam in the audio - it is where the first word of a
    // sentence goes missing, and the utterance boundary is a 3-4s silence
    // timeout, which is most of why this has never felt like a conversation.
    // Sherpa's is continuous: one stream, no restart, and the decoder decides
    // where a thought ended.
    //
    // Chosen the same way TtsManager chooses a voice - a pref, defaulting to the
    // known-good engine, switched explicitly - and resolved ONCE so it cannot
    // change underneath a running listen loop. The log line is deliberate: the
    // last engine swap in here shipped wired to nothing and nobody could tell.
    private val sttEngine: dev.pan.app.stt.SttEngine by lazy {
        val name = getSharedPreferences("pan_stt_prefs", MODE_PRIVATE)
            .getString("engine", "sherpa") ?: "sherpa"
        panLog("STT engine: $name (${if (name == "sherpa") "continuous" else "turn-based"})")
        if (name == "sherpa") sherpaStt else googleStt
    }
    @Inject lateinit var feedbackSounds: FeedbackSounds
    @Inject lateinit var tts: TtsManager
    @Inject lateinit var interpreter: dev.pan.app.interpret.InterpreterLoop
    // GeminiBrain removed — server handles all AI
    @Inject lateinit var voiceCollector: VoiceCollector
    @Inject lateinit var cameraCapture: CameraCapture
    @Inject lateinit var nanoVision: dev.pan.app.ai.NanoVision
    @Inject lateinit var sensorContext: dev.pan.app.sensor.SensorContext
    @Inject lateinit var pendantBle: dev.pan.app.ble.PendantBle

    // Whether this service currently holds the MICROPHONE foreground-service
    // type. False when it started from the background (boot), where Android 14
    // refuses that type. STT must not run while this is false.
    @Volatile private var micForegroundActive = false

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
    private var panStoppedAt = 0L     // The same, but a barge-in does not clear it
    // How long PAN stays deaf after it finishes speaking.
    //
    // This is a BLUNT instrument sitting on top of two better ones: hardware AEC
    // (the reason playback uses USAGE_VOICE_COMMUNICATION with the audio mode set
    // to IN_COMMUNICATION) and stripEcho(), which matches the transcript against
    // PAN's own recent words and discards it when they overlap. Its only real job
    // is covering the acoustic tail still in the mic buffer the instant AudioTrack
    // stops - a few hundred ms, not over a second.
    //
    // 1200ms meant you had to wait more than a second after PAN stopped before it
    // could hear you, which is most of what makes it feel unconversational. Same
    // dial as the 300ms endpointing: if PAN starts transcribing its OWN last word,
    // raise THIS number rather than reaching for the whole pipeline.
    private val TTS_COOLDOWN_MS = 300L
    private val bargeInMonitor = BargeInMonitor()

    // Recent conversation history — sent to server so Claude has context
    private val conversationHistory = mutableListOf<Pair<String, String>>() // role, text
    // Ten lines forgot the start of a talk: asked about it later, Syrinx got 0 of 4 at ten lines
    // and 4 of 4 at forty (conversation test, 2026-11-05). Dropped ten at a time because a line
    // off the front changes the start of the prompt, and the hub reads everything after it again.
    private val MAX_HISTORY = 40
    private val HISTORY_TRIM = 10

    private fun addToHistory(role: String, text: String) {
        conversationHistory.add(role to text)
        if (conversationHistory.size > MAX_HISTORY) repeat(HISTORY_TRIM) { conversationHistory.removeAt(0) }
    }

    /** The hub's transcript replaces the phone's rougher guess at the same turn. */
    private fun replaceUserLine(phoneText: String, hubText: String) {
        val i = conversationHistory.indexOfLast { it.first == "User" && it.second == phoneText }
        if (i >= 0) conversationHistory[i] = "User" to hubText
    }

    // Spoken commands match the WHOLE utterance. Substring matching muted PAN on
    // "my commute was long" and unmuted it on "I had to wake up early" (voice plan,
    // phase 1). "pan" may lead or trail, "please" may come along.
    private val MUTE_CMD = Regex("^(?:(?:hey |ok |okay )?(?:pan|pam)[,.]?\\s+)?(?:please\\s+)?(?:mute(?: yourself)?|be quiet|shut up|stop listening|quiet)(?:\\s+please)?(?:[,]?\\s+(?:pan|pam))?[.!]?$")
    private val UNMUTE_CMD = Regex("^(?:(?:hey |ok |okay )?(?:pan|pam)[,.]?\\s+)?(?:please\\s+)?(?:unmute(?: yourself)?|wake up|start listening)(?:\\s+please)?(?:[,]?\\s+(?:pan|pam))?[.!]?$")
    private val STOP_WORDS = Regex("\\b(?:stop|enough|shut up|quiet)\\b")
    // Only a plain report that the last action failed, not any sentence with
    // "not working" in it ("my code is not working" reported a music failure).
    private val DIDNT_WORK = Regex("^(?:(?:that|it) (?:didn'?t|did not) work|try something else|(?:that'?s|it'?s|that is|it is) not working)[.!]?$")
    // Only plain requests go to the calendar or the terminal. Any sentence with
    // "meeting", "email" or "check my" in it used to: "I have a meeting tomorrow and
    // I'm nervous" read out the calendar, "check my reasoning" waited 45 s on a
    // terminal.
    private val CALENDAR_ASK = Regex("^(?:what(?:'s| is| are)|whats|read|check|tell me|show me|do i have|is there|are there|any)\\b.*\\b(?:calendar|schedule|meetings?|appointments?)\\b")
    private val EMAIL_ASK = Regex("^(?:check|read|show me|open|any|do i have|what(?:'s| is| are)|whats)\\b.*\\b(?:e-?mails?|gmail|inbox|outlook)\\b|^send (?:an? )?(?:e-?mail|message)\\b")

    // Bumped by every new turn AND by a barge-in. A reply only speaks while its turn
    // is still current: cancelling the query does not un-post chunk callbacks that
    // are already queued, so an interrupted answer used to start talking again.
    private val replySeq = java.util.concurrent.atomic.AtomicInteger(0)

    private fun getHistoryContext(): String {
        if (conversationHistory.isEmpty()) return ""
        return conversationHistory.joinToString("\n") { (role, text) ->
            "$role: ${text.take(200)}"
        }
    }

    // The hub reads the conversation before his words arrive (voice-reader.js on the hub). The
    // long read goes when a reply ends, while PAN is still talking; when he starts talking it only
    // picks up the time. Runs on the main thread, which owns conversationHistory.
    private var lastWarmAt = 0L
    private fun warmHub() {
        val now = System.currentTimeMillis()
        if (sttEngine.queryPending || now - lastWarmAt < 2000L) return
        lastWarmAt = now
        serverClient.warm(getHistoryContext(), bench = TestAudio.active)
    }

    private fun getPanDeviceId(): String =
        android.os.Build.MODEL.lowercase().replace(" ", "-")

    /** Dispatch actions from server response — handles new actions[] and backward-compat route field */
    private fun dispatchActions(actions: List<Action>?, route: String?, query: String?, text: String) {
        val deviceId = getPanDeviceId()
        // Handle new actions[] first — filter to phone-targeted actions
        actions?.filter { action ->
            action.device_type == "phone" ||
            (action.target == "device" && (action.device_id == null || action.device_id == deviceId))
        }?.forEach { action ->
            when (action.type) {
                "play_music" -> {
                    val q = action.args?.get("query") ?: query ?: text
                    val explicitService = when {
                        text.lowercase().contains("youtube") -> "youtube"
                        text.lowercase().contains("spotify") -> "spotify"
                        else -> null
                    }
                    resistanceClient.tryPlayMusic(applicationContext, q, explicitService)
                }
                "navigate" -> {
                    val dest = action.args?.get("destination") ?: query ?: text
                    try {
                        val navIntent = Intent(Intent.ACTION_VIEW,
                            Uri.parse("google.navigation:q=${Uri.encode(dest)}"))
                        navIntent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        startActivity(navIntent)
                    } catch (e: Exception) {
                        panLog("Navigation failed: ${e.message}")
                    }
                }
                "show_notification" -> {
                    // Future: show system notification with action.args["title"] / action.args["body"]
                    panLog("show_notification action received (not yet implemented)")
                }
                else -> panLog("Unknown action type: ${action.type}")
            }
        }
        // Backward compat: fall back to route field if no actions were provided
        if (actions.isNullOrEmpty() && (route == "music" || route == "play_music")) {
            val songQuery = query ?: text
            val explicitService = when {
                text.lowercase().contains("youtube") -> "youtube"
                text.lowercase().contains("spotify") -> "spotify"
                else -> null
            }
            resistanceClient.tryPlayMusic(applicationContext, songQuery, explicitService)
        }
    }

    /** Best-effort: ship one conversation turn to server for persistent history */
    // His conversation, set aside while a benchmark runs (TEST_AUDIO). Test lines
    // must never end up in it, and a run must not start from whatever he last said.
    private var benchSavedHistory: List<Pair<String, String>>? = null
    // A run unmutes PAN to play its clips and mutes it again at the end, which a run that
    // dies never reaches.
    private var benchStartedMuted = false

    // Ends a session nothing has played into for 2 minutes. A run's longest pause between
    // clips is a slow reply, well under that. Without it, a run that died (the USB cable came
    // out mid-run, 2026-11-03) left the microphone replaced by silence and PAN unmuted, deaf
    // to him until the app restarted.
    // A live session (TEST_LIVE) plays nothing, so it ends 30 minutes after it began instead:
    // left on, it would quietly keep his real conversation out of his history.
    private val benchWatchdog = object : Runnable {
        override fun run() {
            if (!TestAudio.active) return
            val limit = if (TestAudio.live) 30 * 60_000L else 120_000L
            if (TestAudio.idleMs() < limit) { mainHandler.postDelayed(this, 30_000L); return }
            panLog(if (TestAudio.live) "Live benchmark: 30 minutes up, ending it"
                   else "Benchmark abandoned: nothing played for 2 minutes, ending it")
            endBench()
            if (benchStartedMuted && !isMuted) muteNow()
        }
    }

    private fun beginBench() {
        benchSavedHistory = conversationHistory.toList()
        conversationHistory.clear()
        benchStartedMuted = isMuted
        mainHandler.removeCallbacks(benchWatchdog)
        mainHandler.postDelayed(benchWatchdog, 30_000L)
        VoiceEvents.emit("bench_start", "muted" to isMuted)
        panLog("Benchmark started: history set aside, nothing persisted")
    }

    private fun resetConversationForBench() {
        tts.stop()
        cancelInFlight()
        cancelHold("bench reset")
        pendingTurn = null
        conversationHistory.clear()
        // A scenario may repeat an earlier scenario's line on purpose.
        lastProcessedText = ""
        lastProcessedTime = 0L
        lastTtsDoneTime = 0L
        VoiceEvents.emit("bench_reset")
    }

    private fun endBench() {
        mainHandler.removeCallbacks(benchWatchdog)
        TestAudio.end()
        resetConversationForBench()
        benchSavedHistory?.let { conversationHistory.addAll(it) }
        benchSavedHistory = null
        VoiceEvents.emit("bench_end")
        panLog("Benchmark ended: history restored")
    }

    /**
     * Same as the mute button: silence in both directions. Saying "shut up" and then being
     * talked over for another sentence is the whole complaint.
     */
    private fun muteNow() {
        isMuted = true
        tts.stop()
        cancelInFlight()
        cancelHold("muted")
        sttEngine.enabled = false
        micEnabled.value = false
        notificationManager?.notify(Constants.NOTIFICATION_ID, buildNotification(listening = false, connected = serverClient.isConnected.value))
    }

    /** Speak part of turn [seq]'s reply, unless a newer turn or a barge-in moved on. */
    private fun speakReply(seq: Int, text: String) {
        mainHandler.post {
            if (replySeq.get() != seq) return@post
            if (replyWaiting.isEmpty() && !heIsTalking()) {
                // PAN is answering it now, so his next words are a new turn, not more of this one.
                pendingTurn = null
                panSpeak(text)
                return@post
            }
            // He is still talking: the reply waits for him, as a person's would. It used to start
            // on top of the rest of his sentence ("be our interpreter, [pause] she speaks
            // Japanese"), and nothing he says while PAN talks is transcribed, so the rest was lost
            // (voicebench interp, 2026-11-03). Waiting keeps pendingTurn too, so the rest joins
            // this turn (carry_on) and this reply is superseded. Capped, so a noisy room cannot
            // keep PAN quiet. The cap has to outlast a whole line: "hey pan" commits alone, and at
            // 2.5 s, or with a wait that ended on his first pause, the reply to it started just
            // before the line itself committed, and the line was dropped (conversation test,
            // 2026-11-05).
            if (replyWaiting.isEmpty()) {
                replyWaitStart = android.os.SystemClock.elapsedRealtime()
                VoiceEvents.emit("reply_wait", "text" to text)
                mainHandler.postDelayed(drainReplyWaiting, 50L)
            }
            replyWaiting.addLast(seq to text)
        }
    }

    // Sentences of a reply waiting for him to finish, in order (main thread only).
    private val replyWaiting = ArrayDeque<Pair<Int, String>>()
    private var replyWaitStart = 0L
    private val REPLY_WAIT_MAX_MS = 6000L

    private fun heIsTalking() = sttEngine.stillTalking() || sttEngine.turnOpen()

    private val drainReplyWaiting = object : Runnable {
        override fun run() {
            while (replyWaiting.isNotEmpty() && replyWaiting.first().first != replySeq.get()) replyWaiting.removeFirst()
            if (replyWaiting.isEmpty()) return
            val waited = android.os.SystemClock.elapsedRealtime() - replyWaitStart
            if (waited < REPLY_WAIT_MAX_MS && heIsTalking()) {
                mainHandler.postDelayed(this, 50L)
                return
            }
            VoiceEvents.emit("reply_go", "waited_ms" to waited)
            pendingTurn = null
            while (replyWaiting.isNotEmpty()) {
                val (s, t) = replyWaiting.removeFirst()
                if (s == replySeq.get()) panSpeak(t)
            }
        }
    }

    /**
     * Index of the first clause break (, ; :) with at least four words before it, or -1.
     * Only a break already followed by a space counts, so "1,000" is never split mid-number.
     * A one-word "Well," or "Sure," stays with what follows: a clip that short sounds clipped.
     */
    private val SENTENCE_ENDS = setOf('.', '!', '?', '。', '！', '？')

    private fun firstClauseEnd(buf: String): Int {
        for (i in 0 until buf.length - 1) {
            if (buf[i] != ',' && buf[i] != ';' && buf[i] != ':') continue
            if (buf[i + 1] != ' ') continue
            if (buf.substring(0, i).trim().split(Regex("\\s+")).size >= 4) return i
        }
        return -1
    }

    private fun persistHistoryTurn(role: String, text: String) {
        // Benchmark lines are not his conversation (TestAudio.kt).
        if (TestAudio.active) return
        serviceScope.launch(Dispatchers.IO) {
            try {
                serverClient.api.appendHistory(
                    HistoryRequest(role = role, text = text, device_id = getPanDeviceId())
                )
            } catch (_: Exception) { /* best effort */ }
        }
    }

    /** Load recent history from server into in-memory conversationHistory on startup */
    private suspend fun loadHistory() {
        try {
            val resp = serverClient.api.getHistory(getPanDeviceId(), limit = MAX_HISTORY)
            if (resp.isSuccessful) {
                resp.body()?.turns?.forEach { turn ->
                    conversationHistory.add(Pair(turn.role, turn.text))
                }
                if (conversationHistory.isNotEmpty()) {
                    panLog("Loaded ${conversationHistory.size} history turns from server")
                }
            }
        } catch (_: Exception) { /* best effort */ }
    }

    /**
     * Claim the MICROPHONE foreground-service type, if we do not already hold it.
     *
     * Needed because a boot start cannot take that type (see onCreate): the
     * service comes up as CONNECTED_DEVICE and must upgrade before any recording.
     * Safe to call repeatedly; startForeground on an already-foreground service
     * just updates it. Still guarded by try/catch, because if we are somehow not
     * in an eligible state this must degrade rather than kill the service, which
     * is the exact failure that made PAN unable to survive a reboot at all.
     */
    private fun ensureMicForeground(): Boolean {
        if (micForegroundActive) return true
        val hasMic = ContextCompat.checkSelfPermission(
            this, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        if (!hasMic) return false
        return try {
            ServiceCompat.startForeground(
                this,
                Constants.NOTIFICATION_ID,
                buildNotification(listening = true, connected = serverClient.isConnected.value),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            )
            micForegroundActive = true
            panLog("microphone foreground type acquired")
            true
        } catch (e: SecurityException) {
            panLog("cannot acquire mic foreground type yet: ${e.message}")
            false
        }
    }

    // Persistent log — ships to PAN server via batched telemetry endpoint
    private fun panLog(msg: String) {
        Log.i(TAG, msg)
        if (::logShipper.isInitialized) {
            logShipper.info("service", msg)
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
        // Surface installed build to server so the Phone Atlas / dashboard
        // Updater node can compare phone version vs server-published version.
        panLog("Build: versionCode=${dev.pan.app.BuildConfig.VERSION_CODE} versionName=${dev.pan.app.BuildConfig.VERSION_NAME} appId=${dev.pan.app.BuildConfig.APPLICATION_ID}")

        // Register screen off receiver for power button TTS stop
        registerReceiver(screenOffReceiver, android.content.IntentFilter(Intent.ACTION_SCREEN_OFF))

        // Initialize resistance client for path-of-least-resistance routing
        resistanceClient = ResistanceClient(this)
        resistanceClient.syncFromServer()

        // llama.cpp DISABLED — too slow on CPU, causes memory conflicts with MediaPipe
        // GeminiBrain (MediaPipe GPU) handles on-device AI instead

        notificationManager = getSystemService(NotificationManager::class.java)
        createNotificationChannel()

        // Request battery optimization exemption so Android doesn't kill our audio
        requestBatteryExemption()

        val hasMicPermission = ContextCompat.checkSelfPermission(
            this, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

        if (hasMicPermission) {
            // ANDROID 14 BACKGROUND-START RULE — this is why PAN never survived a
            // reboot.
            //
            // RECORD_AUDIO is a foreground-ONLY permission, so starting a
            // MICROPHONE foreground service additionally requires the app to be
            // in an eligible (foreground) state. Holding the permission is not
            // enough. A BootReceiver start is a BACKGROUND start, so this threw
            // SecurityException, took the whole service down with it, and the
            // system kept retrying: "PAN keeps stopping". Nothing ran after a
            // reboot, which is why no phone logs reached the hub for weeks and
            // why remote access looked broken.
            //
            // Falling back to CONNECTED_DEVICE keeps the service alive. That type
            // is declared in the manifest, is legal from a background start, and
            // is now literally accurate: this service owns the pendant BLE link.
            // The microphone type is claimed later, from the foreground, by
            // ensureMicForeground() when STT actually starts.
            try {
                ServiceCompat.startForeground(
                    this,
                    Constants.NOTIFICATION_ID,
                    buildNotification(listening = true, connected = false),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                )
                micForegroundActive = true
            } catch (e: SecurityException) {
                micForegroundActive = false
                Log.w(TAG, "mic FGS refused (background start), falling back: ${e.message}")
                ServiceCompat.startForeground(
                    this,
                    Constants.NOTIFICATION_ID,
                    buildNotification(listening = false, connected = false),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                )
            }

            // Wire up logging
            sttEngine.onLog = { msg -> panLog(msg) }
            // All AI via server — no local model init needed

            // When TTS finishes speaking, restart STT listening
            sttEngine.isTtsSpeaking = { tts.isSpeaking }
            sttEngine.onSpeechStart { mainHandler.post { warmHub() } }
            // sttEngine.onInterrupt is the SECOND barge-in path — fires when
            // the SpeechRecognizer thinks the user spoke during TTS playback.
            // It races BargeInMonitor: STT can flip on its own internal
            // "speech detected" heuristic from TTS bleed it picks up,
            // calling tts.stop() before BargeInMonitor's AEC + threshold
            // logic has even decided. Removing the auto-stop here so only
            // BargeInMonitor controls TTS interruption — single source of
            // truth, no race. The log still fires so we can see if STT
            // was independently detecting speech (useful diagnostic) but
            // we no longer act on it. (TTS-cutoff fix 2026-06-05.)
            sttEngine.onInterrupt = {
                if (sttEngine.listensThroughTts) {
                    // Continuous engine: this only fires on a FINAL transcript
                    // that still had real words in it after echo stripping, so
                    // the race described above cannot happen - there is no
                    // energy heuristic to lose to, and PAN's own voice has
                    // already been subtracted. Act on it.
                    panLog("Barge-in (words heard during TTS) — stopping TTS")
                    // Stop the ANSWER, not just the sound: the rest of it is still
                    // streaming from the hub and would start PAN talking again.
                    replySeq.incrementAndGet()
                    cancelInFlight()
                    cancelHold("barge-in")
                    tts.stop()
                    // Clear the post-TTS cooldown, or the sentence that just
                    // interrupted PAN gets thrown away by it.
                    //
                    // tts.stop() lands as onSpeakingStateChanged(false), which
                    // sets lastTtsDoneTime = now. onSpeech then drops anything
                    // arriving inside TTS_COOLDOWN_MS. That cooldown exists to
                    // filter ECHO, and this text has already been filtered by a
                    // strictly better test: it was transcribed, PAN's own words
                    // were subtracted from it, and words survived. Letting the
                    // blunt timer veto the precise check is how you end up
                    // having to repeat yourself.
                    lastTtsDoneTime = 0L
                } else {
                    panLog("STT detected speech during TTS (deferring to BargeInMonitor)")
                }
            }
            val audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
            // The card's number: from the moment he stopped to the moment the voice starts. It used
            // to run from sending the audio to the end of the reply stream, so it said 1.5 to 2.5 s
            // when he was really waiting 3 s (2026-11-05).
            tts.onPlayStart = {
                sttEngine.onTtsSound()
                val from = voiceFrom
                if (from > 0L) {
                    voiceFrom = 0L
                    lastResponseMs.value = System.currentTimeMillis() - from
                }
            }
            interpreter.onLine = { line -> mainHandler.post { speakInterpreted(line) } }
            interpreter.onDraft = { say, voice -> if (!isMuted) tts.prepareLine(say, voice) }
            interpreter.onHandOver = { text -> mainHandler.post { onSpeech(text) } }
            tts.onSpeakingStateChanged = { speaking ->
                if (speaking) {
                    // Switch to telephony communication mode so AEC gets the speaker
                    // reference signal and can cancel TTS bleed from the mic.
                    // speakerphoneOn=true keeps audio on the main speaker (not earpiece).
                    // This is the "speakerphone call" configuration — the proven AEC path.
                    if (!tts.plainPath) {
                        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
                        @Suppress("DEPRECATION")
                        audioManager.isSpeakerphoneOn = true
                    }
                    // MODE_IN_COMMUNICATION above stays either way: it is what
                    // gives the hardware AEC its speaker reference, and both
                    // engines depend on that. Only the energy monitor is
                    // conditional - a continuous engine is already listening
                    // through the TTS, and a second AudioRecord on the same mic
                    // is how you get a device-specific init failure.
                    if (!sttEngine.listensThroughTts) bargeInMonitor.start(serviceScope)
                } else {
                    // TTS ended naturally — restore normal audio mode, stop monitor, restart STT
                    if (!sttEngine.listensThroughTts) bargeInMonitor.stop()
                    audioManager.mode = AudioManager.MODE_NORMAL
                    lastTtsDoneTime = System.currentTimeMillis()
                    panStoppedAt = lastTtsDoneTime
                    if (sttEngine.enabled && !sttEngine.isListening) {
                        sttEngine.startListening { text, isFinal ->
                            if (text.isNotBlank() && isFinal) onSpeech(text)
                        }
                    }
                }
            }

            bargeInMonitor.onBargeIn = {
                if (tts.isSpeaking) {
                    panLog("Barge-in — stopping TTS, resuming STT")
                    tts.stop()
                    bargeInMonitor.stop()
                    audioManager.mode = AudioManager.MODE_NORMAL
                    lastTtsDoneTime = System.currentTimeMillis()
                    if (sttEngine.enabled && !sttEngine.isListening) {
                        sttEngine.startListening { text, isFinal ->
                            if (text.isNotBlank() && isFinal) onSpeech(text)
                        }
                    }
                }
            }
            bargeInMonitor.onLog = { msg -> panLog(msg) }

            panLog("AI: all queries via server (Cerebras/Gemini through Tailscale)")

            // Auto-download Piper TTS voice in background (never blocks startup)
            CoroutineScope(Dispatchers.IO).launch {
                val piper = tts.piper
                val preferred = tts.voiceQuality
                if (preferred != "android" && piper.isFullyReady(preferred)) {
                    // Already downloaded — just activate
                    mainHandler.post { tts.activateVoice(preferred) }
                    panLog("Piper TTS: $preferred voice ready")
                } else if (piper.getDownloadedVoices().isEmpty()) {
                    panLog("Piper TTS: downloading medium voice (~60MB)...")
                    val ok = piper.downloadVoice("medium")
                    if (ok) {
                        mainHandler.post {
                            tts.voiceQuality = "medium"
                            panLog("Piper TTS: medium voice ready")
                            panSpeak("Voice upgraded. Piper is ready.")
                        }
                    } else {
                        panLog("Piper TTS: download failed, using Android TTS")
                    }
                }
            }

            // Voice collector — DISABLED on phone (Android can't run two AudioRecords)
            // Raw audio for voice training comes from PC mic or pendant
            // Phone only saves transcripts via STT callback
            voiceCollector.onLog = { msg -> panLog(msg) }

            // Start muted — STT only starts when user unmutes
            if (micEnabled.value) {
                sttEngine.startListening { text, isFinal ->
                    if (text.isNotBlank() && isFinal) {
                        voiceCollector.onTranscript(text)
                        onSpeech(text)
                    }
                }
                panLog("STT started (mic enabled)")
            } else {
                // micEnabled starts false, but the ENGINE's own enabled flag
                // defaults to true - so from boot the two disagreed, and since
                // TOGGLE_MIC computed !sttEngine.enabled the first press of the
                // mute button 'turned off' something that had never started.
                // Pressing unmute muted it. Say what is actually true instead.
                sttEngine.enabled = false
                isMuted = true
                panLog("STT NOT started (muted on startup)")
                // Load the speech model now, so the first unmute is listening at once.
                (sttEngine as? dev.pan.app.stt.SherpaStreamingStt)?.warmUp()
            }
        } else {
            startForeground(Constants.NOTIFICATION_ID, buildNotification(listening = false, connected = false))
            panLog("No mic permission — running without audio")
        }

        // Start sensor collection (GPS, compass, accelerometer, etc.)
        sensorContext.start()
        panLog("Sensors started")

        acquireWakeLock()
        logShipper.start()

        // Bring remote access back up by itself.
        //
        // WHY HERE AND NOT IN BootReceiver: a BroadcastReceiver gets roughly ten
        // seconds, while PanVpn.connect() polls for up to thirty, so doing it in
        // the receiver would be killed part way. This service is started BY that
        // receiver on boot and is long lived, so it is the right owner.
        //
        // WHAT WAS BROKEN: BootReceiver only ever started this service, nothing
        // ever started the VPN, and connectTailscale() runs solely from
        // MainScreen's LaunchedEffect. So after a reboot the phone came back
        // with voice working but silently OFF the tailnet until the app was
        // opened by hand.
        //
        // The consent check is load bearing: VpnService consent can only be
        // granted from an Activity. prepareVpn() returning non-null means it has
        // not been granted, and there is no way to ask from here, so skip
        // quietly and let MainScreen prompt on next open rather than fail in a
        // loop. autoConnect() itself is a no-op unless the user previously had
        // remote access connected.
        // Logged on every branch on purpose. The bug this replaces was invisible
        // precisely because nothing said the VPN had not been started.
        serviceScope.launch {
            try {
                if (dev.pan.app.vpn.PanVpn.prepareVpn(this@PanForegroundService) == null) {
                    val wanted = getSharedPreferences("pan_vpn", MODE_PRIVATE)
                        .getBoolean("enabled", false)
                    panLog("VPN auto-connect: consent ok, previously enabled=$wanted")

                    // Fetch the tailnet auth key BEFORE connecting.
                    //
                    // WHAT WAS BROKEN: only SettingsViewModel.enableRemoteAccess()
                    // ever called /tailscale/auto-auth, so this path always handed
                    // tsnet an empty key. tsnet then fell back to interactive
                    // browser login, never finished registering, and so never wrote
                    // its node identity to files/tailscale/ - which meant there was
                    // nothing to reuse and the login was demanded again every time.
                    //
                    // Only needed once per install: after a successful registration
                    // tsnet reuses its own state and the key is irrelevant. The hub
                    // must be reachable for this, which on a fresh device means the
                    // home LAN. That is inherent, not a bug: you cannot reach a
                    // tailnet-only hub before you are on the tailnet.
                    val vpnPrefs = getSharedPreferences("pan_vpn", MODE_PRIVATE)
                    if (vpnPrefs.getString("auth_key", "").isNullOrBlank()) {
                        try {
                            val r = serverClient.api.getTailscaleAuthKey(mapOf("action" to "get_key"))
                            val k = r.body()?.get("auth_key") as? String
                            if (r.isSuccessful && !k.isNullOrBlank()) {
                                dev.pan.app.vpn.PanVpn.setAuthKey(this@PanForegroundService, k)
                                panLog("VPN auto-connect: got auth key from hub (len=${k.length})")
                            } else {
                                panLog("VPN auto-connect: no auth key from hub (HTTP ${r.code()})")
                            }
                        } catch (e: Exception) {
                            panLog("VPN auto-connect: auth key fetch failed: ${e.message}")
                        }
                    }

                    dev.pan.app.vpn.PanVpn.autoConnect(this@PanForegroundService)
                    panLog("VPN auto-connect: returned")
                } else {
                    panLog("VPN auto-connect skipped: consent not granted yet")
                }
            } catch (e: Exception) {
                panLog("VPN auto-connect failed: ${e.message}")
            }
        }

        // Camera pendant over BLE. Frames are STORED, not analysed: analyse=false
        // keeps the hub at ~0.1s per frame instead of seconds, which is what makes
        // a five second cadence affordable at all. The expensive path is the
        // deliberate "look at this" request, not the ambient stream.
        pendantBle.onFrame = { jpeg, w, h ->
            serviceScope.launch {
                try {
                    val b64 = android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP)
                    val resp = serverClient.api.uploadPhoto(
                        dev.pan.app.network.dto.PhotoUpload(
                            jpeg_base64 = b64,
                            timestamp = System.currentTimeMillis(),
                            source = "pendant",
                            analyze = false,
                        )
                    )
                    if (!resp.isSuccessful) panLog("Pendant frame upload HTTP ${resp.code()}")
                } catch (e: Exception) {
                    // Never let an upload failure kill the BLE link; the pendant
                    // keeps streaming and the next frame gets another go.
                    panLog("Pendant frame upload failed: ${e.message}")
                }
            }
        }
        serviceScope.launch {
            try {
                if (pendantBle.isSupported()) {
                    panLog("Pendant BLE: starting scan for PAN-CAM")
                    pendantBle.start()
                } else {
                    panLog("Pendant BLE: no bluetooth adapter, skipping")
                }
            } catch (e: Exception) {
                panLog("Pendant BLE start failed: ${e.message}")
            }
        }

        serviceScope.launch { syncManager.start() }
        serviceScope.launch { loadHistory() }
        serviceScope.launch {
            serverClient.registerDevice(
                deviceId = getPanDeviceId(),
                deviceName = android.os.Build.MODEL
            )
        }

        // Notification updater
        serviceScope.launch {
            serverClient.isConnected.collect { connected ->
                lastConnected = connected
                notificationManager?.notify(
                    Constants.NOTIFICATION_ID,
                    buildNotification(listening = sttEngine.enabled, connected = connected)
                )
            }
        }

        // Permission prompt polling — check every 5 seconds, show Android notification
        startPermissionPolling()
        // Intuition glance — keep the ongoing notification showing PAN's live read (30s)
        startIntuitionPolling()
        // Slack bridge — poll for inbound Slack messages, raise native reply notifications (5s)
        startSlackPolling()
    }

    private var lastPermId: Long = 0
    // High-water mark of the last Slack notify id we've already surfaced — the
    // server drains its queue on GET, but this guards against re-delivery on retry.
    @Volatile private var lastSlackId: Long = 0

    // Live intuition shown in the ongoing notification (lock-screen glance).
    @Volatile private var lastConnected: Boolean = false
    @Volatile private var intuitionSummary: String? = null
    @Volatile private var intuitionFull: String? = null

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

    // Polls PAN's live situational read and folds it into the ongoing notification,
    // so you can glance at your lock screen (no unlock) and see what PAN senses.
    private fun startIntuitionPolling() {
        serviceScope.launch {
            while (isActive) {
                try {
                    val now = serverClient.api.getIntuitionCurrent().body()?.snapshot?.now
                    if (now != null) {
                        fun clean(s: String?) = s?.trim()?.takeIf { it.isNotEmpty() }
                        intuitionSummary = listOfNotNull(clean(now.mood), clean(now.focus), clean(now.activity))
                            .joinToString(" · ").ifEmpty { null }
                        val lines = mutableListOf<String>()
                        clean(now.activity)?.let { lines.add("Activity: $it") }
                        clean(now.focus)?.let { lines.add("Focus: $it") }
                        clean(now.mood)?.let { m -> lines.add("Mood: $m" + (clean(now.mood_detail)?.let { " — $it" } ?: "")) }
                        clean(now.direction)?.let { lines.add("Direction: $it") }
                        clean(now.need)?.let { lines.add("Need: $it") }
                        clean(now.urgency)?.takeIf { !it.equals("normal", true) }?.let { lines.add("Urgency: $it") }
                        intuitionFull = lines.joinToString("\n").ifEmpty { null }
                        notificationManager?.notify(
                            Constants.NOTIFICATION_ID,
                            buildNotification(listening = sttEngine.enabled, connected = lastConnected)
                        )
                    }
                } catch (_: Exception) {}
                delay(30000)
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
            .setContentTitle("Π Permission Required")
            .setContentText(perm.prompt)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .addAction(0, "Allow", allowPending)
            .addAction(0, "Deny", denyPending)
            .build()

        notificationManager?.notify(999, notification)
    }

    // ── Slack bridge ─────────────────────────────────────────────────────────
    // The phone has no open push channel (DevicePushClient is unused) — every
    // server->phone signal today is POLLED (permissions, intuition). Slack
    // follows the same model: drain a per-device queue on the hub and raise a
    // native RemoteInput reply notification for each new message. The reply box
    // supports voice dictation natively — reply by typing OR speaking.
    private fun startSlackPolling() {
        serviceScope.launch {
            while (isActive) {
                delay(SLACK_POLL_INTERVAL_MS)
                try {
                    val resp = serverClient.api.getSlackPending(getPanDeviceId())
                    val notes = resp.body()?.notifications ?: continue
                    for (note in notes) {
                        if (note.id <= lastSlackId) continue
                        lastSlackId = note.id   // shared high-water across ALL types
                        // Branch on type: slack (or anything carrying a channelId)
                        // keeps the existing RemoteInput reply notification; every
                        // other type renders as a plain alert (no reply box).
                        if (note.type == "slack" || note.channelId != null) {
                            showSlackNotification(note)
                        } else if (note.type == "speak") {
                            // A Claude thread answered after the voice turn
                            // closed (thread relay). Say it, and leave it on
                            // screen in case it was missed or muted.
                            val say = note.body?.trim().orEmpty()
                            if (say.isNotEmpty()) mainHandler.post { panSpeak(say) }
                            showAlertNotification(note)
                        } else {
                            showAlertNotification(note)
                        }
                    }
                } catch (_: Exception) {}
            }
        }
    }

    private fun ensureSlackChannel() {
        val channel = NotificationChannel(
            SLACK_CHANNEL_ID, "Slack",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Slack messages relayed through PAN — reply by voice or text"
            enableVibration(true)
        }
        notificationManager?.createNotificationChannel(channel)
    }

    // Stable per-message notification id so the reply handler can update the
    // exact same notification (Sending… -> Sent/Failed). Namespaced away from
    // the ongoing (1) / permission (999) ids.
    private fun slackNotifId(id: Long): Int = SLACK_NOTIF_BASE + (id % 100000).toInt()

    private fun showSlackNotification(note: dev.pan.app.network.dto.SlackNotify) {
        ensureSlackChannel()
        val notifId = slackNotifId(note.id)

        // Title = "#channel · sender" when we know the channel, else just sender.
        val sender = note.sender?.takeIf { it.isNotBlank() } ?: "Slack"
        val title = note.channel?.takeIf { it.isNotBlank() }?.let { "$it · $sender" } ?: sender
        val bodyText = note.text ?: ""

        // RemoteInput reply box — voice dictation works out of the box.
        val remoteInput = RemoteInput.Builder(SLACK_REPLY_KEY)
            .setLabel("Reply to Slack")
            .build()

        // MUST be MUTABLE — the system fills in the typed/spoken text on the intent.
        val replyIntent = Intent(this, PanForegroundService::class.java).apply {
            action = "SLACK_REPLY"
            putExtra("channelId", note.channelId)
            putExtra("notif_id", notifId)
            putExtra("channel_title", title)
        }
        val replyPending = PendingIntent.getService(
            this, notifId, replyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )

        val replyAction = NotificationCompat.Action.Builder(
            android.R.drawable.ic_menu_send, "Reply", replyPending
        ).addRemoteInput(remoteInput)
            .setAllowGeneratedReplies(true)
            .build()

        val notification = NotificationCompat.Builder(this, SLACK_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(bodyText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bodyText))
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .addAction(replyAction)
            .build()

        notificationManager?.notify(notifId, notification)
        panLog("Slack notify #${note.id} from $sender -> notification $notifId")
    }

    // Re-post the notification after a reply attempt to reflect Sending/Sent/Failed.
    private fun updateSlackStatus(notifId: Int, title: String, status: String, ongoing: Boolean) {
        val notification = NotificationCompat.Builder(this, SLACK_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(status)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            .build()
        notificationManager?.notify(notifId, notification)
    }

    // ── Generic alerts (meeting reminders, etc.) ─────────────────────────────
    // Same poll queue as Slack, but a PLAIN notification: title + body, no reply
    // box. Tapping opens the app (same launch pattern as the ongoing notif).
    // Retires ntfy — meeting/other pushes now ride the existing device queue.
    private fun ensureAlertChannel() {
        val channel = NotificationChannel(
            ALERT_CHANNEL_ID, "PAN",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "PAN alerts (meeting reminders and other notifications)"
            enableVibration(true)
        }
        notificationManager?.createNotificationChannel(channel)
    }

    // Distinct id namespace from Slack so the two never collide.
    private fun alertNotifId(id: Long): Int = ALERT_NOTIF_BASE + (id % 100000).toInt()

    private fun showAlertNotification(note: dev.pan.app.network.dto.SlackNotify) {
        ensureAlertChannel()
        val notifId = alertNotifId(note.id)

        val title = note.title?.takeIf { it.isNotBlank() }
            ?: note.type?.replaceFirstChar { it.uppercase() }
            ?: "PAN"
        val body = note.body ?: ""

        // Tap → open the app (reuse the ongoing-notification launch pattern).
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val openPending = PendingIntent.getActivity(
            this, notifId, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openPending)
            .build()

        notificationManager?.notify(notifId, notification)
        panLog("Alert notify #${note.id} type=${note.type} '$title' -> notification $notifId")
    }

    // Stop STT before speaking, restart after TTS finishes (or barge-in)
    // Drop a reply that was waiting for the room to go quiet. Called whenever
    // the premise stops holding: he spoke again, or he muted PAN.
    private fun cancelHold(why: String) {
        val r = pendingHold ?: return
        pendingHold = null
        mainHandler.removeCallbacks(r)
        panLog("Held reply dropped ($why)")
    }

    /**
     * The hub says whether he has PAN interpreting, after every reply. The phone hears, translates
     * and speaks on its own if it has the models for the language; if not, turns keep going to the
     * hub. Either way turns end sooner (SttEngine.interpreting).
     */
    // The media volume from before interpreting, while it is raised. Media is wherever music left
    // it, maybe zero, and the other person has to hear this.
    private var mediaBefore = -1

    private fun interpreterVolume(on: Boolean) {
        val audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        val stream = AudioManager.STREAM_MUSIC
        if (on && mediaBefore < 0) {
            // Four fifths, not the top: from 20 to 25 of 25 on the Pixel the vowels gain under 1 dB
            // and the S sounds 7, and that is the crackle the owner heard (2026-11-06).
            val wanted = audioManager.getStreamMaxVolume(stream) * 4 / 5
            val now = audioManager.getStreamVolume(stream)
            if (now < wanted) {
                mediaBefore = now
                audioManager.setStreamVolume(stream, wanted, 0)
            }
        } else if (!on && mediaBefore >= 0) {
            audioManager.setStreamVolume(stream, mediaBefore, 0)
            mediaBefore = -1
        }
    }

    private fun setInterpreter(lang: String?) {
        sttEngine.interpreting = lang != null
        interpreterVolume(lang != null)
        if (lang == null) {
            sttEngine.ear = null
            interpreter.end()
            tts.interpreting = false
            return
        }
        if (lang != "?") mainHandler.post { tts.prepareLanguage(lang) }
        serviceScope.launch(Dispatchers.Default) {
            if (interpreter.begin(lang)) {
                sttEngine.ear = interpreter
                tts.warmVoice()
                panLog("Interpreting $lang on the phone")
            } else {
                sttEngine.ear = null
                panLog("Interpreting $lang through the hub: no models on the phone")
            }
        }
    }

    /** A line the phone translated by itself. What a hub reply does, without the hub. */
    private fun speakInterpreted(line: dev.pan.app.interpret.InterpreterLoop.Line) {
        if (isMuted) return
        // Anything still on its way from the hub is overtaken, like any new turn.
        val mySeq = replySeq.incrementAndGet()
        cancelInFlight()
        pendingTurn = null
        voiceFrom = line.stoppedAt
        tts.interpreting = true
        tts.lineVoice = line.voice
        // With a PAN on the far side the mic hears them finishing, which is not him still talking:
        // waiting for that held every reply back 0.85 s (2026-11-06).
        if (dev.pan.app.interpret.PeerLink.on) panSpeak(line.say) else speakReply(mySeq, line.say)
        lastQueryText.value = line.heard
        lastResponseText.value = line.say
        addToHistory("User", line.heard)
        addToHistory("PAN", line.say)
        persistHistoryTurn("user", line.heard)
        persistHistoryTurn("assistant", line.say)
        serviceScope.launch {
            dataRepository.addUserMessage(line.heard)
            dataRepository.addPanResponse(line.say)
        }
    }

    // When he stopped talking on the turn being answered, for the card's stop to voice time.
    @Volatile private var voiceFrom = 0L

    private fun stoppedOr(fallback: Long): Long {
        val at = sttEngine.lastStopAt()
        return if (at > 0L && fallback - at < 30_000L) at else fallback
    }

    private fun panSpeak(text: String) {
        // The last gate before anything is spoken, and the only one that can
        // work. Cancelling the query does not un-post the mainHandler.post{} calls
        // its chunk callbacks already queued, so muting mid-answer still let a
        // sentence through 5ms after 'query cancelled'. Everything that speaks
        // comes through here, so this is where muted has to mean silent.
        if (isMuted) {
            panLog("Suppressed while muted: ${text.take(40)}")
            return
        }
        VoiceEvents.emit("speak", "text" to text)
        sttEngine.registerTtsOutput(text)
        // A turn-based recogniser has to be stopped here or it transcribes PAN
        // and fights it for audio focus. A continuous one is built to stay open
        // through TTS - that is what lets an interruption arrive as words rather
        // than as a noise spike - so stopping it would throw away the whole
        // reason for having it.
        if (!sttEngine.listensThroughTts) sttEngine.stopListening()
        tts.speak(text)
        // Barge-in monitor starts on speaking=true (audio actually playing), not here.
        // Piper has a synthesis delay so calibration must happen during live playback.
    }

    // Log every command to the server so it's always visible for debugging
    private fun logToServer(text: String, intent: String, result: String, handledBy: String) {
        if (TestAudio.active) return
        if (::logShipper.isInitialized) {
            logShipper.info("command", "[$handledBy|$intent] $text -> $result")
        }
    }

    // The query currently in flight to the hub, so a NEW utterance can cancel
    // it. Without this each fragment started its own request: a single
    // explanation produced eleven turns, nine spoken answers, and two streams
    // racing inside the same second. An answer to something he has already
    // moved past is worse than no answer. (Task #460.)
    @Volatile private var inFlightQuery: kotlinx.coroutines.Job? = null
    // Its HTTP call. Cancelling the coroutine alone did not close the connection: the hub
    // kept generating the dropped reply on its CPU while his next turn waited behind it.
    // Closing the call is what tells the hub (res 'close' aborts the model).
    @Volatile private var inFlightCall: okhttp3.Call? = null
    @Volatile private var lastNoReplySpokenAt = 0L
    private val NO_REPLY_REPEAT_MS = 60_000L

    // The turn sent last, until PAN starts answering it. Words that follow within
    // CARRY_ON_MS are the rest of it (onSpeech). Main thread only.
    private class PendingTurn(val text: String, val audio: ShortArray?, val at: Long, val seq: Int)
    private var pendingTurn: PendingTurn? = null
    private val CARRY_ON_MS = 5000L
    // 30 s of 16 kHz audio; past that the hub hears the phone's words instead.
    private val CARRY_AUDIO_MAX = 30 * 16000

    private fun cancelInFlight() {
        inFlightQuery?.cancel()
        inFlightCall?.cancel()
        inFlightCall = null
    }

    // A reply the hub was not sure enough to speak straight away. It sits here
    // for hold_ms and is cancelled the moment he says anything else, which is
    // the whole point: if he was mid-sentence with somebody else, he carries on
    // and this never fires. If the room goes quiet, he was talking to us.
    private var pendingHold: Runnable? = null

    private fun onSpeech(heard: String) {
        // Both can grow below, when this turn carries on from the last one (CARRY_ON_MS).
        var text = heard
        var lower = text.lowercase().trim()

        // Dedup — ignore identical text within 3 seconds
        val now = System.currentTimeMillis()
        VoiceEvents.emit("on_speech", "text" to text)
        if (lower == lastProcessedText && now - lastProcessedTime < DEDUP_WINDOW_MS) {
            panLog("Dedup skipped: $lower")
            VoiceEvents.emit("drop", "reason" to "dedup", "text" to text)
            return
        }
        lastProcessedText = lower
        lastProcessedTime = now

        panLog("Heard: $text")
        lastAction.value = text
        // Taken here, keyed by this exact text, so it rides with THIS turn's query.
        var turnAudio = sttEngine.takeTurnAudio(text)
        // He stopped mid-sentence and the wait for the rest ran out. Read before a carry_on
        // merge: what matters is how the LAST piece ended.
        val unfinished = sttEngine.turnUnfinished(text)

        // Cooldown after TTS: ignore echo/residual audio for TTS_COOLDOWN_MS after PAN stops
        // talking. Not a turn heard entirely before PAN started (turnHeardBeforePan): that one
        // was only decided once PAN stopped, so it always landed in here and was lost.
        if (!sttEngine.turnHeardBeforePan(text) &&
            System.currentTimeMillis() - lastTtsDoneTime < TTS_COOLDOWN_MS) {
            panLog("Cooldown (ignoring post-TTS echo): ${lower.take(30)}")
            VoiceEvents.emit("drop", "reason" to "cooldown", "text" to text)
            return
        }

        // Stop talking — only exact short phrases while TTS is active
        if (tts.isSpeaking) {
            if (STOP_WORDS.containsMatchIn(lower)) {
                replySeq.incrementAndGet()
                cancelInFlight()
                tts.stop()
                panLog("TTS stopped by user: $lower")
                VoiceEvents.emit("user_stop", "text" to text)
                return
            }
            // TTS is still talking and user said something else — ignore it (probably echo)
            VoiceEvents.emit("drop", "reason" to "tts_speaking", "text" to text)
            return
        }

        // Mute / unmute check — before any other processing
        if (MUTE_CMD.matches(lower)) {
            panLog("PAN muted by voice command")
            VoiceEvents.emit("drop", "reason" to "mute_command", "text" to text)
            muteNow()
            feedbackSounds.onCommandSent()
            serviceScope.launch { dataRepository.addUserMessage(text) }
            serviceScope.launch { dataRepository.addPanResponse("[PAN muted]") }
            return
        }
        if (UNMUTE_CMD.matches(lower)) {
            panLog("PAN unmuted by voice command")
            VoiceEvents.emit("drop", "reason" to "unmute_command", "text" to text)
            // If the service came up from boot it holds CONNECTED_DEVICE, not
            // MICROPHONE. Claim the mic type before recording, or Android kills
            // the recording (or the service) for using the mic without it.
            ensureMicForeground()
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

        // He carried on. The pause before these words was long enough to commit the last
        // ones, but PAN had not started answering them, so it is one turn said with a breath
        // in it: "can you explain ... in simple words ... how a fridge keeps things cold" went
        // to the hub as three turns (voicebench, 2026-11-02). The words and the audio go
        // together, and the reply to the first part is cancelled below as superseded.
        val prev = pendingTurn
        if (prev != null && prev.seq == replySeq.get() && now - prev.at < CARRY_ON_MS) {
            text = "${prev.text} $text"
            lower = text.lowercase().trim()
            val a = turnAudio
            turnAudio = if (prev.audio != null && a != null && prev.audio.size + a.size <= CARRY_AUDIO_MAX) prev.audio + a else null
            // Its line is the last one: nothing was said back to it.
            if (conversationHistory.lastOrNull()?.first == "User") conversationHistory.removeAt(conversationHistory.size - 1)
            VoiceEvents.emit("carry_on", "text" to text, "audio" to (turnAudio != null))
        }
        pendingTurn = null

        // The card shows the last exchange PAN answered: question, reply and timings are
        // written together when the reply lands (streaming branch), so they always match.
        // They used to be cleared here, on every line heard: with a TV or other people in
        // the room the reply he had just been told vanished seconds later, and "You asked"
        // showed the phone's rough transcript, not what the hub heard (owner, 2026-11-03).

        // Always save transcript and user message for conversation screen
        persistHistoryTurn("user", text)
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
        if (DIDNT_WORK.matches(lower)) {
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
        val isCalendarAsk = !isOpenCommand && CALENDAR_ASK.containsMatchIn(lowerStripped)
        val isGoogleQuery = isCalendarAsk || (!isOpenCommand && EMAIL_ASK.containsMatchIn(lowerStripped))
        if (isGoogleQuery) {
            // Try reading calendar directly from Android CalendarProvider (instant, no network)
            if (isCalendarAsk) {
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

        // The lines BEFORE this one. The hub adds the heard line to the prompt itself,
        // so taking history after adding it showed him saying it twice, unlike the
        // training data.
        val historyContext = getHistoryContext()
        addToHistory("User", text)

        // He said something new, so whatever the hub is still composing is about
        // the previous thing. Drop it rather than speaking it over him.
        inFlightQuery?.let {
            if (it.isActive) {
                panLog("Superseded — cancelling in-flight query")
                cancelInFlight()
            }
        }
        val mySeq = replySeq.incrementAndGet()
        pendingTurn = PendingTurn(text, turnAudio, now, mySeq)

        inFlightQuery = serviceScope.launch {
            try {

            // Skip llama.cpp classifier — was adding 9s overhead
            // Return dummy "unknown" so everything falls through to GeminiBrain/server
            val localIntent = dev.pan.app.ai.LocalLlm.IntentResult(intent = "unknown", query = stripped, service = null, local = false, elapsedMs = 0)

            // Override: force recall if user mentions conversations/history/remember
            // Every phrase here must be unambiguously ABOUT A PAST CONVERSATION.
            //
            // The list used to include "look up what", "search for what", "find in
            // the", "talk about", "say about" and "said about". Those are search
            // and conversation phrasings, not memory ones, so "look up what the
            // weather is tomorrow" was force-routed into a search of his own chat
            // history. Anything that merely expresses wanting information belongs
            // to the classifier, not to this override.
            //
            // Dropping a keyword is safe: without a match the local intent stays
            // as classified (often "unknown") and the turn goes to the server,
            // which routes it properly. A wrong match here cannot be recovered.
            val recallKeywords = listOf("what did we talk", "what did i say",
                "do you remember", "remember when", "find what i said",
                "what we said about", "were we talking about",
                "were we saying about", "what were we saying", "what were we talking",
                "we talked about", "we discussed", "we were discussing", "did i mention",
                "did we mention", "did we discuss", "what did we say",
                "our conversation", "previous conversation", "earlier conversation")
            // Match on WORD BOUNDARIES, not raw substrings.
            //
            // WHAT WAS BROKEN: plain contains() meant "conversation" matched
            // "conversational", so "let's see how conversational you are, tell me
            // about the future" was force-routed to recall and PAN searched the
            // user's own history for "the future". Any keyword that is a prefix of
            // a longer everyday word had the same failure mode.
            // About the conversation he is in right now ("what did I say the dog is
            // called")? Then the history this turn carries has the answer, and the
            // normal path reads it. Recall searches long-term memory WITHOUT that
            // history and answered "nothing saved" two turns after he said it.
            val longTermKeywords = listOf("do you remember", "remember when",
                "previous conversation", "earlier conversation")
            fun said(kws: List<String>) = kws.any { kw ->
                Regex("\\b" + Regex.escape(kw) + "\\b").containsMatchIn(stripped)
            }
            val forceRecall = said(recallKeywords) && (historyContext.isBlank() || said(longTermKeywords))
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
                        // Server does FTS5 DB search + Cerebras, streamed so first sentence plays immediately
                        panLog("Recall → server (stream): '$stripped'")
                        sttEngine.queryPending = true
                        try {
                            val sentenceBuf = StringBuilder()
                            val fullBuf = StringBuilder()
                            val result = serverClient.recallStream(stripped) { chunk ->
                                sttEngine.queryPending = false // first chunk = TTS about to start
                                sentenceBuf.append(chunk)
                                fullBuf.append(chunk)
                                val lastPunct = sentenceBuf.indexOfLast { it in SENTENCE_ENDS }
                                if (lastPunct > 0) {
                                    val sentence = sentenceBuf.substring(0, lastPunct + 1).trim()
                                    sentenceBuf.delete(0, lastPunct + 1)
                                    speakReply(mySeq, sentence)
                                }
                            }
                            sttEngine.queryPending = false // clear on completion (no chunks case)
                            // Speak any trailing text that didn't end with punctuation
                            val tail = sentenceBuf.toString().trim()
                            if (tail.isNotEmpty()) speakReply(mySeq, tail)
                            val fullMsg = fullBuf.toString().ifEmpty { "Couldn't search conversations." }
                            addToHistory("PAN", fullMsg)
                            dataRepository.addPanResponse(fullMsg)
                        } catch (e: Exception) {
                            sttEngine.queryPending = false
                            panLog("Recall stream failed: ${e.message}")
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

            // All AI goes through server (Cerebras/Gemini) via Tailscale — streaming mode
            val startTime = System.currentTimeMillis()
            voiceFrom = stoppedOr(startTime)
            // He spoke again, so a held reply has been overtaken. This is the
            // cancel signal the hold is waiting on - no new mechanism needed,
            // a fresh utterance IS the evidence that the last one was not for us.
            cancelHold("new utterance")
            sttEngine.queryPending = true

            // PanThinkingCard surfaces — flip ON for the duration of this query.
            // Picked filler is shown in the UI. Not spoken.
            val filler = pickFiller()
            isThinking.value = true
            currentFiller.value = filler
            var heardText = text    // the card's "You asked": the hub's words replace these in onHeard
            // The SPOKEN filler is gone. It was scheduled at 1500ms, which used to
            // be comfortably inside the wait - the prompt cut and local streaming
            // brought first-token down to 0.7-1.9s, so it started firing just as
            // the real answer landed. Worse, cancelling the coroutine does not stop
            // audio already handed to AudioTrack, so it played IN FULL: measured
            // `Playback done (1890ms, played 83359/83359 frames)` followed by
            // "Rome." - a 1.9s answer reaching the ear at nearly 4s. It also said
            // "let me look that up", which the prompt explicitly forbids PAN from
            // saying. currentFiller still drives the on-screen thinking card; only
            // the speech is removed.

            try {
                val sensorData = sensorContext.getContextEnvelope()
                val sensorJson = if (sensorData != null && sensorData.isNotEmpty()) {
                    org.json.JSONObject(sensorData).toString()
                } else null

                // Sentence buffer for streaming TTS — speak each sentence as it arrives
                val sentenceBuf = StringBuilder()
                var firstChunkTime = 0L
                var spokeFirst = false

                VoiceEvents.emit("query", "text" to text, "history_lines" to conversationHistory.size,
                    "audio" to (turnAudio != null), "unfinished" to unfinished)
                // Upload, the hub's reply stream and the first sentence's synthesis all run
                // on this phone's cores; with the screen off they start unboosted.
                CpuBoost.burst(applicationContext)
                // The quick English voice is for an interpreting reply only; the hub says so
                // at the start of each one (onInterpreting).
                tts.interpreting = false
                val response = serverClient.askPanStream(
                    text = text,
                    conversationHistory = historyContext,
                    sensorJson = sensorJson,
                    canCamera = sensorContext.cameraEnabled,
                    audio = turnAudio,
                    bench = TestAudio.active,
                    unfinished = unfinished,
                    sincePanMs = if (tts.isSpeaking) 0L else if (panStoppedAt > 0L) System.currentTimeMillis() - panStoppedAt else null,
                    onCall = { inFlightCall = it },
                    onHeard = { heard ->
                        panLog("Hub heard: $heard")
                        VoiceEvents.emit("heard", "text" to heard)
                        lastAction.value = heard
                        heardText = heard
                        // History keeps what the hub heard, not the phone's rougher guess.
                        mainHandler.post { replaceUserLine(text, heard) }
                    },
                    onInterpreting = { tts.interpreting = true },
                    onInterpreter = { lang -> setInterpreter(lang) },
                    onChunk = { chunk ->
                        if (firstChunkTime == 0L) {
                            firstChunkTime = System.currentTimeMillis()
                            VoiceEvents.emit("first_chunk", "ms" to (firstChunkTime - startTime))
                            sttEngine.queryPending = false // first chunk = TTS about to start
                            // Stream started — cancel the audible filler and clear it
                            // from the UI.
                            currentFiller.value = ""
                        }
                        sentenceBuf.append(chunk)
                        // Speak each complete sentence as it arrives. 。！？ too: a reply in
                        // Japanese has no ASCII stop, so it waited for the whole reply.
                        val buf = sentenceBuf.toString()
                        var lastPunct = buf.indexOfLast { it in SENTENCE_ENDS }
                        // The reply's FIRST piece goes at its first clause, not its first full
                        // stop: "Well, if the moon were twice as big," is ready well before the
                        // sentence ends, and the rest is synthesised while it plays.
                        if (lastPunct <= 0 && !spokeFirst) lastPunct = firstClauseEnd(buf)
                        if (lastPunct > 0) {
                            val sentence = buf.substring(0, lastPunct + 1).trim()
                            val remainder = buf.substring(lastPunct + 1)
                            sentenceBuf.clear()
                            sentenceBuf.append(remainder)
                            if (sentence.isNotBlank()) {
                                spokeFirst = true
                                speakReply(mySeq, sentence)
                            }
                        }
                    }
                )

                val elapsed = System.currentTimeMillis() - startTime
                sttEngine.queryPending = false // clear after response received
                // An interpreter.begin() still loading is not undone by this: only the hub's
                // "interpreter" event starts or ends it.
                VoiceEvents.emit("reply_done", "intent" to response?.intent, "ms" to elapsed,
                    "hold_ms" to (response?.hold_ms ?: 0L), "camera" to (response?.camera == true),
                    "text" to response?.response_text)

                // #462: ambient verdict — no TTS, no fallback.
                if (response?.intent == "ambient") {
                    panLog("Ambient (${elapsed}ms): no-op")
                    // The line STAYS in the history. A person in the room remembers what was
                    // said near them, and "what did I say the dog is called" needs it. Dropping
                    // it also dropped every statement the hub misjudged as room talk, which is
                    // how recall went to 0% (voicebench, 2026-11-02).
                    return@launch
                }

                // The hub judged this needs a look ("does this look ripe") without one of the
                // fixed camera phrases: same photo path as "what is this".
                if (response?.camera == true) {
                    panLog("Camera from hub (${elapsed}ms): $text")
                    handleCameraCommand(text)
                    return@launch
                }

                // Held reply: the hub was unsure this was aimed at us, so nothing
                // streamed. Wait the beat out. If he says anything in the meantime
                // the next query cancels this, and he never hears it.
                val hold = response?.hold_ms ?: 0L
                if (hold > 0L) {
                    val text = response?.response_text?.trim().orEmpty()
                    if (text.isNotBlank() && text != "[AMBIENT]") {
                        panLog("Held ${hold}ms (addressed=${response?.addressed}): ${text.take(50)}")
                        val r = Runnable {
                            pendingHold = null
                            // Still talking when the wait ran out: he carried on, so it stays unsaid.
                            if (!isMuted && replySeq.get() == mySeq && !heIsTalking()) panSpeak(text)
                        }
                        pendingHold = r
                        mainHandler.postDelayed(r, hold)
                    }
                    return@launch
                }

                // Speak any remaining text in the buffer (incomplete sentence or no punct)
                val remaining = sentenceBuf.toString().trim()
                if (remaining.isNotBlank() && remaining != "[AMBIENT]") {
                    speakReply(mySeq, remaining)
                } else if (firstChunkTime == 0L && response?.intent != "ambient") {
                    // NOTHING streamed. The hub still puts an answer in the done
                    // event's `response` field - the unparseable-output fallback
                    // lives there - and we were reading only `intent` off it, so
                    // the reply was received and thrown away. Silence on the
                    // phone is the worst possible outcome; say what it sent.
                    val fromDone = response?.response_text?.trim().orEmpty()
                    if (fromDone.isNotBlank() && fromDone != "[AMBIENT]") {
                        panLog("No chunks streamed — speaking the done-event reply")
                        speakReply(mySeq, fromDone)
                    }
                }

                val firstWordMs = if (firstChunkTime > 0L) firstChunkTime - startTime else elapsed
                panLog("Stream (first=${firstWordMs}ms total=${elapsed}ms): ${remaining.take(60)}")

                if (response != null) {
                    val responseText = response.response_text.ifBlank { remaining }

                    // Dispatch phone-targeted actions (music, navigate, etc.)
                    val hasPhoneAction = !response.actions.isNullOrEmpty() ||
                        response.route == "music" || response.route == "play_music" ||
                        responseText.startsWith("Playing ")
                    if (hasPhoneAction) {
                        val legacyQuery = if (response.actions.isNullOrEmpty() && responseText.startsWith("Playing "))
                            responseText.removePrefix("Playing ").removeSuffix(".")
                        else response.query
                        dispatchActions(response.actions, response.route, legacyQuery, text)
                        feedbackSounds.onCommandSent()
                    }

                    if (responseText != "[AMBIENT]") {
                        // No "(1234ms)" suffix: the model reads this history, and its
                        // training data has none.
                        addToHistory("PAN", responseText)
                        lastWarmAt = 0L
                        mainHandler.post { warmHub() }
                        persistHistoryTurn("assistant", responseText)
                        dataRepository.addPanResponse(responseText)
                        // Surface to native PanThinkingCard — shows the reply text +
                        // ↳ X.Xs response-time badge, beside what the hub heard.
                        lastQueryText.value = heardText
                        lastResponseText.value = responseText
                        lastFirstChunkMs.value = firstWordMs
                    }
                } else if (remaining.isBlank()) {
                    panLog("Stream returned null/empty")
                    // Once a minute, then a short tone. With the tunnel down every turn fails in
                    // milliseconds, and during an internet outage he heard "Server didn't
                    // respond." twelve times in a row (2026-11-02).
                    val now = System.currentTimeMillis()
                    if (now - lastNoReplySpokenAt > NO_REPLY_REPEAT_MS) {
                        lastNoReplySpokenAt = now
                        mainHandler.post { panSpeak("Server didn't respond.") }
                    } else {
                        feedbackSounds.onCommandFailed()
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                // We cancelled this ourselves because he said something new, or
                // because he muted. Saying "I can't reach the server" here is a
                // lie, and it is the message he heard PAN announce repeatedly
                // while it was supposedly muted. Cancellation must stay silent,
                // and must be rethrown so the coroutine actually unwinds.
                sttEngine.queryPending = false
                throw e
            } catch (e: Exception) {
                sttEngine.queryPending = false
                panLog("Server unreachable: ${e.message}")
                mainHandler.post { panSpeak("I can't reach the server right now. I'm in limited mode without internet.") }
            } finally {
                // Always clear thinking state — even on exception/timeout — so
                // the PanThinkingCard doesn't get stuck spinning.
                currentFiller.value = ""
                isThinking.value = false
            }
            } catch (e: kotlinx.coroutines.CancellationException) {
                // Cancellation is us: he said something new, or he muted. The
                // inner handler rethrows so the coroutine unwinds properly, and
                // THIS is where it landed - which is why muting produced
                // "Something broke. StandaloneCoroutine was cancelled" spoken
                // out loud. Normal control flow, not a fault. Stay quiet.
                panLog("Query cancelled for '$text'")
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
        "what am i looking at", "what am i seeing",
        "take a photo", "take a picture", "take photo", "take picture",
        "what do you see", "what can you see",
        "what's in front of me", "what is in front of me",
        "describe what you see",
        "what's around me", "what is around me",
        "snap a photo", "snap a picture"
    )

    // "What is that" means look only when nothing else follows it. "What is that movie
    // called, the one with the..." is him reaching for a name, and answering it with "the
    // camera is turned off" took the turn from the hub's word search (2026-11-03).
    private val deicticCamera = Regex("\\b(what is|what's|look at|identify|describe|capture) (this|that)\\b(.*)$")
    private val cameraTail = Regex("^\\s*((thing|things|one|here|there|right|over|called|pan|please|for me|real quick|now)\\b[\\s,.?!]*)*$")

    private fun isCameraCommand(text: String): Boolean {
        val lower = text.lowercase().trim()
        if (cameraPatterns.any { lower.contains(it) }) return true
        val m = deicticCamera.find(lower) ?: return false
        return cameraTail.matches(m.groupValues[3])
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

                // Immediate acknowledgment — vision can take 10-15s, so without
                // this the user thinks the camera command was ignored. Picks one
                // of a small set so repeated camera questions don't feel canned.
                // Also surfaces to the PanThinkingCard via lastQueryText/isThinking.
                isThinking.value = true
                lastQueryText.value = "[camera] $question"
                val camAck = listOf(
                    "Let me have a look.",
                    "One sec, looking at that.",
                    "Taking a look now.",
                    "Hold on, checking the camera."
                ).random()
                currentFiller.value = camAck
                mainHandler.post { panSpeak(camAck) }

                // Take photo
                panLog("Taking photo...")
                val photoBytes = cameraCapture.takePhoto()
                panLog("Photo captured: ${photoBytes.size} bytes")

                // Hub FIRST: its local model answers the actual question. On-device
                // Gemini Nano is caption-only (it ignores the question) and often
                // fails its own policy check after ~3 s, which every photo then waited
                // through. So Nano is only the fallback for when the hub can't answer.
                val base64 = android.util.Base64.encodeToString(photoBytes, android.util.Base64.NO_WRAP)
                panLog("Base64 encoded: ${base64.length} chars")
                var description: String? = serverClient.analyzeImage(base64, question)
                var analyzedOnDevice = false

                if (description.isNullOrBlank()) {
                    description = null
                    try {
                        val bitmap = android.graphics.BitmapFactory.decodeByteArray(photoBytes, 0, photoBytes.size)
                        if (bitmap != null) {
                            val nano = nanoVision.describe(bitmap, question)
                            if (!nano.isNullOrBlank()) {
                                description = nano
                                analyzedOnDevice = true
                                panLog("Image analyzed on-device (Nano): ${nano.take(100)}")
                            }
                        }
                    } catch (e: Exception) {
                        panLog("Nano vision failed: ${e.message}")
                    }
                }

                // Snapshot into a val so it smart-casts and can be captured by the
                // panSpeak closure (description is a reassigned var above).
                val finalDescription = description

                // Capture pipe — push the actual photo to the server so the IMAGE
                // (not just the spoken description) reaches the desktop: saved as a
                // file the desktop Claude can open + attached to the Π thread.
                // Best-effort, launched non-blocking so it never delays the reply.
                serviceScope.launch {
                    serverClient.uploadCapture(photoBytes, finalDescription, question, analyzedOnDevice)
                }

                if (finalDescription != null && finalDescription.isNotBlank()) {
                    panLog("Vision result: ${finalDescription.take(100)}")
                    addToHistory("User", "[photo] $question")
                    addToHistory("PAN", finalDescription)
                    // Kept on the hub too: after a restart the history is reloaded from there,
                    // and without it "what kind of dog was that?" had nothing (2026-11-03).
                    persistHistoryTurn("assistant", finalDescription)
                    dataRepository.addPanResponse(finalDescription)
                    // Surface to PanThinkingCard before speaking.
                    lastResponseText.value = finalDescription
                    currentFiller.value = ""
                    mainHandler.post { panSpeak(finalDescription) }
                } else {
                    panLog("Vision analysis failed — no response")
                    mainHandler.post { panSpeak("I took a photo but couldn't analyze it. The server might be offline.") }
                }
            } catch (e: Exception) {
                panLog("Camera command failed: ${e.message}")
                mainHandler.post { panSpeak("I had trouble with the camera. ${e.message ?: ""}") }
            } finally {
                // Always clear thinking state — camera path used the same UI
                // surface as the askPan flow.
                isThinking.value = false
                currentFiller.value = ""
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

        // No time or date shortcuts: the hub puts the date and time in every prompt, so the
        // model answers "what time is it in Tokyo" too. The shortcut answered that with the
        // local time and never asked the hub.

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
            if (lower.contains("battery")) {
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
        // -- Test harness (debug builds only) ---------------------------------
        //
        // Nothing outside the app could make PAN speak or feed it an utterance,
        // so every change to the voice loop needed a human talking to the phone
        // to verify. These two actions close that gap and make the loop testable
        // end to end from a script:
        //
        //   TEST_SPEAK -> the TTS/audio path only (synthesis, routing, playback)
        //   TEST_SAY   -> the FULL loop, exactly as if STT had heard it:
        //                 intent routing, hub round trip, reply, then speech
        //
        //   adb shell am startservice -n dev.pan.app/.service.PanForegroundService \
        //     -a TEST_SAY --es text "what is the capital of peru"
        //
        // DEBUG-gated: a release build cannot be driven this way.
        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "TEST_SPEAK") {
            val t = intent.getStringExtra("text") ?: "This is a test of the PAN voice system."
            panLog("TEST_SPEAK: $t")
            mainHandler.post { panSpeak(t) }
        }

        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "TEST_SAY") {
            val t = intent.getStringExtra("text") ?: "hello"
            // Clear the dedup window and the post-TTS echo cooldown first. Both
            // silently DROP the utterance, so without this a scripted back-and-forth
            // just looks like a hang and you debug the wrong thing.
            lastProcessedText = ""
            lastProcessedTime = 0L
            lastTtsDoneTime = 0L
            panLog("TEST_SAY: $t")
            mainHandler.post { onSpeech(t) }
        }

        // TEST_AUDIO -> recorded SPEECH in place of the microphone (TestAudio.kt).
        //               TEST_SAY skips the VAD, recogniser, Smart Turn, echo filter
        //               and barge-in, which is where most of the complaints live;
        //               this runs all of them. The conversation benchmark
        //               (service/src/evals/voicebench) drives it and reads the
        //               PANEVT log lines (VoiceEvents.kt).
        //
        //   adb push q1.wav /sdcard/Android/data/dev.pan.app/files/voicebench/
        //   adb shell am startservice -n dev.pan.app/.service.PanForegroundService \
        //     -a TEST_AUDIO --es file q1.wav
        //
        // TEST_RESET starts a fresh conversation between scenarios. TEST_AUDIO_END
        // gives back the microphone and his real conversation history.
        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "TEST_AUDIO") {
            val name = intent.getStringExtra("file") ?: ""
            try {
                val dir = getExternalFilesDir("voicebench") ?: error("no external files dir")
                val pcm = TestAudio.readWav(java.io.File(dir, name))
                if (!TestAudio.active) beginBench()
                TestAudio.enqueue(name, pcm)
                VoiceEvents.emit("inject_queued", "clip" to name, "samples" to pcm.size,
                    "muted" to isMuted)
            } catch (e: Exception) {
                VoiceEvents.emit("inject_error", "clip" to name, "error" to (e.message ?: "?"))
                panLog("TEST_AUDIO failed: ${e.message}")
            }
        }
        // TEST_LIVE -> a session on his own microphone: whoever talks to the phone is heard as
        //              usual and nothing is kept (history, uploads, bench:true on the hub). For
        //              a live test with a second speaker, e.g. interpreting (voicebench/live.py).
        //              Ends with TEST_AUDIO_END, or after 30 minutes.
        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "TEST_LIVE") {
            if (!TestAudio.active) beginBench()
            TestAudio.beginLive()
            VoiceEvents.emit("live_start", "muted" to isMuted)
            panLog("Live benchmark: his microphone, nothing persisted")
        }
        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "TEST_RESET") {
            mainHandler.post { resetConversationForBench() }
        }
        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "TEST_AUDIO_END") {
            mainHandler.post { endBench() }
        }
        // TEST_TTS: tune the Supertonic voice live, by ear, then TEST_SPEAK a sentence.
        //   adb shell am startservice -n dev.pan.app/.service.PanForegroundService \
        //     -a TEST_TTS --es steps 10 --es speed 1.2 --es silence 0.2
        //   --es voice supertonic3 switches the voice (saved, as from Settings) for an A/B.
        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "TEST_TTS") {
            intent.getStringExtra("voice")?.let { tts.voiceQuality = it }
            intent.getStringExtra("steps")?.toIntOrNull()?.let { tts.piper.supertonicSteps = it }
            intent.getStringExtra("speed")?.toFloatOrNull()?.let { tts.piper.speedOverride = it }
            intent.getStringExtra("silence")?.toFloatOrNull()?.let { tts.piper.silenceScale = it }
            panLog("TTS tuned: steps=${tts.piper.supertonicSteps} speed=${tts.piper.speedOverride} silence=${tts.piper.silenceScale}")
        }
        // TEST_LOUD: one line at a chosen media volume, to compare levels. Plays aloud. Record it
        // with scrcpy --audio-source=mic. "call" is a line outside interpreting.
        //   adb shell am startservice -n dev.pan.app/.service.PanForegroundService \
        //     -a TEST_LOUD --es path media --es vol 25 --es lang zh
        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "TEST_LOUD") {
            val lang = intent.getStringExtra("lang") ?: "zh"
            val text = if (lang == "ja") "すみません、駅までの行き方を教えてください。ありがとうございます、とても助かりました。"
                       else "请问从这里怎么去火车站？好的，非常感谢，祝您有个美好的一天。"
            // --es b64 <base64 line>: say this instead, so a test can vary the words.
            val line = intent.getStringExtra("b64")?.let { String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)) } ?: text
            tts.prepareLanguage(lang)
            val path = intent.getStringExtra("path")
            tts.interpreting = path != "call"
            intent.getStringExtra("vol")?.toIntOrNull()?.let {
                (getSystemService(AUDIO_SERVICE) as AudioManager).setStreamVolume(AudioManager.STREAM_MUSIC, it, 0)
            }
            // --es sid 6: in this voice, as a person in an interpreted talk would get.
            val sid = intent.getStringExtra("sid")?.toIntOrNull()
            mainHandler.postDelayed({ tts.lineVoice = sid; tts.speak(line) }, 900)
        }
        // TEST_PENDANT_MIC: record from the pendant's mic into a WAV and log what the link did. No
        // sound, and PAN stays muted or not as it was. PendantMic logs MIC received= lost=.
        //   adb shell am startservice -n dev.pan.app/.service.PanForegroundService \
        //     -a TEST_PENDANT_MIC --es sec 10 --es gain 4
        // --es live 1: PAN hears the pendant instead of the phone until --es live 0.
        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "TEST_PENDANT_MIC") {
            val mic = dev.pan.app.ble.PendantMic
            // --es cmd x: any firmware command on its own, x stops the camera.
            intent.getStringExtra("cmd")?.let { pendantBle.sendCommand(it); return@let }
            intent.getStringExtra("live")?.let { on ->
                mic.live = on == "1"
                mic.reset()
                pendantBle.sendCommand(if (on == "1") "a" else "z")
            } ?: run {
                val sec = intent.getStringExtra("sec")?.toLongOrNull() ?: 10L
                val gain = intent.getStringExtra("gain")?.toIntOrNull() ?: 4
                mic.startRecording()
                val ok = pendantBle.sendCommand("g${gain}a")
                android.util.Log.i("PendantMic", "START ok=$ok status=${pendantBle.status.value}")
                mainHandler.postDelayed({
                    pendantBle.sendCommand("z")
                    mic.stopRecording(java.io.File(getExternalFilesDir("voicebench"), "pendant_mic.wav"))
                }, sec * 1000L)
            }
        }
        // TEST_PEER: the other person's PAN, over a tunnel to peer_person.py. --es url off stops it.
        //   adb reverse tcp:7795 tcp:7795, then --es url http://127.0.0.1:7795
        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "TEST_PEER") {
            val url = intent.getStringExtra("url")
            if (url == null || url == "off") dev.pan.app.interpret.PeerLink.stop() else dev.pan.app.interpret.PeerLink.start(url)
            // --es lang ja: load the interpreter now. Left to the hub, the phone only learns it is
            // interpreting from the reply to the first line, so that line never reached the other side.
            intent.getStringExtra("lang")?.let { setInterpreter(it) }
        }
        // TEST_TTS_BENCH: clause build times, logged as "BENCH ..." under PiperTTS. No sound.
        //   adb shell am startservice -n dev.pan.app/.service.PanForegroundService \
        //     -a TEST_TTS_BENCH --es threads 2,4 --es steps 3,5 --es provider cpu --es reps 5
        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "TEST_TTS_BENCH") {
            val threads = (intent.getStringExtra("threads") ?: "4").split(",").mapNotNull { it.toIntOrNull() }
            val steps = (intent.getStringExtra("steps") ?: "3").split(",").mapNotNull { it.toIntOrNull() }
            val provider = intent.getStringExtra("provider") ?: "cpu"
            val reps = intent.getStringExtra("reps")?.toIntOrNull() ?: 5
            serviceScope.launch(Dispatchers.Default) { tts.piper.benchSupertonic(threads, steps, provider, reps) }
        }
        // TEST_INTERP_BENCH: what the interpreter could run on this phone (debug/InterpretBench.kt).
        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "TEST_INTERP_BENCH") {
            val what = (intent.getStringExtra("what") ?: "asr").split(",")
            val threads = (intent.getStringExtra("threads") ?: "4").split(",").mapNotNull { it.toIntOrNull() }
            val reps = intent.getStringExtra("reps")?.toIntOrNull() ?: 5
            val clips = (intent.getStringExtra("clips") ?: "").split(",").filter { it.isNotBlank() }
            serviceScope.launch(Dispatchers.Default) {
                dev.pan.app.debug.InterpretBench.run(applicationContext, what, threads, reps, clips)
            }
        }
        // TEST_PING: the hub round trip on the path a voice turn uses (in-app tailnet), N
        // health requests spaced gap_ms apart. A gap longer than the Wi-Fi's idle timeout
        // shows what a reply pays when the radio has gone to sleep between turns.
        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "TEST_PING") {
            // String extras: run.py passes everything with --es.
            val n = intent.getStringExtra("n")?.toIntOrNull() ?: 5
            val gap = intent.getStringExtra("gap_ms")?.toLongOrNull() ?: 1000L
            serviceScope.launch(Dispatchers.IO) {
                repeat(n) { i ->
                    val t0 = android.os.SystemClock.elapsedRealtime()
                    val ok = runCatching { serverClient.api.health().isSuccessful }.getOrDefault(false)
                    VoiceEvents.emit("ping", "i" to i, "gap_ms" to gap, "ok" to ok,
                        "ms" to (android.os.SystemClock.elapsedRealtime() - t0))
                    delay(gap)
                }
            }
        }

        // Swap recogniser without a rebuild, so the two can be compared on the
        // same voice on the same day:
        //
        //   adb shell am startservice -n dev.pan.app/.service.PanForegroundService         //     -a STT_ENGINE --es which sherpa
        //
        // Takes effect on the next service start (the choice is resolved once,
        // deliberately, so it cannot change under a running listen loop).
        if (dev.pan.app.BuildConfig.DEBUG && intent?.action == "STT_ENGINE") {
            val which = intent.getStringExtra("which") ?: "google"
            getSharedPreferences("pan_stt_prefs", MODE_PRIVATE)
                .edit().putString("engine", which).apply()
            panLog("STT engine pref set to '$which' — restart the service to apply")
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

        if (intent?.action == "SLACK_REPLY") {
            val replyText = RemoteInput.getResultsFromIntent(intent)
                ?.getCharSequence(SLACK_REPLY_KEY)?.toString()?.trim()
            val channelId = intent.getStringExtra("channelId")
            val notifId = intent.getIntExtra("notif_id", 0)
            val title = intent.getStringExtra("channel_title") ?: "Slack"
            if (replyText.isNullOrBlank() || channelId.isNullOrBlank()) {
                panLog("Slack reply ignored — empty text or missing channelId")
                notificationManager?.cancel(notifId)
            } else {
                // Immediately reflect the reply in the shade (Android collapses the
                // input box once the PendingIntent fires) and mark it Sending.
                updateSlackStatus(notifId, title, "Sending: $replyText", ongoing = true)
                serviceScope.launch {
                    val ok = try {
                        serverClient.sendSlackReply(channelId, replyText)
                    } catch (e: Exception) {
                        panLog("Slack reply exception: ${e.message}"); false
                    }
                    if (ok) {
                        panLog("Slack reply sent to $channelId: ${replyText.take(60)}")
                        updateSlackStatus(notifId, title, "Sent: $replyText", ongoing = false)
                    } else {
                        panLog("Slack reply FAILED to $channelId")
                        updateSlackStatus(notifId, title, "Failed to send — tap to retry: $replyText", ongoing = false)
                    }
                }
            }
        }

        if (intent?.action == "TOGGLE_MIC") {
            // micEnabled is what the notification and the UI show, so it is the
            // state the user is actually toggling. Deriving this from the
            // engine's private flag is how the two drifted apart.
            val newState = !micEnabled.value
            if (!newState) {
                // Muting stopped the microphone but left PAN talking: it finished
                // its sentence and then announced a server error for a query that
                // was still in flight, eleven seconds after the mic was released.
                // Mute has to mean silence in both directions.
                tts.stop()
                cancelInFlight()
                panLog("Muted — mic released, TTS stopped, query cancelled")
            }
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
        logShipper.stop()
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

        val title = if (listening) "Π Active" else "Π Muted"
        val statusParts = mutableListOf<String>()
        statusParts.add(if (listening) "Listening" else "Silent")
        statusParts.add(if (connected) "Server OK" else "Offline")
        val toggleLabel = if (listening) "Mute All" else "Unmute All"

        val statusLine = statusParts.joinToString(" | ")
        val builder = NotificationCompat.Builder(this, Constants.NOTIFICATION_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(intuitionSummary ?: statusLine)   // collapsed lock-screen line = live intuition
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
        // Expanded view = the full read PAN fused this tick + service status.
        intuitionFull?.let {
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(it + "\n\n· " + statusLine))
        }
        return builder.build()
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
