package dev.pan.app.ui.dashboard

import android.annotation.SuppressLint
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
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
    val proxyPort by settingsViewModel.remoteAccessManager.proxyPort.collectAsState()
    val baseUrl = if (proxyPort > 0) "http://127.0.0.1:$proxyPort" else ""

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("PAN Dashboard") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        if (baseUrl.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentAlignment = androidx.compose.ui.Alignment.Center
            ) {
                Text("Waiting for Tailscale...", color = MaterialTheme.colorScheme.onSurface)
            }
        } else {
            // key() prevents recomposition from recreating the WebView
            key(baseUrl) {
                AndroidView(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    factory = { ctx ->
                        // Use v1 dashboard (plain HTML/JS) — SvelteKit ES modules don't work in Android WebView
                        val url = "$baseUrl/dashboard/index.html"
                        Log.w("PAN-DASH", "Creating WebView for $url")
                        WebView.setWebContentsDebuggingEnabled(true)
                        WebView(ctx).apply {
                            webViewClient = object : WebViewClient() {
                                override fun onPageFinished(view: WebView?, url: String?) {
                                    Log.w("PAN-DASH", "Page loaded: $url")
                                }
                                override fun onReceivedError(view: WebView?, req: WebResourceRequest?, err: WebResourceError?) {
                                    Log.e("PAN-DASH", "Error: code=${err?.errorCode} desc=${err?.description} url=${req?.url} isMain=${req?.isForMainFrame}")
                                }
                                override fun onReceivedHttpError(view: WebView?, req: WebResourceRequest?, resp: WebResourceResponse?) {
                                    Log.e("PAN-DASH", "HTTP ${resp?.statusCode} ${resp?.reasonPhrase} for ${req?.url}")
                                }
                            }
                            webChromeClient = object : WebChromeClient() {
                                override fun onConsoleMessage(msg: ConsoleMessage?): Boolean {
                                    Log.w("PAN-DASH", "JS [${msg?.messageLevel()}]: ${msg?.message()} at ${msg?.sourceId()}:${msg?.lineNumber()}")
                                    return true
                                }
                            }
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                            settings.allowFileAccess = true
                            settings.allowContentAccess = true
                            setBackgroundColor(android.graphics.Color.parseColor("#0a0a0f"))
                            loadUrl(url)
                        }
                    }
                )
            }
        }
    }
}
