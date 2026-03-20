package dev.pan.app.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import dev.pan.app.data.DataRepository
import dev.pan.app.util.Constants
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.sqrt

@Singleton
class AudioCaptureManager @Inject constructor(
    private val dataRepository: DataRepository
) {
    companion object {
        private const val TAG = "AudioCapture"
    }

    private var audioRecord: AudioRecord? = null
    private var captureJob: Job? = null
    private val _audioLevel = MutableStateFlow(0.0)
    val audioLevel: StateFlow<Double> = _audioLevel
    private val _isCapturing = MutableStateFlow(false)
    val isCapturing: StateFlow<Boolean> = _isCapturing

    private val vad = VoiceActivityDetector()
    private val buffer = AudioBuffer()

    @SuppressLint("MissingPermission")
    fun start() {
        if (_isCapturing.value) return

        val bufferSize = AudioRecord.getMinBufferSize(
            Constants.SAMPLE_RATE,
            Constants.CHANNEL_CONFIG,
            Constants.AUDIO_ENCODING
        )

        audioRecord = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            Constants.SAMPLE_RATE,
            Constants.CHANNEL_CONFIG,
            Constants.AUDIO_ENCODING,
            bufferSize * 2
        )

        if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord failed to initialize")
            return
        }

        audioRecord?.startRecording()
        _isCapturing.value = true
        Log.i(TAG, "Audio capture started (${Constants.SAMPLE_RATE}Hz)")

        captureJob = CoroutineScope(Dispatchers.IO).launch {
            val readBuffer = ShortArray(bufferSize / 2)

            while (isActive && _isCapturing.value) {
                val read = audioRecord?.read(readBuffer, 0, readBuffer.size) ?: -1
                if (read > 0) {
                    val level = calculateRmsLevel(readBuffer, read)
                    _audioLevel.value = level

                    buffer.write(readBuffer, read)

                    if (vad.isSpeech(level)) {
                        // Speech detected — the buffer accumulates
                        // When speech ends, we'll extract and send to STT
                    }

                    if (vad.speechJustEnded(level)) {
                        val audioData = buffer.drain()
                        if (audioData.isNotEmpty()) {
                            // Save transcript placeholder — STT will fill this in
                            dataRepository.saveAudioSegment(audioData)
                            Log.d(TAG, "Speech segment captured: ${audioData.size} samples")
                        }
                    }
                }
            }
        }
    }

    fun stop() {
        _isCapturing.value = false
        captureJob?.cancel()
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        Log.i(TAG, "Audio capture stopped")
    }

    private fun calculateRmsLevel(buffer: ShortArray, size: Int): Double {
        var sum = 0.0
        for (i in 0 until size) {
            sum += buffer[i] * buffer[i]
        }
        return sqrt(sum / size)
    }
}
