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
import android.view.accessibility.AccessibilityWindowInfo
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
        // Was hardcoded to the hub's old Dell address (192.168.1.248), dead since the hub
        // moved to the mini PC. Now whatever HubLocator found; skip the poll until then.
        private val PAN_SERVER: String? get() = dev.pan.app.network.HubLocator.current
        private const val POLL_INTERVAL = 2000L

        // Static reference so the foreground service can call methods directly
        var instance: PanAccessibilityService? = null

        /** This device as the hub knows it: the same id every other request carries (X-Device-Id). */
        val hubDeviceId: String get() = android.os.Build.MODEL.lowercase().replace(" ", "-")
    }

    /** Why the last poll got nothing, logged once per change so a dead link is visible in the log. */
    private var pollState = ""
    private fun note(state: String) {
        if (state != pollState) { pollState = state; Log.i(TAG, "screen control poll: $state") }
    }

    /** The hub hands a device only its own commands, so every request says which device this is. */
    private fun open(path: String): HttpURLConnection {
        val conn = URL(path).openConnection() as HttpURLConnection
        conn.connectTimeout = 5000
        conn.readTimeout = 5000
        conn.setRequestProperty("X-Device-Name", dev.pan.app.di.DeviceNameHolder.name)
        conn.setRequestProperty("X-Device-Id", hubDeviceId)
        return conn
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
                val hub = PAN_SERVER
                if (hub == null) { note("no hub address yet"); delay(POLL_INTERVAL); continue }
                val conn = open("$hub/api/v1/accessibility/commands?device=" + java.net.URLEncoder.encode(hubDeviceId, "UTF-8"))
                val code = conn.responseCode
                note(if (code == 200) "ok, asking $hub as $hubDeviceId" else "the hub answered $code at $hub")

                if (code == 200) {
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
            } catch (e: Exception) { note("failed: ${e.javaClass.simpleName} ${e.message}") }

            delay(POLL_INTERVAL)
        }
    }

    private fun sendResult(id: String, result: JSONObject) {
        try {
            val hub = PAN_SERVER ?: return
            val conn = open("$hub/api/v1/accessibility/result")
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
                "press_enter" -> pressEnter(cmd.optString("target"))
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
            // A web page in a browser sits 15 to 25 levels down; at 10 only the browser's own tabs were read.
            if (depth > 40) return

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
                    // A checkbox or a switch: without this a read cannot tell ticked from not ticked.
                    if (node.isCheckable) { put("checkable", true); put("checked", node.isChecked) }
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
            put("elements", JSONArray(elements.take(150)))
            put("element_count", elements.size)
        }
    }

    // Tap on an element by text match or coordinates
    fun tap(text: String, x: Int, y: Int): JSONObject {
        if (x >= 0 && y >= 0) {
            // Tap by coordinates; a keyboard over that spot goes away first (see below).
            if (keyboardRect()?.contains(x, y) == true) hideKeyboard()
            return performTap(x.toFloat(), y.toFloat())
        }

        if (text.isBlank()) return error("No text or coordinates")
        // A keyboard left up after typing covers the bottom of the screen: in testing a tap meant
        // for "Go to checkout" typed a space instead. Put it away before looking for the target,
        // so the target's place is read after the page has settled.
        if (keyboardRect() != null) hideKeyboard()

        // Find element by text and tap it
        val root = rootInActiveWindow ?: return error("No active window")
        // An element named exactly this wins over one that only contains it ("Add Event" must not
        // hit an "Add Event +" button behind a dialog).
        // Order: named exactly this and on screen; then a visible label that contains it (never
        // the text inside a box: "17" must not hit an address bar showing "localhost:5174"); then
        // named exactly this but off screen, which is scrolled to or reported below.
        val want = text.trim().lowercase()
        val target = findNodeByExactText(root, want, true) ?: findNodeByText(root, text.lowercase())
            ?: findNodeByExactText(root, want, false)
        root.recycle()

        if (target != null) {
            val rect = Rect()
            target.getBoundsInScreen(rect)
            val inView = { r: Rect -> !r.isEmpty && r.centerX() >= 0 && r.centerY() >= 0 &&
                r.centerX() < resources.displayMetrics.widthPixels && r.centerY() < resources.displayMetrics.heightPixels }
            // Off screen (a date picker that opens below the bottom edge): scroll it into view
            // first, the way a person would, then read where it is now.
            if (!inView(rect)) {
                target.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
                Thread.sleep(600)
                target.refresh()
                target.getBoundsInScreen(rect)
            }

            // In a web page a real finger tap is what works: many web apps open their lists and
            // pick dates on pointer events, which an accessibility click never sends (found on
            // real open source apps, Nov 20 2026). So a web element that is on screen gets a tap
            // at its centre. Elsewhere, and for a web element scrolled off screen, click it.
            val onScreen = inView(rect)
            val web = isInWebPage(target)
            // A web element that stays off screen: a click there lands wherever the browser puts
            // it (it closed a whole dialog in testing). Say so, so the caller can type or scroll.
            if (web && !onScreen) {
                target.recycle()
                return error("It is off screen and would not scroll into view: $text")
            }
            if (target.isClickable && !web) {
                val done = target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                target.recycle()
                if (done) return ok("Tapped: $text")
                if (!onScreen) return error("The element did not take the tap: $text")
                return performTap(rect.centerX().toFloat(), rect.centerY().toFloat())
            }

            target.recycle()
            if (!onScreen) return error("Element is off screen: $text")
            return performTap(rect.centerX().toFloat(), rect.centerY().toFloat())
        }

        return error("Element not found: $text")
    }

    // Type text into the focused field or a field matching target text
    fun typeText(text: String, target: String): JSONObject {
        val root = rootInActiveWindow ?: return error("No active window")

        var editNode: AccessibilityNodeInfo? = null

        // A named field must be found, never swapped for another: in testing a missed field sent
        // the text to the browser's address bar, which would search it. Unnamed: the field that
        // has focus, nothing else.
        if (target.isNotBlank()) {
            editNode = findFieldFor(root, target.lowercase())
            if (editNode == null) { root.recycle(); return error("No field called: $target") }
        } else {
            editNode = findFocusedEditable(root)
        }

        root.recycle()

        if (editNode != null) {
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            // Focus first, so a following press_enter goes to this field.
            editNode.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            editNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            editNode.recycle()
            return ok("Typed: $text")
        }

        return error("No editable field found")
    }

    // The keyboard's Enter (Go, Search, Done) on a field: the one named, else the focused one, else the first.
    fun pressEnter(target: String): JSONObject {
        val root = rootInActiveWindow ?: return error("No active window")
        var editNode: AccessibilityNodeInfo? = null
        // Same rule as typing: the named field or the focused one, never a guess (Enter in a
        // browser's address bar would open a search).
        editNode = if (target.isNotBlank()) findFieldFor(root, target.lowercase()) else findFocusedEditable(root)
        root.recycle()
        if (editNode == null) return error(if (target.isNotBlank()) "No field called: $target" else "No field has focus")
        val done = editNode.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
        editNode.recycle()
        return if (done) ok("Pressed enter") else error("The field did not take enter")
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

    // Helper: where the on-screen keyboard is, or null when none is up.
    private fun keyboardRect(): Rect? {
        for (w in windows) {
            if (w.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return Rect().also { w.getBoundsInScreen(it) }
        }
        return null
    }

    private fun hideKeyboard() {
        performGlobalAction(GLOBAL_ACTION_BACK)   // with a keyboard up, back only closes the keyboard
        Thread.sleep(500)
    }

    // Helper: is this node part of a web page (a browser's or an app's web view)?
    private fun isInWebPage(node: AccessibilityNodeInfo): Boolean {
        var p: AccessibilityNodeInfo? = node.parent
        var depth = 0
        while (p != null && depth < 80) {
            if (p.className?.toString()?.contains("WebView") == true) { p.recycle(); return true }
            val up = p.parent
            p.recycle()
            p = up
            depth++
        }
        return false
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
    private fun findNodeByExactText(root: AccessibilityNodeInfo, searchText: String, visibleOnly: Boolean): AccessibilityNodeInfo? {
        val nodeText = (root.text?.toString() ?: "").trim().lowercase()
        val nodeDesc = (root.contentDescription?.toString() ?: "").trim().lowercase()
        if ((nodeText == searchText || nodeDesc == searchText) && !root.isEditable && (root.isVisibleToUser || !visibleOnly)) return AccessibilityNodeInfo.obtain(root)
        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            val result = findNodeByExactText(child, searchText, visibleOnly)
            child.recycle()
            if (result != null) return result
        }
        return null
    }

    private fun findNodeByText(root: AccessibilityNodeInfo, searchText: String): AccessibilityNodeInfo? {
        val nodeText = (root.text?.toString() ?: "").lowercase()
        val nodeDesc = (root.contentDescription?.toString() ?: "").lowercase()

        // Only what the person could see: a closed pop-up can stay in the tree, hidden.
        if ((nodeText.contains(searchText) || nodeDesc.contains(searchText)) && root.isVisibleToUser && !root.isEditable) {
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
    /**
     * The box a person means by `target`. Web pages often hide a box's grey hint text from
     * accessibility (Chrome does), so: a box whose own text or hint holds it; else the nearest box
     * just below or beside a visible label holding it; else the only box on the web page.
     */
    private fun findFieldFor(root: AccessibilityNodeInfo, target: String): AccessibilityNodeInfo? {
        findEditableNode(root, target)?.let { return it }
        val boxes = mutableListOf<AccessibilityNodeInfo>()
        val labels = mutableListOf<Rect>()
        fun walk(n: AccessibilityNodeInfo) {
            if (n.isVisibleToUser) {
                if (n.isEditable) boxes.add(AccessibilityNodeInfo.obtain(n))
                else {
                    val t = ((n.text?.toString() ?: "") + " " + (n.contentDescription?.toString() ?: "")).lowercase()
                    if (t.contains(target)) labels.add(Rect().also { n.getBoundsInScreen(it) })
                }
            }
            for (i in 0 until n.childCount) { val c = n.getChild(i) ?: continue; walk(c); c.recycle() }
        }
        walk(root)
        var best: AccessibilityNodeInfo? = null
        var bestD = Int.MAX_VALUE
        for (b in boxes) {
            val r = Rect().also { b.getBoundsInScreen(it) }
            for (l in labels) {
                val below = r.top >= l.top && r.top - l.bottom < 250 && r.left < l.right + 40 && r.right > l.left - 40
                val beside = r.left >= l.right - 10 && r.left - l.right < 400 && Math.abs(r.centerY() - l.centerY()) < 60
                if (!below && !beside) continue
                val d = Math.abs(r.top - l.bottom) + Math.abs(r.left - l.left)
                if (d < bestD) { bestD = d; best = b }
            }
        }
        if (best == null) {
            val web = boxes.filter { isInWebPage(it) }
            if (web.size == 1) best = web[0]
        }
        for (b in boxes) if (b !== best) b.recycle()
        return best
    }

    private fun findEditableNode(root: AccessibilityNodeInfo, target: String): AccessibilityNodeInfo? {
        val nodeText = (root.text?.toString() ?: "").lowercase()
        val hint = (root.hintText?.toString() ?: "").lowercase()
        if (root.isEditable && (nodeText.contains(target) || hint.contains(target))) {
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

    private fun ok(msg: String) = JSONObject().apply { put("ok", true); put("message", msg) }
    private fun error(msg: String) = JSONObject().apply { put("ok", false); put("error", msg) }
}
