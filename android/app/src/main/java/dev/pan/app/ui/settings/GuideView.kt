package dev.pan.app.ui.settings

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/**
 * How to use ΠAN (task 1068): the guide pages, copied into the app's assets at build time from
 * service/public/guide (the copyGuide task), so they open with no network. Pages link to each
 * other; Back goes to the page before, then out of the guide. A link out of the guide opens in
 * the browser.
 */
const val GUIDE_START = "file:///android_asset/guide/index.html"

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun GuideView(modifier: Modifier = Modifier, onLeave: () -> Unit) {
    var web by remember { mutableStateOf<WebView?>(null) }
    var canBack by remember { mutableStateOf(false) }
    BackHandler(enabled = true) { if (canBack) web?.goBack() else onLeave() }
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = false
                settings.allowFileAccess = true
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        val url = request.url.toString()
                        if (url.startsWith("file:///android_asset/guide/")) return false
                        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        return true
                    }
                    override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                        canBack = view.canGoBack()
                    }
                }
                loadUrl(GUIDE_START)
                web = this
            }
        },
    )
}
