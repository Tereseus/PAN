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
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontStyle
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
    // Developer options (Settings): the Claude prompts, the seconds waited and the reply
    // breakdown are for building ΠAN, so they show only while it is on (owner, Nov 26).
    val developer by dev.pan.app.ui.settings.rememberDeveloperMode()
    val shownApprovals = if (developer) approvals else emptyList()

    // The app's own secure route starts with the first screen (it used to start from the old main screen).
    LaunchedEffect(Unit) { viewModel.connectTailscale() }

    // Is it the phone's internet, or the computer? Asked every few seconds; cheap.
    var online by remember { mutableStateOf(true) }
    // Never paired with a computer: say that and offer the scanner, not "your computer is not
    // answering" on a phone that has no computer yet. True until the link says otherwise.
    var paired by remember { mutableStateOf(true) }
    var incognito by remember { mutableStateOf(ScopeHolder.scope == "incognito") }
    val interpreting by dev.pan.app.stt.LiveWords.interpreting.collectAsState()
    LaunchedEffect(Unit) {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        while (true) {
            online = runCatching {
                cm?.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
            }.getOrDefault(true)
            incognito = ScopeHolder.scope == "incognito"
            paired = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { runCatching { viewModel.linkPaired() }.getOrDefault(true) }
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
                    !paired -> MaterialTheme.colorScheme.error to "Not paired with a computer yet"
                    !online -> MaterialTheme.colorScheme.error to "No internet on this device"
                    else -> MaterialTheme.colorScheme.error to "Your computer is not answering"
                }
                Box(Modifier.size(9.dp).clip(CircleShape).background(dot))
                Spacer(Modifier.width(8.dp))
                Text(words, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                // Interpreting stays on until he ends it, and every line is then translated, not answered:
                // he forgot it was on and asked ΠAN its name (2026-11-17). Say so where he looks.
                interpreting?.let { lang ->
                    val name = if (lang == "?") "" else runCatching { java.util.Locale(lang).getDisplayLanguage(java.util.Locale.ENGLISH) }.getOrDefault("")
                    // A tap ends it: saying "stop translating" was the only way out, and it did not
                    // always take (2026-11-17).
                    Surface(shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.primary.copy(alpha = 0.18f),
                        modifier = Modifier.padding(end = if (incognito) 6.dp else 0.dp).clip(RoundedCornerShape(10.dp))
                            .clickable { viewModel.stopInterpreting() }) {
                        Text((if (name.isBlank()) "Interpreting" else "Interpreting: $name") + "  \u2715", modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                    }
                }
                if (incognito) {
                    Surface(shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.18f)) {
                        Text("Incognito", modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.tertiary)
                    }
                }
            }
            SituationLine(intuition)
            if (!connected && !paired) {
                Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("Pair this phone with your computer", style = MaterialTheme.typography.titleMedium)
                        Text("On the computer that runs ΠAN, open its Pair a phone page. Then scan the code it shows.",
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(onClick = {
                            context.startActivity(android.content.Intent(context, dev.pan.app.vpn.ScanPairActivity::class.java))
                        }) { Text("Scan the code") }
                    }
                }
            }
        }

        // ---- needs you ---------------------------------------------------
        if (shownApprovals.isNotEmpty() || alerts.isNotEmpty()) {
            Column(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text("Needs you", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(start = 4.dp))
                shownApprovals.take(3).forEach { p ->
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
                    // Blank lines from before 0.5.4 stay in the store; they are not shown.
                    items(talk.filter { it.text.isNotBlank() || it.photo != null }, key = { it.id }) { line -> TalkLine(line, developer) }
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
    // What he is doing, not where: his address sat here all day for no reason (owner, 2026-11-17).
    val line = listOfNotNull(now.activity?.takeIf { it.isNotBlank() }, now.focus?.takeIf { it.isNotBlank() })
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
private fun TalkLine(line: ConversationEntity, developer: Boolean) {
    val context = LocalContext.current
    // Why PAN stayed out of the line above: small, slanted, on his side, no bubble.
    if (line.role == "note") {
        Text(line.text, modifier = Modifier.fillMaxWidth().padding(end = 6.dp, bottom = 2.dp),
            textAlign = TextAlign.End, style = MaterialTheme.typography.labelSmall,
            fontStyle = FontStyle.Italic, color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
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
    val detail = remember(line.detail) { line.detail?.let { runCatching { org.json.JSONObject(it) }.getOrNull() } }
    // Word by word: how each one sounds, how it is written, what it means. For everyone.
    val words = remember(line.detail) { wordByWord(detail) }
    // Where the time went and who answered: Developer options only.
    val breakdown = remember(line.detail, developer) { if (developer && detail != null) replyBreakdown(detail) else emptyList() }
    var open by remember(line.id) { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
        Surface(
            shape = RoundedCornerShape(
                topStart = 18.dp, topEnd = 18.dp,
                bottomStart = if (mine) 18.dp else 4.dp, bottomEnd = if (mine) 4.dp else 18.dp
            ),
            color = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.widthIn(max = 320.dp).clip(RoundedCornerShape(18.dp))
                .clickable(enabled = words.isNotEmpty() || breakdown.isNotEmpty()) { open = !open }
        ) {
            Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp)) {
                line.photo?.let { path -> TalkPhoto(path) }
                Text(line.text, style = MaterialTheme.typography.bodyLarge,
                    color = if (mine) Color.White else MaterialTheme.colorScheme.onSurface)
                // A line in another script: how to say it, in Latin letters, right under it.
                detail?.optString("romaji")?.takeIf { it.isNotBlank() }?.let { romaji ->
                    Text(romaji, style = MaterialTheme.typography.bodyMedium, fontStyle = FontStyle.Italic,
                        modifier = Modifier.padding(top = 3.dp),
                        color = if (mine) Color.White.copy(alpha = 0.85f) else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        // PAN's lines also say how long he waited for the first word (Developer options only).
        // A picture answer shows it to everyone (task 1064): a look takes longer, and the time says why the wait.
        val waited = line.ms?.takeIf { (developer || line.photo != null) && !mine && it > 0 }?.let { " · " + secs(it) }.orEmpty()
        Text(time + waited, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
        if (open && (words.isNotEmpty() || breakdown.isNotEmpty())) {
            Column(modifier = Modifier.widthIn(max = 320.dp).padding(horizontal = 6.dp).padding(bottom = 4.dp)) {
                words.forEach { (sound, written, meaning) ->
                    Row(modifier = Modifier.padding(vertical = 1.dp)) {
                        Text(sound, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.width(96.dp))
                        Text(written, style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.width(72.dp))
                        Text(meaning, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                    }
                }
                if (words.isNotEmpty() && breakdown.isNotEmpty()) Spacer(Modifier.height(4.dp))
                breakdown.forEach {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

private fun secs(ms: Long): String = String.format(java.util.Locale.US, "%.1f s", ms / 1000.0)

/** The words of a line in another script: (how it sounds, how it is written, what it means). */
private fun wordByWord(d: org.json.JSONObject?): List<Triple<String, String, String>> {
    val words = d?.optJSONArray("words") ?: return emptyList()
    return (0 until words.length()).mapNotNull { i ->
        val w = words.optJSONObject(i) ?: return@mapNotNull null
        // A verb also says which word it is a form of: "to do (する, polite)".
        val from = listOf(w.optString("b"), w.optString("f")).filter { it.isNotBlank() }.joinToString(", ")
        val meaning = w.optString("m") + if (from.isNotBlank()) (if (w.optString("m").isBlank()) from else " ($from)") else ""
        Triple(w.optString("r"), w.optString("s"), meaning)
    }
}

/** A tapped reply, in plain lines: how long, where the time went, who answered, what PAN thought was going on. */
private fun replyBreakdown(d: org.json.JSONObject): List<String> {
    fun ms(key: String) = if (d.has(key)) d.optLong(key, -1L).takeIf { it >= 0 } else null
    val out = mutableListOf<String>()
    val first = ms("first_ms"); val done = ms("done_ms")
    if (first != null) out += "First word after " + secs(first) + (done?.let { ", finished after " + secs(it) } ?: "")
    // The hub's own clock. "The model started" is its first token; the first words he can hear come
    // a little later (the model writes who the line is for before it writes the reply).
    val hubFirst = ms("first_chunk_sent_ms")
    val parts = listOfNotNull(
        ms("asr_ms")?.let { "hearing you " + secs(it) },
        ms("first_chunk_ms")?.let { "the model started after " + secs(it) },
        hubFirst?.let { "first words out after " + secs(it) },
    )
    if (parts.isNotEmpty()) out += "On your computer: " + parts.joinToString(", ")
    if (first != null && hubFirst != null && first > hubFirst) out += "On the way to and from this device: " + secs(first - hubFirst)
    val who = if (d.optString("interp", "") == "phone") "Translated on this device" else when (d.optString("path", "")) {
        "" -> if (d.has("model")) "Answered by the voice model" else null
        "world" -> "Answered by the bigger model (a question that needs knowledge)"
        "self" -> "Answered by the bigger model (a question about ΠAN or you)"
        "reread" -> "Answered by the bigger model (it read the talk again)"
        "tool" -> "Answered by the bigger model (from live data)"
        "kind" -> "Answered by the bigger model"
        "think" -> "Answered by the bigger model (handed up by the voice model)"
        "search" -> "The bigger model, helping find a word"
        "translate" -> "Translation"
        else -> "Answered by the bigger model"
    }
    who?.let { out += it }
    d.optString("read", "").takeIf { it.isNotBlank() }?.let { out += "ΠAN's read then: $it" }
    return out
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
    // Tapped: the whole picture, as big as the screen allows (task 1063). Tap again or Back closes it.
    var full by remember(path) { mutableStateOf(false) }
    bitmap?.let {
        Image(
            bitmap = it.asImageBitmap(), contentDescription = "Picture ΠAN took. Tap to see it full size",
            contentScale = ContentScale.Crop,
            modifier = Modifier.padding(bottom = 8.dp).fillMaxWidth().heightIn(max = 190.dp).clip(RoundedCornerShape(12.dp))
                .clickable { full = true }
        )
    }
    if (full) {
        var big by remember(path) { mutableStateOf<android.graphics.Bitmap?>(null) }
        LaunchedEffect(path) {
            big = withContext(Dispatchers.IO) {
                runCatching { BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = 2 }) }.getOrNull()
            }
        }
        androidx.compose.ui.window.Dialog(
            onDismissRequest = { full = false },
            properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Box(
                modifier = Modifier.fillMaxSize().background(Color.Black).clickable { full = false },
                contentAlignment = Alignment.Center,
            ) {
                (big ?: bitmap)?.let { b ->
                    Image(bitmap = b.asImageBitmap(), contentDescription = "Picture ΠAN took, full size",
                        contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
                }
            }
        }
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
        val listenMode by dev.pan.app.audio.ListenMode.mode.collectAsState()
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
                // No X here (the owner, 2026-11-18): beside the send arrow it could wipe what was
                // typed by accident. Back leaves typing when nothing is typed.
                androidx.activity.compose.BackHandler(enabled = typed.isBlank()) { typing = false; focusManager.clearFocus() }
                IconButton(onClick = { send() }, enabled = typed.isNotBlank(), modifier = Modifier.size(36.dp)) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send",
                        tint = if (typed.isNotBlank()) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                Text(
                    when {
                        hearing -> liveWords
                        micOn && listenMode == dev.pan.app.audio.ListenMode.Mode.LISTEN -> "Listening only. ΠAN keeps quiet until you say it can talk"
                        micOn && listenMode == dev.pan.app.audio.ListenMode.Mode.NAME -> "Name only. ΠAN answers when you start with its name"
                        micOn && listenMode == dev.pan.app.audio.ListenMode.Mode.FORGET -> "Don't remember. Nothing from now on is kept"
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

/**
 * The mic button, the same one on Home and inside a conversation in People. Its picture is the
 * listening mode (audio/ListenMode.kt, pictures in ModeIcons.kt): a microphone (Normal), an ear
 * (Listen only), Π (Name only), a hat with glasses (Don't remember), a crossed microphone (Mute).
 * A tap mutes and unmutes as before; holding it opens the chooser.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
internal fun MicButton(on: Boolean, onClick: () -> Unit, diameter: androidx.compose.ui.unit.Dp = 56.dp) {
    val mode by dev.pan.app.audio.ListenMode.mode.collectAsState()
    val ctx = LocalContext.current
    var choosing by remember { mutableStateOf(false) }
    val fill = if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant
    val ink = if (on) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
    val label = if (!on) "Muted" else mode.label
    Box {
        Box(
            modifier = Modifier
                .size(diameter)
                .clip(CircleShape)
                .background(fill)
                .combinedClickable(
                    onClickLabel = if (on) "Mute" else "Unmute",
                    onLongClickLabel = "Choose how ΠAN listens",
                    onClick = onClick,
                    onLongClick = { choosing = true }
                )
                .semantics { contentDescription = "Microphone: $label" },
            contentAlignment = Alignment.Center
        ) {
            val pic = if (!on) ModeIcons.MicOff else ModeIcons.of(mode)
            Icon(pic, contentDescription = null, tint = ink, modifier = Modifier.size(diameter * 0.5f))
        }
        DropdownMenu(expanded = choosing, onDismissRequest = { choosing = false }) {
            val svc = dev.pan.app.service.PanForegroundService::class.java
            for (m in dev.pan.app.audio.ListenMode.Mode.values()) {
                DropdownMenuItem(
                    leadingIcon = { Icon(ModeIcons.of(m), contentDescription = null, modifier = Modifier.size(22.dp)) },
                    text = { Text(m.label + if (on && m == mode) "  ✓" else "") },
                    onClick = {
                        choosing = false
                        ctx.startService(android.content.Intent(ctx, svc)
                            .setAction(dev.pan.app.service.PanForegroundService.ACTION_SET_MODE).putExtra("mode", m.wire))
                    }
                )
            }
            DropdownMenuItem(
                leadingIcon = { Icon(ModeIcons.MicOff, contentDescription = null, modifier = Modifier.size(22.dp)) },
                text = { Text("Mute" + if (!on) "  ✓" else "") },
                onClick = {
                    choosing = false
                    ctx.startService(android.content.Intent(ctx, svc).setAction("TOGGLE_MIC").putExtra("on", false))
                }
            )
        }
    }
}
