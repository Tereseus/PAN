package dev.pan.app.ui.home

import android.graphics.BitmapFactory
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.pan.app.data.entity.ConversationEntity
import dev.pan.app.di.ScopeHolder
import dev.pan.app.network.dto.IntuitionSnapshot
import dev.pan.app.ui.main.MainViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * Home (0.5.1, docs/MOBILE-APP-PLAN.md): the talk, the mic, and one line each for the connection
 * and for what PAN thinks is going on. Nothing here is a tool for building PAN; those sit behind
 * the developer switch in Settings.
 *
 *   top      Π, the connection in plain words, an incognito badge while it is on
 *            what PAN thinks is going on (tap for the rest)
 *            "Needs you": allow or deny, open alerts
 *   middle   the talk: his lines on the right, PAN's on the left, a picture where PAN took one
 *   bottom   the box that fills with his words as he speaks (tap it to type), and the mic
 */
@Composable
fun HomeScreen(viewModel: MainViewModel) {
    val context = LocalContext.current
    val connected by viewModel.isServerConnected.collectAsState()
    val micOn by viewModel.isMicEnabled.collectAsState()
    val thinking by viewModel.isThinking.collectAsState()
    val intuition by viewModel.intuition.collectAsState()
    val talk by viewModel.talk.collectAsState()
    val live by viewModel.liveWords.collectAsState()
    val approvals by viewModel.approvals.collectAsState()
    val alerts by viewModel.alerts.collectAsState()

    // The app's own secure route starts with the first screen (it used to start from the old main screen).
    LaunchedEffect(Unit) { viewModel.connectTailscale() }

    // Is it the phone's internet, or the computer? Asked every few seconds; cheap.
    var online by remember { mutableStateOf(true) }
    var incognito by remember { mutableStateOf(ScopeHolder.scope == "incognito") }
    LaunchedEffect(Unit) {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        while (true) {
            online = runCatching {
                cm?.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
            }.getOrDefault(true)
            incognito = ScopeHolder.scope == "incognito"
            delay(3_000)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .imePadding()
    ) {
        // ---- top ---------------------------------------------------------
        Column(modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Π", fontSize = 30.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(12.dp))
                val (dot, words) = when {
                    connected -> MaterialTheme.colorScheme.secondary to "Connected"
                    !online -> MaterialTheme.colorScheme.error to "No internet on this device"
                    else -> MaterialTheme.colorScheme.error to "Your computer is not answering"
                }
                Box(Modifier.size(9.dp).clip(CircleShape).background(dot))
                Spacer(Modifier.width(8.dp))
                Text(words, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (incognito) {
                    Surface(shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.18f)) {
                        Text("Incognito", modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.tertiary)
                    }
                }
            }
            SituationLine(intuition)
        }

        // ---- needs you ---------------------------------------------------
        if (approvals.isNotEmpty() || alerts.isNotEmpty()) {
            Column(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text("Needs you", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(start = 4.dp))
                approvals.take(3).forEach { p ->
                    NeedsYouCard(
                        title = "Claude is asking" + (p.project?.takeIf { it.isNotBlank() }?.let { " in $it" } ?: ""),
                        body = p.prompt,
                        yes = "Allow", no = "Deny",
                        onYes = { viewModel.answerApproval(p.id, true) },
                        onNo = { viewModel.answerApproval(p.id, false) }
                    )
                }
                alerts.take(2).forEach { a ->
                    NeedsYouCard(
                        title = a.title, body = a.detail.orEmpty(),
                        yes = null, no = "Dismiss",
                        onYes = {}, onNo = { viewModel.dismissAlert(a.id) }
                    )
                }
            }
        }

        // ---- the talk ----------------------------------------------------
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            if (talk.isEmpty() && !thinking) {
                Column(
                    modifier = Modifier.align(Alignment.Center).padding(32.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(if (micOn) "ΠAN is listening." else "ΠAN is muted.",
                        style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(6.dp))
                    Text(if (micOn) "Just talk. What you say and what ΠAN answers shows up here."
                         else "Tap the mic to talk, or tap the box to type.",
                        style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                // Follow the talk: a new line arrives at the bottom, and the list goes there unless he
                // has scrolled up to read (0.5.1 stayed where it was, so the answer came in off screen).
                val listState = rememberLazyListState()
                LaunchedEffect(talk.firstOrNull()?.id, thinking) {
                    if (listState.firstVisibleItemIndex <= 4) listState.animateScrollToItem(0)
                }
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    state = listState,
                    reverseLayout = true,
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    if (thinking) item(key = "thinking") { ThinkingBubble() }
                    items(talk, key = { it.id }) { line -> TalkLine(line) }
                }
            }
        }

        // ---- the box and the mic ----------------------------------------
        LineBox(
            live = live,
            micOn = micOn,
            onSend = { viewModel.sendTyped(it) },
            onMic = { viewModel.toggleMic() }
        )
    }
}

/** One plain line for what PAN thinks is going on. Tap it for who is here, the mood and the topics. */
@Composable
private fun SituationLine(snapshot: IntuitionSnapshot?) {
    val now = snapshot?.now ?: return
    val line = listOfNotNull(now.activity?.takeIf { it.isNotBlank() }, now.where?.takeIf { it.isNotBlank() })
        .joinToString(", ")
    if (line.isBlank()) return
    var open by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 6.dp)
            .clip(RoundedCornerShape(10.dp))
            .clickable { open = !open }
            .animateContentSize()
            .padding(vertical = 4.dp)
    ) {
        Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = if (open) 3 else 1, overflow = TextOverflow.Ellipsis)
        if (open) {
            val who = now.social?.filter { it.isNotBlank() }.orEmpty()
            val more = listOfNotNull(
                if (who.isNotEmpty()) "With: " + who.joinToString(", ") else null,
                now.focus?.takeIf { it.isNotBlank() }?.let { "Doing: $it" },
                now.mood?.takeIf { it.isNotBlank() }?.let { "Mood: $it" },
                now.recent_topics?.takeIf { it.isNotEmpty() }?.let { "Lately: " + it.take(4).joinToString(", ") },
            )
            more.forEach {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun NeedsYouCard(title: String, body: String, yes: String?, no: String, onYes: () -> Unit, onNo: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.35f),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (body.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 4, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (yes != null) Button(onClick = onYes) { Text(yes) }
                OutlinedButton(onClick = onNo) { Text(no) }
            }
        }
    }
}

@Composable
private fun TalkLine(line: ConversationEntity) {
    val context = LocalContext.current
    val mine = line.role == "user"
    // The app's own notes ("[PAN muted]") are not something anyone said: small, in the middle.
    if (!mine && line.text.startsWith("[") && line.text.endsWith("]")) {
        Text(line.text.trim('[', ']'), modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
            textAlign = TextAlign.Center, style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    // The time, with the day in front when the line is not from today.
    val time = remember(line.timestamp) {
        val at = java.util.Date(line.timestamp)
        val clock = android.text.format.DateFormat.getTimeFormat(context).format(at)
        if (android.text.format.DateUtils.isToday(line.timestamp)) clock
        else android.text.format.DateFormat.format("EEE, MMM d", at).toString() + ", " + clock
    }
    Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
        Surface(
            shape = RoundedCornerShape(
                topStart = 18.dp, topEnd = 18.dp,
                bottomStart = if (mine) 18.dp else 4.dp, bottomEnd = if (mine) 4.dp else 18.dp
            ),
            color = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.widthIn(max = 320.dp)
        ) {
            Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp)) {
                line.photo?.let { path -> TalkPhoto(path) }
                Text(line.text, style = MaterialTheme.typography.bodyLarge,
                    color = if (mine) Color.White else MaterialTheme.colorScheme.onSurface)
            }
        }
        Text(time, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
    }
}

/** A picture PAN took, from the phone's own copy. Read small, off the main thread. */
@Composable
private fun TalkPhoto(path: String) {
    var bitmap by remember(path) { mutableStateOf<android.graphics.Bitmap?>(null) }
    LaunchedEffect(path) {
        bitmap = withContext(Dispatchers.IO) {
            runCatching { BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = 4 }) }.getOrNull()
        }
    }
    bitmap?.let {
        Image(
            bitmap = it.asImageBitmap(), contentDescription = "Picture ΠAN took",
            contentScale = ContentScale.Crop,
            modifier = Modifier.padding(bottom = 8.dp).fillMaxWidth().heightIn(max = 190.dp).clip(RoundedCornerShape(12.dp))
        )
    }
}

@Composable
private fun ThinkingBubble() {
    Row(modifier = Modifier.fillMaxWidth()) {
        Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
            Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(10.dp))
                Text("Thinking", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/**
 * The box at the bottom. While he talks it shows his words as the phone hears them; the line goes
 * when he stops, as it always did. Tapped, it turns into a text field: what is in it stays, he fixes
 * a word or types a new line, and Send puts it down the same path as a spoken one.
 */
@Composable
private fun LineBox(live: String, micOn: Boolean, onSend: (String) -> Unit, onMic: () -> Unit) {
    var typing by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val send = {
        if (typed.isNotBlank()) onSend(typed)
        typed = ""
        typing = false
        focusManager.clearFocus()
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        val shape = RoundedCornerShape(26.dp)
        val hearing = live.isNotBlank() && !typing
        // The phone's quick first guess comes in capitals. Shown as a sentence; the line in the talk
        // above is replaced by what the hub heard once it has listened to the sound.
        val liveWords = live.lowercase().replaceFirstChar { it.uppercase() }
        Row(
            modifier = Modifier
                .weight(1f)
                .heightIn(min = 52.dp)
                .clip(shape)
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .border(
                    1.dp,
                    if (hearing || typing) MaterialTheme.colorScheme.primary else Color.Transparent,
                    shape
                )
                .clickable(enabled = !typing) {
                    typed = liveWords
                    typing = true
                }
                .padding(horizontal = 18.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (typing) {
                LaunchedEffect(Unit) { focus.requestFocus() }
                BasicTextField(
                    value = typed,
                    onValueChange = { typed = it },
                    modifier = Modifier.weight(1f).focusRequester(focus),
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    maxLines = 4,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { send() }),
                    decorationBox = { inner ->
                        if (typed.isEmpty()) {
                            Text("Type to ΠAN", style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        inner()
                    }
                )
                IconButton(onClick = { typed = ""; typing = false; focusManager.clearFocus() }, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Default.Close, contentDescription = "Cancel", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = { send() }, enabled = typed.isNotBlank(), modifier = Modifier.size(36.dp)) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send",
                        tint = if (typed.isNotBlank()) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                Text(
                    when {
                        hearing -> liveWords
                        micOn -> "Listening. Your words show here as you talk"
                        else -> "Muted. Tap here to type"
                    },
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (hearing) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 3, overflow = TextOverflow.Ellipsis
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        MicButton(on = micOn, onClick = onMic)
    }
}

@Composable
private fun MicButton(on: Boolean, onClick: () -> Unit) {
    val fill = if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant
    val ink = if (on) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
    Box(
        modifier = Modifier
            .size(56.dp)
            .clip(CircleShape)
            .background(fill)
            .clickable(onClickLabel = if (on) "Mute" else "Unmute", onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Canvas(modifier = Modifier.size(26.dp)) {
            val w = size.width
            val h = size.height
            val stroke = w * 0.09f
            drawRoundRect(ink, topLeft = Offset(w * 0.36f, h * 0.06f), size = Size(w * 0.28f, h * 0.52f),
                cornerRadius = CornerRadius(w * 0.14f))
            drawArc(ink, startAngle = 0f, sweepAngle = 180f, useCenter = false,
                topLeft = Offset(w * 0.22f, h * 0.20f), size = Size(w * 0.56f, h * 0.52f),
                style = Stroke(stroke, cap = StrokeCap.Round))
            drawLine(ink, Offset(w * 0.5f, h * 0.72f), Offset(w * 0.5f, h * 0.92f), stroke, StrokeCap.Round)
            drawLine(ink, Offset(w * 0.34f, h * 0.92f), Offset(w * 0.66f, h * 0.92f), stroke, StrokeCap.Round)
            if (!on) drawLine(ink, Offset(w * 0.10f, h * 0.08f), Offset(w * 0.90f, h * 0.94f), stroke * 1.2f, StrokeCap.Round)
        }
    }
}
