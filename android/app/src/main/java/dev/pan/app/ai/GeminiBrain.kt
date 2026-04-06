package dev.pan.app.ai

import android.content.Context
import android.util.Log
import com.google.mlkit.genai.common.DownloadCallback
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.summarization.Summarization
import com.google.mlkit.genai.summarization.SummarizationRequest
import com.google.mlkit.genai.summarization.Summarizer
import com.google.mlkit.genai.summarization.SummarizerOptions
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.guava.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * GeminiBrain — uses ML Kit GenAI Summarization API to run on-device
 * classification via Gemini Nano. The summarizer processes text through
 * the on-device model, and we use it to classify voice input.
 *
 * No bundled model needed — uses the phone's built-in Gemini Nano.
 */
@Singleton
class GeminiBrain @Inject constructor(
    @ApplicationContext private val context: Context
) {
    companion object {
        private const val TAG = "GeminiBrain"
    }

    var onLog: ((String) -> Unit)? = null
    private var summarizer: Summarizer? = null
    private var _available = false

    private fun log(msg: String) {
        Log.w(TAG, msg)
        onLog?.invoke(msg)
    }

    fun isAvailable(): Boolean = _available

    suspend fun initialize(): Boolean {
        return try {
            val client = Summarization.getClient(
                SummarizerOptions.builder(context)
                    .setOutputType(SummarizerOptions.OutputType.ONE_BULLET)
                    .build()
            )

            val status = client.checkFeatureStatus().await()
            log("Gemini Nano feature status: $status")

            when (status) {
                FeatureStatus.UNAVAILABLE -> {
                    log("Gemini Nano not available on this device")
                    _available = false
                    return false
                }
                FeatureStatus.DOWNLOADABLE, FeatureStatus.DOWNLOADING -> {
                    log("Gemini Nano model downloading...")
                    client.downloadFeature(object : DownloadCallback {
                        override fun onDownloadStarted(bytesToDownload: Long) {
                            log("Model download started: ${bytesToDownload / 1024 / 1024}MB")
                        }
                        override fun onDownloadProgress(bytesDownloaded: Long) {}
                        override fun onDownloadCompleted() {
                            log("Model download complete")
                            summarizer = client
                            _available = true
                        }
                        override fun onDownloadFailed(e: GenAiException) {
                            log("Model download failed: ${e.message}")
                        }
                    })
                    // Not ready yet — will be available after download
                    return false
                }
                FeatureStatus.AVAILABLE -> {
                    summarizer = client
                    _available = true
                    log("GeminiBrain ready — Gemini Nano on-device")
                    return true
                }
                else -> {
                    log("Unknown feature status: $status")
                    return false
                }
            }
        } catch (e: Exception) {
            log("GeminiBrain init failed: ${e.message}")
            _available = false
            false
        }
    }

    enum class Action { AMBIENT, RESPOND, PHONE_COMMAND, SERVER }
    data class Decision(val action: Action, val response: String?)

    /**
     * Classify voice input using on-device Gemini Nano.
     * We feed the text to the summarizer which processes it through the model.
     * The classification prompt is embedded in the text to guide the model.
     */
    suspend fun evaluate(text: String, history: String): Decision {
        if (!_available || summarizer == null) return Decision(Action.SERVER, null)

        return try {
            // Use the summarizer to classify — the model will summarize our
            // classification prompt + the user's text into a category
            val classifyPrompt = """Voice assistant classification task.
Input: "$text"
Recent context: ${history.take(200)}
Classify as ONE of: AMBIENT (background noise, not talking to assistant), PHONE (local command: time, battery, flashlight, timer, alarm, app, navigation, media, mute), QUERY (question or conversation), RECALL (remembering past conversations).
Answer with just the classification word."""

            val request = SummarizationRequest.builder(classifyPrompt).build()
            val result = StringBuilder()
            summarizer!!.runInference(request) { newText ->
                result.append(newText)
            }.await()

            val classification = result.toString().trim().uppercase()
            log("On-device classify: '$text' -> $classification")

            when {
                classification.contains("AMBIENT") -> Decision(Action.AMBIENT, null)
                classification.contains("PHONE") -> Decision(Action.PHONE_COMMAND, null)
                classification.contains("QUERY") -> Decision(Action.RESPOND, null)
                classification.contains("RECALL") -> Decision(Action.SERVER, null)
                else -> Decision(Action.SERVER, null) // fallback to server
            }
        } catch (e: Exception) {
            log("GeminiBrain classify error: ${e.message}")
            Decision(Action.SERVER, null)
        }
    }

    fun close() {
        try { summarizer?.close() } catch (_: Exception) {}
    }
}
