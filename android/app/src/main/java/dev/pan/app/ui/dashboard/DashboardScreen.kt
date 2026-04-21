package dev.pan.app.ui.dashboard

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebChromeClient.FileChooserParams
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
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
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.hilt.navigation.compose.hiltViewModel
import dev.pan.app.ui.settings.SettingsViewModel
import java.io.ByteArrayOutputStream
import java.io.File

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

    val webViewRef = remember { mutableStateOf<WebView?>(null) }
    val cameraPhotoUri = remember { mutableStateOf<Uri?>(null) }
    val pendingCameraLaunch = remember { mutableStateOf(false) }

    // Gallery/file picker — for the file chooser (non-camera use)
    val fileChooserCallback = remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        fileChooserCallback.value?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        fileChooserCallback.value = null
    }

    // Helper to actually create temp file + fire ACTION_IMAGE_CAPTURE
    fun doLaunchCamera(cameraLauncherFn: (Intent) -> Unit) {
        try {
            val photoFile = File.createTempFile("pan_cam_", ".jpg", context.cacheDir)
            val photoUri = FileProvider.getUriForFile(context, "dev.pan.app.fileprovider", photoFile)
            cameraPhotoUri.value = photoUri
            val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, photoUri)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            cameraLauncherFn(intent)
            Log.w("PAN-DASH", "Camera launched with uri: $photoUri")
        } catch (e: Exception) {
            Log.e("PAN-DASH", "Camera launch failed: ${e.message}")
        }
    }

    // Direct ACTION_IMAGE_CAPTURE launcher — bypasses all Android 13+ photo picker interception
    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uri = cameraPhotoUri.value
        cameraPhotoUri.value = null
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            Log.w("PAN-DASH", "Camera cancelled or failed: code=${result.resultCode}")
            return@rememberLauncherForActivityResult
        }
        Log.w("PAN-DASH", "Camera success, encoding photo: $uri")
        try {
            val inputStream = context.contentResolver.openInputStream(uri) ?: return@rememberLauncherForActivityResult
            val raw = BitmapFactory.decodeStream(inputStream)
            inputStream.close()
            val maxDim = 1024
            val scaled = if (raw != null && (raw.width > maxDim || raw.height > maxDim)) {
                val ratio = maxOf(raw.width, raw.height).toFloat() / maxDim
                Bitmap.createScaledBitmap(raw, (raw.width / ratio).toInt(), (raw.height / ratio).toInt(), true)
            } else raw
            val out = ByteArrayOutputStream()
            scaled?.compress(Bitmap.CompressFormat.JPEG, 80, out)
            val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            Log.w("PAN-DASH", "Photo encoded: ${b64.length} chars")
            webViewRef.value?.post {
                webViewRef.value?.evaluateJavascript("window.panCameraResult('$b64')", null)
            }
        } catch (e: Exception) {
            Log.e("PAN-DASH", "Photo encode failed: ${e.message}")
        }
    }

    // Runtime CAMERA permission request — fires camera after grant
    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        Log.w("PAN-DASH", "Camera permission result: granted=$granted")
        if (granted && pendingCameraLaunch.value) {
            pendingCameraLaunch.value = false
            doLaunchCamera { intent -> cameraLauncher.launch(intent) }
        } else if (!granted) {
            Log.e("PAN-DASH", "Camera permission denied by user")
            webViewRef.value?.post {
                webViewRef.value?.evaluateJavascript("window.panToast && panToast('Camera permission denied')", null)
            }
        }
    }

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
                    WebView.setWebContentsDebuggingEnabled(true)
                    try {
                        WebStorage.getInstance().deleteAllData()
                        CookieManager.getInstance().removeAllCookies(null)
                        CookieManager.getInstance().flush()
                    } catch (_: Exception) {}

                    val url = "$baseUrl/mobile/?t=${System.currentTimeMillis()}"
                    Log.w("PAN-DASH", "Loading $url")

                    WebView(ctx).apply {
                        clearCache(true); clearHistory(); clearFormData()

                        webViewClient = object : WebViewClient() {
                            override fun onPageFinished(view: WebView?, url: String?) { Log.w("PAN-DASH", "Loaded: $url") }
                            override fun onReceivedError(view: WebView?, req: WebResourceRequest?, err: WebResourceError?) { Log.e("PAN-DASH", "Error: ${err?.description} ${req?.url}") }
                        }

                        webChromeClient = object : WebChromeClient() {
                            override fun onConsoleMessage(msg: ConsoleMessage?): Boolean {
                                Log.w("PAN-DASH JS", "${msg?.message()}")
                                return true
                            }
                            // Non-camera file chooser (e.g. future file upload)
                            override fun onShowFileChooser(webView: WebView?, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean {
                                fileChooserCallback.value?.onReceiveValue(null)
                                fileChooserCallback.value = filePathCallback
                                imagePicker.launch("*/*")
                                return true
                            }
                        }

                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                        settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
                        setBackgroundColor(android.graphics.Color.TRANSPARENT)

                        webViewRef.value = this

                        // JS bridge — window.PAN.openCamera() called directly from HTML button.
                        // Checks/requests CAMERA permission, then fires ACTION_IMAGE_CAPTURE.
                        addJavascriptInterface(
                            PANJsBridge {
                                android.os.Handler(android.os.Looper.getMainLooper()).post {
                                    Log.w("PAN-DASH", "window.PAN.openCamera() called")
                                    val hasPerm = ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                                    if (hasPerm) {
                                        doLaunchCamera { intent -> cameraLauncher.launch(intent) }
                                    } else {
                                        Log.w("PAN-DASH", "Requesting CAMERA permission...")
                                        pendingCameraLaunch.value = true
                                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                                    }
                                }
                            },
                            "PAN"
                        )

                        loadUrl(url)
                    }
                }
            )
        }
    }
}
