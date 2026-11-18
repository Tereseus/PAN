package dev.pan.app.ui.memory

import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.pan.app.network.dto.MemoryItem
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * Memory (0.5.1, docs/MOBILE-APP-PLAN.md): everything PAN kept, found the way a person asks for it.
 * A word in the search box, or a day from the calendar. Delete one thing, everything a search found,
 * or a whole day.
 *
 * Behind the fingerprint. It locks again every time the tab is left or the app goes to the
 * background, and deleting asks for the fingerprint again. Nothing is shown, or even fetched,
 * until the lock opens.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MemoryScreen(viewModel: MemoryViewModel = hiltViewModel()) {
    val context = LocalContext.current
    val lockOn = remember { Fingerprint.lockOn(context) }
    val canCheck = remember { Fingerprint.ready(context) }
    var unlocked by remember { mutableStateOf(!lockOn) }

    val ask = { Fingerprint.ask(context, "Open Memory", "Your fingerprint opens what ΠAN has kept") { ok -> if (ok) unlocked = true } }

    // Lock again when the tab is left, and when the app goes to the background.
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP && lockOn) { unlocked = false; viewModel.hide() }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer); viewModel.hide() }
    }
    LaunchedEffect(Unit) { if (!unlocked) ask() }
    LaunchedEffect(unlocked) { if (unlocked) viewModel.load() }

    Column(modifier = Modifier.fillMaxSize().statusBarsPadding()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("Memory", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f))
            if (unlocked && lockOn) {
                IconButton(onClick = { unlocked = false; viewModel.hide() }) {
                    Icon(Icons.Default.Lock, contentDescription = "Lock Memory")
                }
            }
        }
        if (!unlocked) LockedPane(canCheck = canCheck, onUnlock = ask)
        else OpenMemory(viewModel, lockOn = lockOn)
    }
}

@Composable
private fun LockedPane(canCheck: Boolean, onUnlock: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(36.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(Icons.Default.Lock, contentDescription = null, modifier = Modifier.size(52.dp),
            tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(18.dp))
        Text("Memory is locked", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))
        if (canCheck) {
            Text("Only your fingerprint opens what ΠAN has kept.",
                style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(22.dp))
            Button(onClick = onUnlock) { Text("Unlock with fingerprint") }
        } else {
            // No fingerprint on this device: a PIN set in ΠAN opens it.
            val context = LocalContext.current
            val hasPin = remember { Pin.isSet(context) }
            Text(if (hasPin) "This device has no fingerprint, so your PIN opens what ΠAN has kept."
                 else "This device has no fingerprint. Set a PIN to open what ΠAN has kept here.",
                style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(22.dp))
            Button(onClick = onUnlock) { Text(if (hasPin) "Unlock with PIN" else "Set a PIN") }
        }
    }
}

private sealed interface Forget {
    data class One(val item: MemoryItem) : Forget
    data object Search : Forget
    data object Day : Forget
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OpenMemory(viewModel: MemoryViewModel, lockOn: Boolean) {
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val day by viewModel.day.collectAsState()
    val query by viewModel.query.collectAsState()
    val items by viewModel.items.collectAsState()
    val total by viewModel.total.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val message by viewModel.message.collectAsState()

    var searching by remember { mutableStateOf(false) }   // the list shows a search, not a day
    var pickDay by remember { mutableStateOf(false) }
    var forget by remember { mutableStateOf<Forget?>(null) }
    val today = LocalDate.now()

    LaunchedEffect(message) { if (message != null) { delay(3_500); viewModel.clearMessage() } }

    Column(modifier = Modifier.fillMaxSize()) {
        // ---- search ------------------------------------------------------
        OutlinedTextField(
            value = query,
            onValueChange = { viewModel.setQuery(it) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            placeholder = { Text("Search a word or a name") },
            singleLine = true,
            shape = RoundedCornerShape(26.dp),
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
            trailingIcon = {
                if (query.isNotEmpty() || searching) {
                    IconButton(onClick = { searching = false; viewModel.clearSearch(); focusManager.clearFocus() }) {
                        Icon(Icons.Default.Close, contentDescription = "Clear search")
                    }
                }
            },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = {
                if (query.isNotBlank()) { searching = true; viewModel.search(); focusManager.clearFocus() }
            })
        )

        // ---- the day -----------------------------------------------------
        if (!searching) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(onClick = { viewModel.setDay(day.minusDays(1)) }) {
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "The day before")
                }
                Row(
                    modifier = Modifier.weight(1f).clip(RoundedCornerShape(12.dp)).clickable { pickDay = true }.padding(vertical = 10.dp),
                    horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(Icons.Default.DateRange, contentDescription = null, modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(8.dp))
                    Text(dayWords(day, today), style = MaterialTheme.typography.titleMedium)
                }
                IconButton(onClick = { viewModel.setDay(day.plusDays(1)) }, enabled = day.isBefore(today)) {
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "The day after")
                }
            }
        }

        // ---- what was kept ----------------------------------------------
        val summary = when {
            loading -> "Looking"
            searching && total > items.size -> "$total found. Showing the newest ${items.size}"
            searching -> if (items.isEmpty()) "Nothing found" else "${items.size} found"
            items.isEmpty() -> "Nothing kept on this day"
            else -> "${items.size} kept"
        }
        Text(summary, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 22.dp, vertical = 4.dp))

        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(items, key = { it.id }) { item ->
                MemoryCard(item, showDate = searching, viewModel = viewModel, onDelete = { forget = Forget.One(item) })
            }
        }

        message?.let {
            Surface(color = MaterialTheme.colorScheme.inverseSurface, shape = RoundedCornerShape(12.dp),
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp).fillMaxWidth()) {
                Text(it, color = MaterialTheme.colorScheme.inverseOnSurface, style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
            }
        }

        if (items.isNotEmpty()) {
            OutlinedButton(
                onClick = { forget = if (searching) Forget.Search else Forget.Day },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)
            ) {
                Text(if (searching) "Delete everything found" else "Delete this day")
            }
        }
    }

    if (pickDay) {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long) = utcTimeMillis <= System.currentTimeMillis() + 86_400_000L
            }
        )
        DatePickerDialog(
            onDismissRequest = { pickDay = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let {
                        val picked = Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()
                        viewModel.setDay(if (picked.isAfter(today)) today else picked)
                    }
                    pickDay = false
                }) { Text("Open") }
            },
            dismissButton = { TextButton(onClick = { pickDay = false }) { Text("Cancel") } }
        ) { DatePicker(state = state) }
    }

    forget?.let { what ->
        val (title, body) = when (what) {
            is Forget.One -> "Delete this?" to "ΠAN forgets it. This cannot be undone."
            Forget.Search -> "Delete everything found?" to
                "ΠAN forgets all $total things found for \"${query.trim()}\". This cannot be undone."
            Forget.Day -> "Delete this day?" to
                "ΠAN forgets everything it kept on ${dayWords(day, today).lowercase()}. This cannot be undone."
        }
        AlertDialog(
            onDismissRequest = { forget = null },
            title = { Text(title) },
            text = { Text(body) },
            confirmButton = {
                TextButton(onClick = {
                    forget = null
                    val run = {
                        when (what) {
                            is Forget.One -> viewModel.forgetOne(what.item)
                            Forget.Search -> { searching = false; viewModel.forgetSearch() }
                            Forget.Day -> viewModel.forgetDay()
                        }
                    }
                    // Deleting asks for the fingerprint again.
                    if (lockOn) Fingerprint.ask(context, "Delete from Memory", "Your fingerprint confirms it") { ok -> if (ok) run() }
                    else run()
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { forget = null }) { Text("Keep") } }
        )
    }
}

@Composable
private fun MemoryCard(item: MemoryItem, showDate: Boolean, viewModel: MemoryViewModel, onDelete: () -> Unit) {
    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Row(modifier = Modifier.padding(start = 14.dp, top = 10.dp, bottom = 10.dp, end = 2.dp)) {
            Column(modifier = Modifier.weight(1f)) {
                Text(timeWords(item, showDate), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary)
                item.photo?.let { path ->
                    var bitmap by remember(path) { mutableStateOf<android.graphics.Bitmap?>(null) }
                    LaunchedEffect(path) { bitmap = viewModel.thumb(path) }
                    bitmap?.let {
                        Image(bitmap = it.asImageBitmap(), contentDescription = "Picture ΠAN kept",
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.padding(vertical = 6.dp).fillMaxWidth().heightIn(max = 180.dp).clip(RoundedCornerShape(12.dp)))
                    }
                }
                item.heard?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodyLarge, maxLines = 6, overflow = TextOverflow.Ellipsis)
                }
                item.said?.takeIf { it.isNotBlank() }?.let {
                    Spacer(Modifier.height(2.dp))
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 8, overflow = TextOverflow.Ellipsis)
                }
                if (item.heard.isNullOrBlank() && item.said.isNullOrBlank() && item.photo != null) {
                    Text("A picture", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            IconButton(onClick = onDelete) {
                Icon(Icons.Default.Delete, contentDescription = "Delete this", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

private val DAY_WORDS = DateTimeFormatter.ofPattern("EEE, MMM d")
private val DAY_WORDS_YEAR = DateTimeFormatter.ofPattern("EEE, MMM d, yyyy")
private val CLOCK = DateTimeFormatter.ofPattern("HH:mm")

private fun dayWords(day: LocalDate, today: LocalDate): String = when {
    day == today -> "Today"
    day == today.minusDays(1) -> "Yesterday"
    day.year == today.year -> day.format(DAY_WORDS)
    else -> day.format(DAY_WORDS_YEAR)
}

/** The time on this phone's clock (the hub's may be in another time zone). */
private fun timeWords(item: MemoryItem, withDate: Boolean): String {
    if (item.ms <= 0) return item.at
    val at = Instant.ofEpochMilli(item.ms).atZone(ZoneId.systemDefault())
    val clock = at.format(CLOCK)
    return if (withDate) "${dayWords(at.toLocalDate(), LocalDate.now())}, $clock" else clock
}
