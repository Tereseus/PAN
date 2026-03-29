package dev.pan.app.ui.dashboard

import android.annotation.SuppressLint
import android.util.Log
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.hilt.navigation.compose.hiltViewModel
import dev.pan.app.ui.settings.SettingsViewModel

@OptIn(ExperimentalMaterial3Api::class)
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun DashboardScreen(
    onBack: () -> Unit,
    settingsViewModel: SettingsViewModel = hiltViewModel()
) {
    val serverUrl by settingsViewModel.serverUrl.collectAsState()
    val remoteEnabled by settingsViewModel.remoteAccessEnabled.collectAsState()

    // Use Tailscale proxy when available, direct server URL as fallback
    val proxyUrl = settingsViewModel.getRemoteProxyUrl()
    val dashUrl = if (remoteEnabled && proxyUrl != null) proxyUrl else serverUrl

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Π Dashboard") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        AndroidView(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            factory = { context ->
                WebView(context).apply {
                    webViewClient = object : WebViewClient() {
                        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                            Log.e("PAN-Dashboard", "WebView error: ${error?.description} for ${request?.url}")
                        }
                    }
                    webChromeClient = WebChromeClient()
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.useWideViewPort = true
                    settings.loadWithOverviewMode = true
                    settings.setSupportZoom(true)
                    settings.builtInZoomControls = true
                    settings.displayZoomControls = false
                    setBackgroundColor(android.graphics.Color.parseColor("#0a0a0f"))
                    Log.d("PAN-Dashboard", "Loading: $dashUrl/v2/")
                    loadUrl("$dashUrl/v2/")
                }
            }
        )
    }
}
