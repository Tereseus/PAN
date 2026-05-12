package dev.pan.app.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import dev.pan.app.BuildConfig
import dev.pan.app.network.LogShipper
import dev.pan.app.vpn.RemoteAccessManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Self-update flow — checks PAN server for a newer APK and triggers an install.
 *
 * Flow:
 *   1. GET /api/v1/apk/version  →  { applicationId, versionCode, sha256, apkUrl, ... }
 *   2. If `applicationId == BuildConfig.APPLICATION_ID` and
 *      `versionCode  >  BuildConfig.VERSION_CODE` we have an update.
 *   3. Download `apkUrl` to cacheDir/updates/pan-${versionCode}.apk
 *   4. Verify sha256 against the manifest. Bail (and delete) if mismatch.
 *   5. Hand the file to the system package installer via FileProvider +
 *      ACTION_VIEW. The user gets a system "Update this app?" dialog and
 *      taps once. App data + signing key are preserved.
 *
 * No silent install — that requires device-owner privileges. The system dialog
 * is the unavoidable Android security boundary for sideloaded APKs. What we
 * eliminate is the manual "open browser → /apk/latest → find file → tap"
 * dance. After this lands, every update is one-tap from inside the app.
 *
 * Works for any future PAN-shipped Android app — the only thing app-specific
 * is `BuildConfig.APPLICATION_ID` and the FileProvider authority.
 */
@Singleton
class UpdateChecker @Inject constructor(
    private val okHttpClient: OkHttpClient,
    private val remoteAccessManager: RemoteAccessManager,
    private val logShipper: LogShipper,
) {
    companion object {
        private const val TAG = "UpdateChecker"
        // FileProvider authority declared in AndroidManifest.xml
        private const val FILE_PROVIDER_AUTHORITY = "dev.pan.app.fileprovider"
        // LAN fallback if Tailscale isn't up yet
        private const val LAN_FALLBACK = "http://192.168.1.248:7777"
    }

    sealed class Result {
        object UpToDate : Result()
        data class UpdateAvailable(val versionCode: Int, val versionName: String) : Result()
        data class UpdateInstalling(val versionCode: Int, val versionName: String) : Result()
        data class Error(val message: String) : Result()
    }

    /**
     * One-shot check. Safe to call from app start. Suspends — runs network on IO.
     * If silent==true, errors are swallowed (logged only) and the call returns
     * a Result.Error rather than throwing, which is what we want on app start.
     */
    suspend fun checkAndInstall(context: Context, silent: Boolean = true): Result =
        withContext(Dispatchers.IO) {
            try {
                logShipper.info("update", "Update check starting (app=${BuildConfig.VERSION_CODE} ${BuildConfig.VERSION_NAME})")
                val base = remoteAccessManager.getTailscaleBaseUrl() ?: LAN_FALLBACK
                val url = "$base/api/v1/apk/version"

                val req = Request.Builder().url(url).build()
                val resp = okHttpClient.newCall(req).execute()
                resp.use {
                    if (!it.isSuccessful) {
                        logShipper.info("update", "Update check: version endpoint HTTP ${it.code}")
                        return@withContext Result.Error("version endpoint HTTP ${it.code}")
                    }
                    val body = it.body?.string()
                        ?: return@withContext Result.Error("empty version body")

                    val json = JSONObject(body)
                    val srvAppId = json.optString("applicationId")
                    val srvVersionCode = json.optInt("versionCode", -1)
                    val srvVersionName = json.optString("versionName")
                    val apkPath = json.optString("apkUrl", "/apk/latest")
                    val sha256 = json.optString("sha256")
                    val apkSize = json.optLong("apkSize", 0L)

                    // Sanity check — never install a different app over ourselves
                    if (srvAppId != BuildConfig.APPLICATION_ID) {
                        logShipper.info("update", "Update check: applicationId mismatch server=$srvAppId app=${BuildConfig.APPLICATION_ID}")
                        return@withContext Result.Error(
                            "applicationId mismatch: server=$srvAppId, app=${BuildConfig.APPLICATION_ID}"
                        )
                    }

                    if (srvVersionCode <= BuildConfig.VERSION_CODE) {
                        Log.i(TAG, "Up to date — server=$srvVersionCode, app=${BuildConfig.VERSION_CODE}")
                        logShipper.info("update", "Update check: server=$srvVersionCode app=${BuildConfig.VERSION_CODE} → up to date")
                        return@withContext Result.UpToDate
                    }

                    Log.i(TAG, "Update available: ${BuildConfig.VERSION_CODE} → $srvVersionCode ($srvVersionName)")
                    logShipper.info("update", "Update available: ${BuildConfig.VERSION_CODE} → $srvVersionCode ($srvVersionName), downloading...")

                    // Download
                    val apkFile = downloadApk(context, base + apkPath, srvVersionCode, apkSize)
                    if (apkFile == null) {
                        logShipper.info("update", "Update check: download failed for version $srvVersionCode")
                        return@withContext Result.Error("download failed")
                    }

                    // Verify
                    if (sha256.isNotEmpty()) {
                        val actual = sha256(apkFile)
                        if (!actual.equals(sha256, ignoreCase = true)) {
                            Log.w(TAG, "sha256 mismatch — expected=$sha256 actual=$actual")
                            logShipper.info("update", "Update check: sha256 mismatch expected=$sha256 actual=$actual — refusing install")
                            apkFile.delete()
                            return@withContext Result.Error("sha256 mismatch — refusing install")
                        }
                        Log.i(TAG, "sha256 verified ($actual)")
                        logShipper.info("update", "sha256 verified for version $srvVersionCode")
                    }

                    // Trigger install
                    logShipper.info("update", "Launching system installer for version $srvVersionCode ($srvVersionName)")
                    triggerInstall(context, apkFile)
                    return@withContext Result.UpdateInstalling(srvVersionCode, srvVersionName)
                }
            } catch (e: Exception) {
                Log.w(TAG, "checkAndInstall error: ${e.message}")
                logShipper.info("update", "Update check error: ${e.message}")
                if (silent) Result.Error(e.message ?: "unknown") else throw e
            }
        }

    private fun downloadApk(context: Context, url: String, versionCode: Int, expectedSize: Long): File? {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }

        // Clean up older downloaded APKs so cacheDir doesn't balloon
        dir.listFiles()?.forEach { f ->
            if (f.name.startsWith("pan-") && f.name.endsWith(".apk")) {
                runCatching { f.delete() }
            }
        }

        val file = File(dir, "pan-$versionCode.apk")
        val req = Request.Builder().url(url).build()
        okHttpClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                Log.w(TAG, "download HTTP ${resp.code}")
                return null
            }
            val body = resp.body ?: return null
            file.outputStream().use { out -> body.byteStream().copyTo(out) }
        }

        if (expectedSize > 0 && file.length() != expectedSize) {
            Log.w(TAG, "size mismatch: expected=$expectedSize actual=${file.length()}")
            file.delete()
            return null
        }
        Log.i(TAG, "Downloaded ${file.length()} bytes → ${file.absolutePath}")
        return file
    }

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun triggerInstall(context: Context, apkFile: File) {
        // Android 8+ requires the calling app to hold REQUEST_INSTALL_PACKAGES
        // AND the user must grant "Install unknown apps" for this app once in
        // system settings. If that isn't granted, kick the user there with a
        // deep link — they grant it once and the next update flow sails through.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !context.packageManager.canRequestPackageInstalls()) {
            Log.i(TAG, "Install-unknown-apps permission not granted — opening settings")
            val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                data = Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            runCatching { context.startActivity(intent) }
            return
        }

        val uri = FileProvider.getUriForFile(context, FILE_PROVIDER_AUTHORITY, apkFile)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        Log.i(TAG, "Launching system installer for ${apkFile.name}")
        runCatching { context.startActivity(intent) }
            .onFailure { Log.w(TAG, "startActivity failed: ${it.message}") }
    }
}
