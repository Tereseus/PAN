package dev.pan.app.ui.hub

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay

private val UP = Color(0xFF4CAF50)
private val DOWN = Color(0xFFF44336)

/**
 * The hub, from the phone (the owner, 2026-11-18): Services (what is running on it) and
 * Intuition (what ΠAN reads about him right now). Behind the developer switch in Settings.
 * It replaced the hub's web page shown inside the app, which repeated what the app already
 * has and did not look like the rest of it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HubScreen(onBack: () -> Unit, viewModel: HubViewModel = hiltViewModel()) {
    val services by viewModel.services.collectAsState()
    val intuition by viewModel.intuition.collectAsState()
    val trouble by viewModel.trouble.collectAsState()
    val loading by viewModel.loading.collectAsState()
    val picks by viewModel.picks.collectAsState()
    val noPicks by viewModel.noPicks.collectAsState()
    val device by viewModel.device.collectAsState()
    val machines by viewModel.machines.collectAsState()
    val timing by viewModel.timing.collectAsState()
    var tab by rememberSaveable { mutableIntStateOf(0) }

    BackHandler { onBack() }
    // Fresh while it is on screen; nothing is asked otherwise.
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) { viewModel.load(); delay(15_000) }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Hub") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                actions = { IconButton(onClick = { viewModel.refresh() }, enabled = !loading) { Icon(Icons.Default.Refresh, contentDescription = "Refresh") } },
            )
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            TabRow(selectedTabIndex = tab) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Services") })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Intuition") })
                Tab(selected = tab == 2, onClick = { tab = 2 }, text = { Text("Models") })
            }
            if (trouble.isNotEmpty()) Text(trouble, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
            when (tab) {
                0 -> ServicesPart(services)
                1 -> IntuitionPart(intuition)
                else -> ModelsPart(picks, noPicks, device, viewModel::setHubModel, viewModel::setPace, machines, timing, viewModel::setAllowed, viewModel::testSpeed)
            }
        }
    }
}

@Composable
internal fun Heading(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 6.dp))
}

@Composable
private fun Dot(color: Color) {
    Box(modifier = Modifier.size(10.dp).clip(CircleShape).background(color))
}

@Composable
private fun ServicesPart(services: List<HubService>?) {
    val list = services ?: return
    val down = list.filter { it.status == "down" }
    val up = list.filter { it.status == "up" }
    val silent = list.filter { it.status != "up" && it.status != "down" }
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        item {
            Text("${up.size} running" + (if (down.isNotEmpty()) ", ${down.size} down" else "") + (if (silent.isNotEmpty()) ", ${silent.size} not reporting" else ""),
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 14.dp))
        }
        // What is down comes first: it is the reason to look here.
        if (down.isNotEmpty()) {
            item { Heading("Down") }
            items(down, key = { "d-${it.category}-${it.name}" }) { ServiceRow(it) }
        }
        up.map { it.category }.distinct().forEach { category ->
            item(key = "h-$category") { Heading(category) }
            items(up.filter { it.category == category }, key = { "u-${it.category}-${it.name}" }) { ServiceRow(it) }
        }
        // Parts that send no sign of life: one line, by name, not a row each.
        if (silent.isNotEmpty()) {
            item { Heading("Not reporting") }
            item {
                Text(silent.joinToString(", ") { it.name }, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 20.dp))
                Text("These parts send the hub no sign of life, so it cannot say if they run.", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 4.dp))
            }
        }
        item { Spacer(Modifier.size(24.dp)) }
    }
}

@Composable
private fun ServiceRow(s: HubService) {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.Top) {
        Box(modifier = Modifier.padding(top = 6.dp)) { Dot(if (s.status == "down") DOWN else UP) }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(s.name, style = MaterialTheme.typography.bodyLarge)
            if (s.role.isNotBlank()) Text(s.role, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (s.detail.isNotBlank()) Text(s.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun ago(at: Long): String {
    if (at <= 0) return ""
    val s = ((System.currentTimeMillis() - at) / 1000).coerceAtLeast(0)
    return when {
        s < 60 -> "${s} s ago"
        s < 3600 -> "${s / 60} min ago"
        else -> "${s / 3600} h ago"
    }
}

@Composable
private fun IntuitionPart(view: IntuitionView?) {
    val v = view ?: return
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        item {
            Text(listOfNotNull("Read ${ago(v.at)}".takeIf { v.at > 0 }, v.confidence?.let { "$it% sure" }).joinToString(", "),
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 14.dp))
        }
        item { Heading("What ΠAN reads about you now") }
        items(v.now, key = { "n-${it.label}" }) { ReadRow(it) }
        if (v.next.isNotEmpty()) {
            item { Heading("What it expects next") }
            items(v.next) { Text(it, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) }
        }
        if (v.from.isNotEmpty()) {
            item { Heading("What it read it from") }
            items(v.from, key = { "f-${it.label}" }) { ReadRow(it) }
        }
        if (v.note.isNotBlank()) item {
            HorizontalDivider(modifier = Modifier.padding(top = 16.dp))
            Text(v.note, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
        }
        item { Spacer(Modifier.size(24.dp)) }
    }
}

@Composable
private fun ReadRow(line: ReadLine) {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(line.label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(120.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(line.value.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.bodyLarge)
            if (line.why.isNotBlank()) Text(line.why, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
