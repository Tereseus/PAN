package dev.pan.app.audio

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.inject.Inject
import javax.inject.Singleton

/**
 * VoiceCollector — records raw audio ONLY when the user is speaking to PAN.
 *
 * Uses a circular buffer that continuously captures mic audio.
 * When STT produces a transcript (onTranscript), we know the user just spoke.
 * At that point, save the last N seconds of buffered audio + the transcript.
 * This guarantees every saved WAV is confirmed user speech, not TV/music/noise.
 *
 * Storage: only saves when you talk. ~1MB per 60s of speech.
 */
@Singleton
class VoiceCollector @Inject constructor(
    @ApplicationContext private val context: Context
) {
    companion object {
        private const val TAG = "VoiceCollector"
        private const val SAMPLE_RATE = 16000
        private const val BUFFER_SECONDS = 15  // Keep last 15 seconds in circular buffer
        private const val BUFFER_SAMPLES = SAMPLE_RATE * BUFFER_SECONDS
        private const val MAX_STORAGE_MB = 500
    }

    private var audioRecord: AudioRecord? = null
    private var recordingJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var isRecording = false
    var onLog: ((String) -> Unit)? = null

    // Circular buffer — always holds the last 15 seconds of audio
    private val circularBuffer = ShortArray(BUFFER_SAMPLES)
    private var writePos = 0
    private var bufferFilled = false // true once we've wrapped around at least once

    private fun log(msg: String) {
        Log.i(TAG, msg)
        onLog?.invoke("[Collector] $msg")
    }

    fun getStorageDir(): File {
        val dir = File(context.filesDir, "voice_training")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    /**
     * Called when STT produces a final transcript.
     * This means the user JUST spoke. Save the buffered audio + transcript.
     */
    fun onTranscript(text: String) {
        if (text.isBlank()) return
        if (!isRecording) return

        // Snapshot the circular buffer
        val audioSnapshot: ShortArray
        val length: Int

        synchronized(circularBuffer) {
            if (bufferFilled) {
                // Buffer has wrapped — copy from writePos to end, then start to writePos
                length = BUFFER_SAMPLES
                audioSnapshot = ShortArray(length)
                val firstPart = BUFFER_SAMPLES - writePos
                System.arraycopy(circularBuffer, writePos, audioSnapshot, 0, firstPart)
                System.arraycopy(circularBuffer, 0, audioSnapshot, firstPart, writePos)
            } else {
                // Buffer hasn't wrapped yet — copy from start to writePos
                length = writePos
                if (length < SAMPLE_RATE) return // Less than 1 second, skip
                audioSnapshot = ShortArray(length)
                System.arraycopy(circularBuffer, 0, audioSnapshot, 0, length)
            }
        }

        // Save to disk in background
        scope.launch {
            try {
                val timestamp = System.currentTimeMillis()
                val dir = getStorageDir()
                val wavFile = File(dir, "voice_${timestamp}.wav")
                val txtFile = File(dir, "voice_${timestamp}.txt")

                writeWav(wavFile, audioSnapshot, length)
                txtFile.writeText(text)

                val seconds = length / SAMPLE_RATE.toFloat()
                log("Saved ${String.format("%.1f", seconds)}s of confirmed speech: ${text.take(50)}")

                cleanIfNeeded()
            } catch (e: Exception) {
                log("Save failed: ${e.message}")
            }
        }
    }

    fun getStats(): CollectionStats {
        val dir = getStorageDir()
        val wavFiles = dir.listFiles { f -> f.extension == "wav" } ?: emptyArray()
        val txtFiles = dir.listFiles { f -> f.extension == "txt" } ?: emptyArray()
        val totalBytes = wavFiles.sumOf { it.length() }
        val totalSeconds = wavFiles.sumOf { f ->
            try {
                val size = f.length() - 44 // WAV header
                (size / 2 / SAMPLE_RATE).toInt()
            } catch (_: Exception) { 0 }
        }
        return CollectionStats(
            segmentCount = wavFiles.size,
            pairedCount = txtFiles.size,
            totalMinutes = totalSeconds / 60.0,
            storageMB = totalBytes / (1024.0 * 1024.0)
        )
    }

    @SuppressLint("MissingPermission")
    fun start() {
        if (isRecording) return

        recordingJob = scope.launch {
            val bufferSize = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )

            try {
                // Use CAMCORDER source — uses a different mic than STT's VOICE_RECOGNITION
                // This allows both to coexist on devices with multiple mics
                val source = MediaRecorder.AudioSource.CAMCORDER

                audioRecord = AudioRecord(
                    source,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    maxOf(bufferSize * 2, BUFFER_SAMPLES * 2)
                )

                if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                    log("AudioRecord init failed — mic might be busy")
                    return@launch
                }

                audioRecord?.startRecording()
                isRecording = true
                writePos = 0
                bufferFilled = false
                log("Circular buffer recording started (saves only on speech)")

                val readBuffer = ShortArray(1024)

                while (isActive) {
                    val read = audioRecord?.read(readBuffer, 0, readBuffer.size) ?: -1
                    if (read <= 0) {
                        delay(10)
                        continue
                    }

                    // Write to circular buffer
                    synchronized(circularBuffer) {
                        for (i in 0 until read) {
                            circularBuffer[writePos] = readBuffer[i]
                            writePos++
                            if (writePos >= BUFFER_SAMPLES) {
                                writePos = 0
                                bufferFilled = true
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                log("Recording error: ${e.message}")
            } finally {
                try { audioRecord?.stop() } catch (_: Exception) {}
                try { audioRecord?.release() } catch (_: Exception) {}
                audioRecord = null
                isRecording = false
                log("Recording stopped")
            }
        }
    }

    fun stop() {
        recordingJob?.cancel()
        recordingJob = null
    }

    private fun writeWav(file: File, samples: ShortArray, length: Int) {
        val byteLength = length * 2
        val fos = FileOutputStream(file)

        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray())
        header.putInt(36 + byteLength)
        header.put("WAVE".toByteArray())
        header.put("fmt ".toByteArray())
        header.putInt(16)
        header.putShort(1) // PCM
        header.putShort(1) // mono
        header.putInt(SAMPLE_RATE)
        header.putInt(SAMPLE_RATE * 2)
        header.putShort(2)
        header.putShort(16)
        header.put("data".toByteArray())
        header.putInt(byteLength)

        fos.write(header.array())

        val byteBuffer = ByteBuffer.allocate(byteLength).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until length) {
            byteBuffer.putShort(samples[i])
        }
        fos.write(byteBuffer.array())
        fos.close()
    }

    private fun cleanIfNeeded() {
        val dir = getStorageDir()
        val files = dir.listFiles() ?: return
        val totalMB = files.sumOf { it.length() } / (1024.0 * 1024.0)

        if (totalMB > MAX_STORAGE_MB) {
            val wavFiles = files.filter { it.extension == "wav" }.sortedBy { it.lastModified() }
            var freed = 0.0
            for (f in wavFiles) {
                if (freed > totalMB - MAX_STORAGE_MB * 0.8) break
                val txtFile = File(f.path.replace(".wav", ".txt"))
                freed += f.length() / (1024.0 * 1024.0)
                f.delete()
                txtFile.delete()
            }
            log("Cleaned ${String.format("%.1f", freed)}MB of old recordings")
        }
    }

    data class CollectionStats(
        val segmentCount: Int,
        val pairedCount: Int,
        val totalMinutes: Double,
        val storageMB: Double
    )
}
