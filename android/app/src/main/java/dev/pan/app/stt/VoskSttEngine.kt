package dev.pan.app.stt

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.*
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.StorageService
import org.json.JSONObject
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class VoskSttEngine @Inject constructor(
    @ApplicationContext private val context: Context
) : SttEngine {

    companion object {
        private const val TAG = "VoskSTT"
        private const val SAMPLE_RATE = 16000
    }

    private var model: Model? = null
    private var recognizer: Recognizer? = null
    private var audioRecord: AudioRecord? = null
    private var recordingJob: Job? = null
    private var callback: ((String, Boolean) -> Unit)? = null
    private var _enabled = true

    override var isListening: Boolean = false
        private set

    var enabled: Boolean
        get() = _enabled
        set(value) {
            _enabled = value
            if (!value) stopListening()
        }

    // Initialize Vosk model
    suspend fun initialize() {
        if (model != null) return

        try {
            Log.i(TAG, "Loading Vosk model...")

            val modelDir = java.io.File(context.filesDir, "vosk-model")

            if (modelDir.exists() && modelDir.listFiles()?.isNotEmpty() == true) {
                // Model already downloaded
                model = Model(modelDir.absolutePath)
                Log.i(TAG, "Vosk model loaded from cache")
            } else {
                // Download model
                Log.i(TAG, "Downloading Vosk model (first time, ~50MB)...")
                val completable = CompletableDeferred<Model>()

                StorageService.unpack(context, "model-en-us", "model",
                    { loadedModel ->
                        Log.i(TAG, "Vosk model downloaded and loaded")
                        completable.complete(loadedModel)
                    },
                    { error ->
                        Log.e(TAG, "Vosk model download failed: $error")
                        completable.completeExceptionally(Exception(error.message))
                    }
                )

                model = completable.await()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to init Vosk: ${e.message}")
        }
    }

    @SuppressLint("MissingPermission")
    override fun startListening(onResult: (String, Boolean) -> Unit) {
        if (!_enabled) return
        callback = onResult

        recordingJob = CoroutineScope(Dispatchers.IO).launch {
            // Init model if needed
            initialize()

            if (model == null) {
                Log.e(TAG, "No model available")
                return@launch
            }

            recognizer = Recognizer(model, SAMPLE_RATE.toFloat())

            val bufferSize = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )

            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize * 2
            )

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "AudioRecord failed to init")
                return@launch
            }

            audioRecord?.startRecording()
            isListening = true
            Log.i(TAG, "Vosk listening started")

            val buffer = ByteArray(bufferSize)

            while (isActive && _enabled) {
                val read = audioRecord?.read(buffer, 0, buffer.size) ?: -1
                if (read <= 0) continue

                if (recognizer?.acceptWaveForm(buffer, read) == true) {
                    // Final result for this utterance
                    val json = recognizer?.result ?: continue
                    val text = parseText(json)
                    if (text.isNotBlank()) {
                        Log.i(TAG, "Final: $text")
                        withContext(Dispatchers.Main) {
                            callback?.invoke(text, true)
                        }
                    }
                } else {
                    // Partial result
                    val json = recognizer?.partialResult ?: continue
                    val text = parsePartial(json)
                    if (text.isNotBlank()) {
                        withContext(Dispatchers.Main) {
                            callback?.invoke(text, false)
                        }
                    }
                }
            }

            audioRecord?.stop()
            audioRecord?.release()
            audioRecord = null
            recognizer?.close()
            recognizer = null
            isListening = false
        }
    }

    override fun stopListening() {
        recordingJob?.cancel()
        recordingJob = null
        isListening = false
    }

    fun destroy() {
        stopListening()
        model?.close()
        model = null
    }

    private fun parseText(json: String): String {
        return try {
            JSONObject(json).optString("text", "")
        } catch (e: Exception) { "" }
    }

    private fun parsePartial(json: String): String {
        return try {
            JSONObject(json).optString("partial", "")
        } catch (e: Exception) { "" }
    }
}
