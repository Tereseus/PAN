package dev.pan.app.ui.dashboard

import android.annotation.SuppressLint
import android.net.Uri
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebChromeClient.FileChooserParams
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebStorage
import android.webkit.CookieManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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
    val context = LocalContext.current
    Log.w("PAN-DASH", "Render: proxyPort=$proxyPort baseUrl=$baseUrl")

    // File chooser support — holds the WebView callback until the picker returns
    val fileChooserCallback = remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }

    val imagePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        fileChooserCallback.value?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        fileChooserCallback.value = null
    }

    // Android back button/gesture always leaves the dashboard — never navigates within WebView
    BackHandler { onBack() }

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
        if (baseUrl.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentAlignment = androidx.compose.ui.Alignment.Center
            ) {
                Text("Waiting for Tailscale...", color = MaterialTheme.colorScheme.onSurface)
            }
        } else {
            AndroidView(
                modifier = Modifier.fillMaxSize().padding(padding),
                factory = { ctx ->
                    // Nuke all WebView caches so we always get fresh content
                    WebView.setWebContentsDebuggingEnabled(true)
                    try {
                        WebStorage.getInstance().deleteAllData()
                        CookieManager.getInstance().removeAllCookies(null)
                        CookieManager.getInstance().flush()
                    } catch (_: Exception) {}

                    val url = "$baseUrl/mobile/?t=${System.currentTimeMillis()}"
                    Log.w("PAN-DASH", "Loading $url")

                    WebView(ctx).apply {
                        // Kill any existing cache
                        clearCache(true)
                        clearHistory()
                        clearFormData()

                        webViewClient = object : WebViewClient() {
                            override fun onPageFinished(view: WebView?, url: String?) {
                                Log.w("PAN-DASH", "Loaded: $url")
                            }
                            override fun onReceivedError(view: WebView?, req: WebResourceRequest?, err: WebResourceError?) {
                                Log.e("PAN-DASH", "Error: ${err?.description} ${req?.url}")
                            }
                        }
                        webChromeClient = object : WebChromeClient() {
                            override fun onConsoleMessage(msg: ConsoleMessage?): Boolean {
                                Log.w("PAN-DASH", "JS: ${msg?.message()}")
                                return true
                            }

                            override fun onShowFileChooser(
                                webView: WebView?,
                                filePathCallback: ValueCallback<Array<Uri>>,
                                fileChooserParams: FileChooserParams
                            ): Boolean {
                                // Cancel any previous pending callback before opening a new picker
                                fileChooserCallback.value?.onReceiveValue(null)
                                fileChooserCallback.value = filePathCallback
                                imagePicker.launch("image/*")
                                return true
                            }
                        }

                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                        settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
                        setBackgroundColor(android.graphics.Color.TRANSPARENT)

                        loadUrl(url)
                    }
                }
            )
        }
    }
}
