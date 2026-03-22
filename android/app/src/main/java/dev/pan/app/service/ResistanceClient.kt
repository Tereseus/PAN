package dev.pan.app.service

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL

/**
 * PAN Resistance Client — local cache of resistance paths + preferences.
 * Syncs with server periodically. Runs action plans locally without server calls.
 *
 * Flow:
 * 1. User says "play huh"
 * 2. ResistanceClient checks preference (e.g., Spotify)
 * 3. Tries preference first
 * 4. If fails, tries next path in resistance order
 * 5. Reports result to server (async, non-blocking)
 * 6. Something always works
 */
class ResistanceClient(
    private val context: Context,
    private val serverUrl: String = "http://192.168.1.248:7777"
) {
    private val TAG = "PAN-Resistance"
    private val prefs: SharedPreferences = context.getSharedPreferences("pan_resistance", Context.MODE_PRIVATE)
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // Local resistance paths cache
    data class ResistancePath(
        val pathName: String,
        val method: String,   // intent, deeplink, browser, api, accessibility
        val platform: String, // android, pc, all
        val preferred: Boolean = false,
        val successRate: Float = 0.5f
    )

    // Default paths — used before first sync
    private val defaultPaths = mapOf(
        "play_music" to listOf(
            ResistancePath("spotify_deeplink", "deeplink", "android"),
            ResistancePath("youtube_intent", "intent", "android"),
            ResistancePath("youtube_music_intent", "intent", "android"),
            ResistancePath("browser_youtube", "browser", "pc"),
        ),
        "send_message" to listOf(
            ResistancePath("sms_intent", "intent", "android"),
            ResistancePath("whatsapp_accessibility", "accessibility", "android"),
            ResistancePath("browser_webapp", "browser", "pc"),
        ),
        "navigate" to listOf(
            ResistancePath("maps_intent", "intent", "android"),
        ),
    )

    // Get preference for an action
    fun getPreference(action: String): String? {
        return prefs.getString("pref_$action", null)
    }

    // Set preference for an action
    fun setPreference(action: String, pathName: String) {
        prefs.edit().putString("pref_$action", pathName).apply()
        // Sync to server async
        scope.launch { syncPreferenceToServer(action, pathName) }
    }

    // Get ordered paths for an action — preference first, then by resistance
    fun getActionPlan(action: String): List<ResistancePath> {
        val cachedPlan = getCachedPlan(action)
        if (cachedPlan.isNotEmpty()) return cachedPlan
        return defaultPaths[action] ?: emptyList()
    }

    // Try to play music — runs through resistance paths
    fun tryPlayMusic(context: Context, songQuery: String, explicitService: String? = null): PlayResult {
        val paths = getActionPlan("play_music").toMutableList()

        // If user said "on youtube" or "on spotify", reorder
        if (explicitService != null) {
            val explicit = paths.find { it.pathName.contains(explicitService, ignoreCase = true) }
            if (explicit != null) {
                paths.remove(explicit)
                paths.add(0, explicit.copy(preferred = true))
            }
        } else {
            // Check preference
            val pref = getPreference("play_music")
            if (pref != null) {
                val prefPath = paths.find { it.pathName.contains(pref, ignoreCase = true) }
                if (prefPath != null) {
                    paths.remove(prefPath)
                    paths.add(0, prefPath.copy(preferred = true))
                }
            }
        }

        for (path in paths) {
            val result = executePlayPath(context, path, songQuery)
            if (result.success) {
                reportToServer("play_music", path.pathName, true, null)
                return result
            } else {
                reportToServer("play_music", path.pathName, false, result.error)
            }
        }

        return PlayResult(false, "Could not play $songQuery. No available method worked.", null)
    }

    // Execute a specific play music path
    private fun executePlayPath(context: Context, path: ResistancePath, query: String): PlayResult {
        return when (path.pathName) {
            "spotify_deeplink" -> trySpotify(context, query)
            "youtube_intent" -> tryYouTube(context, query)
            "youtube_music_intent" -> tryYouTubeMusic(context, query)
            "browser_youtube" -> PlayResult(false, "PC-only path", null) // skip on phone
            else -> PlayResult(false, "Unknown path: ${path.pathName}", null)
        }
    }

    private fun trySpotify(context: Context, query: String): PlayResult {
        return try {
            val intent = Intent(Intent.ACTION_VIEW).apply {
                data = Uri.parse("spotify:search:${Uri.encode(query)}")
                setPackage("com.spotify.music")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            PlayResult(true, null, "Playing $query on Spotify.")
        } catch (e: Exception) {
            PlayResult(false, "Spotify not available: ${e.message}", null)
        }
    }

    private fun tryYouTube(context: Context, query: String): PlayResult {
        return try {
            val intent = Intent(Intent.ACTION_VIEW).apply {
                data = Uri.parse("https://www.youtube.com/results?search_query=${Uri.encode(query)}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            PlayResult(true, null, "Searching YouTube for $query.")
        } catch (e: Exception) {
            PlayResult(false, "YouTube not available: ${e.message}", null)
        }
    }

    private fun tryYouTubeMusic(context: Context, query: String): PlayResult {
        return try {
            val intent = Intent(Intent.ACTION_VIEW).apply {
                data = Uri.parse("https://music.youtube.com/search?q=${Uri.encode(query)}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            PlayResult(true, null, "Searching YouTube Music for $query.")
        } catch (e: Exception) {
            PlayResult(false, "YouTube Music not available: ${e.message}", null)
        }
    }

    // "That didn't work" — report failure and get next path
    fun reportLastFailed(action: String): String {
        val lastPath = prefs.getString("last_${action}_path", null) ?: return "No previous attempt to report."
        reportToServer(action, lastPath, false, "User reported failure")

        // Get next path
        val plan = getActionPlan(action)
        val remaining = plan.filter { it.pathName != lastPath }
        return if (remaining.isNotEmpty()) {
            "Got it. Next time I'll try ${remaining[0].pathName.replace("_", " ")} instead."
        } else {
            "No other methods available."
        }
    }

    // Sync with server
    fun syncFromServer() {
        scope.launch {
            try {
                val url = URL("$serverUrl/api/v1/resistance/plan?action=play_music&platform=android")
                val response = url.readText()
                val json = JSONObject(response)
                val plan = json.getJSONArray("plan")
                cachePlan("play_music", plan)
                Log.d(TAG, "Synced play_music plan: ${plan.length()} paths")

                // Sync other actions
                for (action in listOf("send_message", "navigate", "calendar", "search")) {
                    try {
                        val resp = URL("$serverUrl/api/v1/resistance/plan?action=$action&platform=android").readText()
                        val j = JSONObject(resp)
                        cachePlan(action, j.getJSONArray("plan"))
                    } catch (_: Exception) {}
                }

                // Sync preferences
                try {
                    val prefResp = URL("$serverUrl/api/v1/resistance/preferences").readText()
                    val prefArray = JSONArray(prefResp)
                    for (i in 0 until prefArray.length()) {
                        val p = prefArray.getJSONObject(i)
                        prefs.edit().putString("pref_${p.getString("action")}", p.getString("preferred_path")).apply()
                    }
                } catch (_: Exception) {}

            } catch (e: Exception) {
                Log.w(TAG, "Sync failed: ${e.message}")
            }
        }
    }

    // Cache plan locally
    private fun cachePlan(action: String, planArray: JSONArray) {
        prefs.edit().putString("plan_$action", planArray.toString()).apply()
    }

    // Get cached plan
    private fun getCachedPlan(action: String): List<ResistancePath> {
        val json = prefs.getString("plan_$action", null) ?: return emptyList()
        return try {
            val array = JSONArray(json)
            (0 until array.length()).map { i ->
                val obj = array.getJSONObject(i)
                ResistancePath(
                    pathName = obj.getString("path"),
                    method = obj.getString("method"),
                    platform = obj.optString("platform", "android"),
                    preferred = obj.optBoolean("preferred", false),
                    successRate = obj.optDouble("successRate", 0.5).toFloat()
                )
            }
        } catch (_: Exception) { emptyList() }
    }

    // Report to server async
    private fun reportToServer(action: String, pathName: String, success: Boolean, error: String?) {
        scope.launch {
            try {
                val url = URL("$serverUrl/api/v1/resistance/result")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                conn.outputStream.write("""{"action":"$action","path":"$pathName","success":$success,"error":${if (error != null) "\"$error\"" else "null"}}""".toByteArray())
                conn.responseCode // trigger the request
                conn.disconnect()
            } catch (_: Exception) {}
        }
        // Also save last path locally
        prefs.edit().putString("last_${action}_path", pathName).apply()
    }

    private fun syncPreferenceToServer(action: String, pathName: String) {
        try {
            val url = URL("$serverUrl/api/v1/resistance/preference")
            val conn = url.openConnection() as java.net.HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.outputStream.write("""{"action":"$action","preferred":"$pathName"}""".toByteArray())
            conn.responseCode
            conn.disconnect()
        } catch (_: Exception) {}
    }

    data class PlayResult(
        val success: Boolean,
        val error: String?,
        val message: String?
    )
}
