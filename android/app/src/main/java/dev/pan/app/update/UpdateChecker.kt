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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
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
 *   3. Download `apkUrl` to cacheDir/updates/pan-${versionCode}.apk.part, resuming
 *      with a Range request if the link drops, then rename it to pan-${versionCode}.apk.
 *      A finished file from an earlier try (installer dismissed) is reused.
 *   4. Verify sha256 against the manifest. Bail (and delete) if mismatch.
 *   5. Hand the file to the system package installer via FileProvider +
 *      ACTION_VIEW. The user gets a system "Update this app?" dialog and
 *      taps once. App data + signing key are preserved.
 *
 * One check runs at a time. The launch check and the Settings button used to run
 * together: both wrote pan-${versionCode}.apk and each one's cleanup deleted the
 * other's half-written file, so both reported "download failed". A second caller
 * now waits for the check already running and gets its result.
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
        // Tries per download; each one resumes where the last stopped
        private const val DOWNLOAD_ATTEMPTS = 3
    }

    sealed class Result {
        object UpToDate : Result()
        data class UpdateAvailable(val versionCode: Int, val versionName: String) : Result()
        data class UpdateInstalling(val versionCode: Int, val versionName: String) : Result()
        data class Error(val message: String) : Result()
    }

    private class Manifest(
        val base: String,
        val versionCode: Int,
        val versionName: String,
        val apkPath: String,
        val sha256: String,
        val apkSize: Long,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var running: Deferred<Result>? = null

    /**
     * Asks the server what it has, without downloading. Used to say "update found"
     * or "up to date" before the download starts. Never throws.
     */
    suspend fun check(): Result = withContext(Dispatchers.IO) {
        try {
            val m = fetchManifest()
            if (m.versionCode > BuildConfig.VERSION_CODE) Result.UpdateAvailable(m.versionCode, m.versionName)
            else Result.UpToDate
        } catch (e: Exception) {
            Result.Error(e.message ?: "unknown")
        }
    }

    /**
     * Check, download, verify, install. Safe to call from app start and from the
     * Settings button at the same time (see the class comment). Never throws;
     * failures come back as Result.Error.
     */
    suspend fun checkAndInstall(context: Context): Result {
        val job = synchronized(this) {
            running?.takeIf { it.isActive }
                ?: scope.async { runCheck(context.applicationContext) }.also { running = it }
        }
        return job.await()
    }

    private fun fetchManifest(): Manifest {
        val base = remoteAccessManager.getTailscaleBaseUrl() ?: LAN_FALLBACK
        val req = Request.Builder().url("$base/api/v1/apk/version").build()
        okHttpClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("version endpoint HTTP ${resp.code}")
            val json = JSONObject(resp.body?.string() ?: throw IOException("empty version body"))
            val srvAppId = json.optString("applicationId")
            // Sanity check — never install a different app over ourselves
            if (srvAppId != BuildConfig.APPLICATION_ID) {
                throw IOException("applicationId mismatch: server=$srvAppId, app=${BuildConfig.APPLICATION_ID}")
            }
            return Manifest(
                base = base,
                versionCode = json.optInt("versionCode", -1),
                versionName = json.optString("versionName"),
                apkPath = json.optString("apkUrl", "/apk/latest"),
                sha256 = json.optString("sha256"),
                apkSize = json.optLong("apkSize", 0L),
            )
        }
    }

    private fun runCheck(context: Context): Result {
        try {
            logShipper.info("update", "Update check starting (app=${BuildConfig.VERSION_CODE} ${BuildConfig.VERSION_NAME})")
            val m = fetchManifest()

            if (m.versionCode <= BuildConfig.VERSION_CODE) {
                Log.i(TAG, "Up to date — server=${m.versionCode}, app=${BuildConfig.VERSION_CODE}")
                logShipper.info("update", "Update check: server=${m.versionCode} app=${BuildConfig.VERSION_CODE} → up to date")
                return Result.UpToDate
            }

            Log.i(TAG, "Update available: ${BuildConfig.VERSION_CODE} → ${m.versionCode} (${m.versionName})")
            logShipper.info("update", "Update available: ${BuildConfig.VERSION_CODE} → ${m.versionCode} (${m.versionName}), downloading...")

            // Download
            val apkFile = downloadApk(context, m.base + m.apkPath, m.versionCode, m.apkSize)
            if (apkFile == null) {
                logShipper.info("update", "Update check: download failed for version ${m.versionCode}")
                return Result.Error("download failed")
            }

            // Verify
            if (m.sha256.isNotEmpty()) {
                val actual = sha256(apkFile)
                if (!actual.equals(m.sha256, ignoreCase = true)) {
                    Log.w(TAG, "sha256 mismatch — expected=${m.sha256} actual=$actual")
                    logShipper.info("update", "Update check: sha256 mismatch expected=${m.sha256} actual=$actual — refusing install")
                    apkFile.delete()
                    return Result.Error("sha256 mismatch — refusing install")
                }
                Log.i(TAG, "sha256 verified ($actual)")
                logShipper.info("update", "sha256 verified for version ${m.versionCode}")
            }

            // Trigger install
            logShipper.info("update", "Launching system installer for version ${m.versionCode} (${m.versionName})")
            triggerInstall(context, apkFile)
            return Result.UpdateInstalling(m.versionCode, m.versionName)
        } catch (e: Exception) {
            Log.w(TAG, "checkAndInstall error: ${e.message}")
            logShipper.info("update", "Update check error: ${e.message}")
            return Result.Error(e.message ?: "unknown")
        }
    }

    private fun downloadApk(context: Context, url: String, versionCode: Int, expectedSize: Long): File? {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        val file = File(dir, "pan-$versionCode.apk")
        val part = File(dir, "pan-$versionCode.apk.part")

        // Clean up other versions' APKs so cacheDir doesn't balloon
        dir.listFiles()?.forEach { f ->
            if (f.name.startsWith("pan-") && f.name != file.name && f.name != part.name) {
                runCatching { f.delete() }
            }
        }

        // Finished on an earlier try (installer dismissed): the caller still checks sha256
        if (file.exists() && (expectedSize <= 0 || file.length() == expectedSize)) {
            Log.i(TAG, "Reusing downloaded ${file.name}")
            return file
        }
        file.delete()

        var done = false
        for (attempt in 1..DOWNLOAD_ATTEMPTS) {
            if (expectedSize > 0 && part.length() > expectedSize) part.delete()
            if (expectedSize > 0 && part.length() == expectedSize) { done = true; break }
            val start = part.length()
            val req = Request.Builder().url(url)
                .apply { if (start > 0) header("Range", "bytes=$start-") }
                .build()
            try {
                okHttpClient.newCall(req).execute().use { resp ->
                    when {
                        // The server's APK changed under us: start over
                        resp.code == 416 -> part.delete()
                        !resp.isSuccessful -> Log.w(TAG, "download HTTP ${resp.code}")
                        else -> resp.body?.byteStream()?.use { input ->
                            // 206 = resumed where we stopped; 200 = the whole file again
                            FileOutputStream(part, resp.code == 206).use { out -> input.copyTo(out) }
                            if (expectedSize <= 0) done = true
                        }
                    }
                }
            } catch (e: IOException) {
                Log.w(TAG, "download attempt $attempt stopped at ${part.length()} bytes: ${e.message}")
            }
            if (done || (expectedSize > 0 && part.length() == expectedSize)) { done = true; break }
        }

        if (!done) {
            Log.w(TAG, "download incomplete: expected=$expectedSize actual=${part.length()}")
            return null
        }
        if (!part.renameTo(file)) {
            Log.w(TAG, "could not rename ${part.name}")
            part.delete()
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
