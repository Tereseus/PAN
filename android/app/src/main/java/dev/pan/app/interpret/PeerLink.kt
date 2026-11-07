package dev.pan.app.interpret

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * The other person's PAN, as text. Each side says the translation on the other person's device, so
 * nothing is spoken out loud in the room as a turn of its own. Test only so far: the far end is
 * service/src/evals/voicebench/peer_person.py on another machine. The wire is plain HTTP on a
 * tunnel, with no sign in and no encryption, so it must never leave the owner's machines as it is.
 */
object PeerLink {
    private const val TAG = "PeerLink"
    @Volatile private var base: String? = null
    val on: Boolean get() = base != null

    /** A line from the far end: what they said, and its language. */
    @Volatile var onLine: ((String, String) -> Unit)? = null

    fun start(url: String) {
        base = url.trimEnd('/')
        thread(name = "peer-link", isDaemon = true) {
            val mine = base
            while (base == mine && mine != null) {
                try {
                    val c = URL("$mine/next").openConnection() as HttpURLConnection
                    c.connectTimeout = 3000
                    c.readTimeout = 30000
                    if (c.responseCode == 200) {
                        val j = JSONObject(c.inputStream.bufferedReader().readText())
                        onLine?.invoke(j.getString("text"), j.getString("lang"))
                    }
                    c.disconnect()
                } catch (e: Exception) {
                    Log.w(TAG, "poll: ${e.message}")
                    Thread.sleep(1000)
                }
            }
        }
        Log.i(TAG, "on: $url")
    }

    fun stop() {
        base = null
        Log.i(TAG, "off")
    }

    /**
     * Hand a line, or a piece of one, to the far end. [say] is already in their language. [heard]
     * is what was said so far, and [final] says the line is over.
     */
    fun send(heard: String, say: String, final: Boolean = true) {
        val to = base ?: return
        thread(name = "peer-send", isDaemon = true) {
            try {
                val c = URL("$to/say").openConnection() as HttpURLConnection
                c.requestMethod = "POST"
                c.doOutput = true
                c.connectTimeout = 3000
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(JSONObject().put("heard", heard).put("say", say).put("final", final).toString().toByteArray()) }
                c.responseCode
                c.disconnect()
            } catch (e: Exception) {
                Log.w(TAG, "send: ${e.message}")
            }
        }
    }
}
