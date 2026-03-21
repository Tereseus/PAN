package dev.pan.app.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * PAN Accessibility Service — gives PAN full control of any app on the phone.
 *
 * Capabilities:
 * - Read any screen (all text, buttons, inputs)
 * - Tap any element by text or position
 * - Type into any field
 * - Scroll up/down/left/right
 * - Press back, home, recents
 * - Navigate any app programmatically
 *
 * The service polls the PAN server for accessibility commands,
 * executes them, and returns results.
 */
class PanAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "PanA11y"
        private const val PAN_SERVER = "http://192.168.1.248:7777"
        private const val POLL_INTERVAL = 2000L

        // Static reference so the foreground service can call methods directly
        var instance: PanAccessibilityService? = null
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this

        val info = AccessibilityServiceInfo().apply {
            eventTypes = AccessibilityEvent.TYPES_ALL_MASK
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
                    AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
                    AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
            notificationTimeout = 100
        }
        serviceInfo = info

        Log.i(TAG, "ΠΑΝ Accessibility Service connected")

        // Start polling for commands
        scope.launch { pollLoop() }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // We don't need to handle events — we poll for commands instead
    }

    override fun onInterrupt() {
        Log.w(TAG, "Accessibility service interrupted")
    }

    override fun onDestroy() {
        instance = null
        scope.cancel()
        super.onDestroy()
    }

    // Poll PAN server for accessibility commands
    private suspend fun pollLoop() {
        while (true) {
            try {
                val url = URL("$PAN_SERVER/api/v1/accessibility/commands")
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 5000
                conn.readTimeout = 5000

                if (conn.responseCode == 200) {
                    val body = conn.inputStream.bufferedReader().readText()
                    val commands = JSONArray(body)

                    for (i in 0 until commands.length()) {
                        val cmd = commands.getJSONObject(i)
                        val result = executeCommand(cmd)

                        // Send result back
                        sendResult(cmd.optString("id"), result)
                    }
                }
                conn.disconnect()
            } catch (_: Exception) {}

            delay(POLL_INTERVAL)
        }
    }

    private fun sendResult(id: String, result: JSONObject) {
        try {
            val url = URL("$PAN_SERVER/api/v1/accessibility/result")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true

            val body = JSONObject().apply {
                put("id", id)
                put("result", result)
            }
            conn.outputStream.write(body.toString().toByteArray())
            conn.responseCode // trigger the request
            conn.disconnect()
        } catch (_: Exception) {}
    }

    private fun executeCommand(cmd: JSONObject): JSONObject {
        return try {
            when (cmd.optString("action")) {
                "read_screen" -> readScreen()
                "tap" -> tap(cmd.optString("text"), cmd.optInt("x", -1), cmd.optInt("y", -1))
                "type_text" -> typeText(cmd.optString("text"), cmd.optString("target"))
                "scroll" -> scroll(cmd.optString("direction", "down"))
                "back" -> { performGlobalAction(GLOBAL_ACTION_BACK); ok("Pressed back") }
                "home" -> { performGlobalAction(GLOBAL_ACTION_HOME); ok("Pressed home") }
                "recents" -> { performGlobalAction(GLOBAL_ACTION_RECENTS); ok("Opened recents") }
                "notifications" -> { performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS); ok("Opened notifications") }
                "find_element" -> findElement(cmd.optString("text"))
                "get_focused" -> getFocusedApp()
                else -> error("Unknown action: ${cmd.optString("action")}")
            }
        } catch (e: Exception) {
            error(e.message ?: "unknown error")
        }
    }

    // Read all visible text and interactive elements on the current screen
    fun readScreen(): JSONObject {
        val root = rootInActiveWindow ?: return error("No active window")

        val elements = mutableListOf<JSONObject>()
        val allText = StringBuilder()

        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            if (depth > 10) return

            val text = node.text?.toString() ?: ""
            val desc = node.contentDescription?.toString() ?: ""
            val className = node.className?.toString() ?: ""
            val viewId = node.viewIdResourceName ?: ""

            val displayText = text.ifEmpty { desc }

            if (displayText.isNotBlank()) {
                allText.append(displayText).append("\n")
            }

            // Collect interactive elements
            if (node.isClickable || node.isEditable || node.isCheckable) {
                val rect = Rect()
                node.getBoundsInScreen(rect)

                elements.add(JSONObject().apply {
                    put("text", displayText)
                    put("type", className.substringAfterLast("."))
                    put("clickable", node.isClickable)
                    put("editable", node.isEditable)
                    put("x", rect.centerX())
                    put("y", rect.centerY())
                    put("id", viewId)
                })
            }

            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                walk(child, depth + 1)
                child.recycle()
            }
        }

        walk(root, 0)
        root.recycle()

        return JSONObject().apply {
            put("ok", true)
            put("text", allText.toString().take(10000))
            put("elements", JSONArray(elements.take(50)))
            put("element_count", elements.size)
        }
    }

    // Tap on an element by text match or coordinates
    fun tap(text: String, x: Int, y: Int): JSONObject {
        if (x >= 0 && y >= 0) {
            // Tap by coordinates
            return performTap(x.toFloat(), y.toFloat())
        }

        if (text.isBlank()) return error("No text or coordinates")

        // Find element by text and tap it
        val root = rootInActiveWindow ?: return error("No active window")
        val target = findNodeByText(root, text.lowercase())
        root.recycle()

        if (target != null) {
            val rect = Rect()
            target.getBoundsInScreen(rect)

            // Try performAction first (more reliable)
            if (target.isClickable) {
                target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                target.recycle()
                return ok("Tapped: $text")
            }

            // Fall back to gesture tap
            target.recycle()
            return performTap(rect.centerX().toFloat(), rect.centerY().toFloat())
        }

        return error("Element not found: $text")
    }

    // Type text into the focused field or a field matching target text
    fun typeText(text: String, target: String): JSONObject {
        val root = rootInActiveWindow ?: return error("No active window")

        var editNode: AccessibilityNodeInfo? = null

        if (target.isNotBlank()) {
            // Find an editable field near the target text
            editNode = findEditableNode(root, target.lowercase())
        }

        if (editNode == null) {
            // Find any focused editable field
            editNode = findFocusedEditable(root)
        }

        if (editNode == null) {
            // Find any editable field
            editNode = findFirstEditable(root)
        }

        root.recycle()

        if (editNode != null) {
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            editNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            editNode.recycle()
            return ok("Typed: $text")
        }

        return error("No editable field found")
    }

    // Scroll in a direction
    fun scroll(direction: String): JSONObject {
        val root = rootInActiveWindow ?: return error("No active window")

        // Find a scrollable node
        fun findScrollable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
            if (node.isScrollable) return node
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                val result = findScrollable(child)
                if (result != null) return result
                child.recycle()
            }
            return null
        }

        val scrollable = findScrollable(root)
        if (scrollable != null) {
            val action = when (direction.lowercase()) {
                "up" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                "down" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
                else -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            }
            scrollable.performAction(action)
            scrollable.recycle()
            root.recycle()
            return ok("Scrolled $direction")
        }

        root.recycle()
        return error("No scrollable element found")
    }

    // Find an element by text
    fun findElement(text: String): JSONObject {
        val root = rootInActiveWindow ?: return error("No active window")
        val results = mutableListOf<JSONObject>()

        fun search(node: AccessibilityNodeInfo) {
            val nodeText = (node.text?.toString() ?: "").lowercase()
            val nodeDesc = (node.contentDescription?.toString() ?: "").lowercase()
            val searchLower = text.lowercase()

            if (nodeText.contains(searchLower) || nodeDesc.contains(searchLower)) {
                val rect = Rect()
                node.getBoundsInScreen(rect)
                results.add(JSONObject().apply {
                    put("text", node.text?.toString() ?: node.contentDescription?.toString() ?: "")
                    put("type", node.className?.toString()?.substringAfterLast(".") ?: "")
                    put("x", rect.centerX())
                    put("y", rect.centerY())
                    put("clickable", node.isClickable)
                })
            }

            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                search(child)
                child.recycle()
            }
        }

        search(root)
        root.recycle()

        return JSONObject().apply {
            put("ok", true)
            put("results", JSONArray(results.take(20)))
            put("count", results.size)
        }
    }

    // Get info about the currently focused app
    fun getFocusedApp(): JSONObject {
        val root = rootInActiveWindow ?: return error("No active window")
        val pkg = root.packageName?.toString() ?: "unknown"
        val screen = readScreen()
        root.recycle()

        return JSONObject().apply {
            put("ok", true)
            put("package", pkg)
            put("text", screen.optString("text").take(2000))
            put("elements", screen.optJSONArray("elements"))
        }
    }

    // Helper: perform a tap gesture at coordinates
    private fun performTap(x: Float, y: Float): JSONObject {
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 50))
            .build()

        dispatchGesture(gesture, null, null)
        return ok("Tapped at ($x, $y)")
    }

    // Helper: find node by text
    private fun findNodeByText(root: AccessibilityNodeInfo, searchText: String): AccessibilityNodeInfo? {
        val nodeText = (root.text?.toString() ?: "").lowercase()
        val nodeDesc = (root.contentDescription?.toString() ?: "").lowercase()

        if (nodeText.contains(searchText) || nodeDesc.contains(searchText)) {
            return AccessibilityNodeInfo.obtain(root)
        }

        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            val result = findNodeByText(child, searchText)
            if (result != null) {
                child.recycle()
                return result
            }
            child.recycle()
        }
        return null
    }

    // Helper: find editable node near target text
    private fun findEditableNode(root: AccessibilityNodeInfo, target: String): AccessibilityNodeInfo? {
        val nodeText = (root.text?.toString() ?: "").lowercase()
        if (root.isEditable && nodeText.contains(target)) {
            return AccessibilityNodeInfo.obtain(root)
        }
        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            val result = findEditableNode(child, target)
            if (result != null) { child.recycle(); return result }
            child.recycle()
        }
        return null
    }

    // Helper: find focused editable
    private fun findFocusedEditable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (root.isEditable && root.isFocused) return AccessibilityNodeInfo.obtain(root)
        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            val result = findFocusedEditable(child)
            if (result != null) { child.recycle(); return result }
            child.recycle()
        }
        return null
    }

    // Helper: find first editable field
    private fun findFirstEditable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (root.isEditable) return AccessibilityNodeInfo.obtain(root)
        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            val result = findFirstEditable(child)
            if (result != null) { child.recycle(); return result }
            child.recycle()
        }
        return null
    }

    private fun ok(msg: String) = JSONObject().apply { put("ok", true); put("message", msg) }
    private fun error(msg: String) = JSONObject().apply { put("ok", false); put("error", msg) }
}
