package dev.pan.app.ai

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import com.google.mlkit.genai.common.DownloadCallback
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.imagedescription.ImageDescriber
import com.google.mlkit.genai.imagedescription.ImageDescriberOptions
import com.google.mlkit.genai.imagedescription.ImageDescription
import com.google.mlkit.genai.imagedescription.ImageDescriptionRequest
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume

/**
 * NanoVision — on-device image description via ML Kit GenAI (Gemini Nano).
 *
 * Runs the phone's built-in Gemini Nano image-description model so a
 * "take a picture of this / what is this" photo is captioned ON THE PHONE:
 * free, private, no network. Mirrors [GeminiBrain]'s use of the sibling
 * ML Kit GenAI Summarization API (same beta1 family, same Guava
 * ListenableFuture + DownloadCallback surface).
 *
 * The caller (PanForegroundService) tries [describe] first and falls back to
 * the existing server vision path whenever this returns null.
 */
@Singleton
class NanoVision @Inject constructor(
    @ApplicationContext private val context: Context
) {
    companion object {
        private const val TAG = "NanoVision"
    }

    // Lazily created and reused across calls. ML Kit clients are cheap to hold.
    @Volatile private var describer: ImageDescriber? = null

    private fun getOrCreateDescriber(): ImageDescriber {
        return describer ?: synchronized(this) {
            describer ?: ImageDescription.getClient(
                ImageDescriberOptions.builder(context).build()
            ).also { describer = it }
        }
    }

    /**
     * Describe [bitmap] fully on-device via Gemini Nano.
     *
     * Returns the caption string, or null on UNAVAILABLE / any error so the
     * caller can fall back to the server vision path.
     *
     * The ML Kit image-description model is caption-only — it does not take a
     * text prompt — so [question] is ignored (kept in the signature for parity
     * with the server `analyzeImage(base64, question)` path).
     */
    suspend fun describe(bitmap: Bitmap, question: String?): String? {
        return try {
            val client = getOrCreateDescriber()

            val status = client.checkFeatureStatus().await()
            Log.i(TAG, "Image-description feature status: $status")

            when (status) {
                FeatureStatus.UNAVAILABLE -> {
                    Log.w(TAG, "Gemini Nano image description unavailable on this device")
                    return null
                }
                FeatureStatus.DOWNLOADABLE, FeatureStatus.DOWNLOADING -> {
                    Log.i(TAG, "Downloading Gemini Nano image-description feature...")
                    if (!awaitDownload(client)) {
                        Log.w(TAG, "Feature download did not complete — falling back to server")
                        return null
                    }
                }
                FeatureStatus.AVAILABLE -> { /* ready to run inference */ }
                else -> {
                    Log.w(TAG, "Unknown feature status: $status — falling back to server")
                    return null
                }
            }

            if (!question.isNullOrBlank()) {
                Log.i(TAG, "Question ignored (caption-only model): $question")
            }

            val request = ImageDescriptionRequest.builder(bitmap).build()
            // ML Kit streams the caption incrementally; accumulate the chunks and
            // also read the final result's description (whichever is populated).
            val streamed = StringBuilder()
            val result = client.runInference(request) { chunk ->
                streamed.append(chunk)
            }.await()

            val caption = (result?.description?.takeIf { it.isNotBlank() }
                ?: streamed.toString()).trim()

            if (caption.isBlank()) {
                Log.w(TAG, "Empty caption from Nano — falling back to server")
                null
            } else {
                Log.i(TAG, "Nano caption: ${caption.take(100)}")
                caption
            }
        } catch (e: Exception) {
            Log.e(TAG, "NanoVision describe failed: ${e.message}", e)
            null
        }
    }

    /**
     * Bridge ML Kit's DownloadCallback to a coroutine. Resolves true when the
     * Nano feature finishes downloading, false on failure. First-run only —
     * once downloaded the feature reports AVAILABLE immediately.
     */
    private suspend fun awaitDownload(client: ImageDescriber): Boolean =
        suspendCancellableCoroutine { cont ->
            try {
                client.downloadFeature(object : DownloadCallback {
                    override fun onDownloadStarted(bytesToDownload: Long) {
                        Log.i(TAG, "Feature download started: ${bytesToDownload / 1024 / 1024}MB")
                    }
                    override fun onDownloadProgress(totalBytesDownloaded: Long) {
                        Log.i(TAG, "Feature download progress: ${totalBytesDownloaded / 1024 / 1024}MB")
                    }
                    override fun onDownloadCompleted() {
                        Log.i(TAG, "Feature download complete")
                        if (cont.isActive) cont.resume(true)
                    }
                    override fun onDownloadFailed(e: GenAiException) {
                        Log.e(TAG, "Feature download failed: ${e.message}")
                        if (cont.isActive) cont.resume(false)
                    }
                })
            } catch (e: Exception) {
                Log.e(TAG, "downloadFeature threw: ${e.message}")
                if (cont.isActive) cont.resume(false)
            }
        }

    fun close() {
        try { describer?.close() } catch (_: Exception) {}
        describer = null
    }
}
