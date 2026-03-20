package dev.pan.app.audio

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.*
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.inject.Inject
import javax.inject.Singleton

/**
 * VoiceCollector — silently records raw audio alongside Google STT.
 *
 * Saves audio in 30-second WAV segments to local storage.
 * Each segment gets paired with its transcript (from STT) for voice training.
 * Runs continuously while STT is active. Files are stored locally and
 * synced to the PAN server during off-hours for training.
 *
 * Storage: ~1MB per minute of 16kHz mono audio. 8 hours = ~480MB.
 * Old segments are auto-cleaned after training data is extracted.
 */
@Singleton
class VoiceCollector @Inject constructor(
    @ApplicationContext private val context: Context
) {
    companion object {
        private const val TAG = "VoiceCollector"
        private const val SAMPLE_RATE = 16000
        private const val SEGMENT_SECONDS = 30
        private const val SEGMENT_SAMPLES = SAMPLE_RATE * SEGMENT_SECONDS
        private const val MAX_STORAGE_MB = 500 // Auto-clean when exceeding this
    }

    private var audioRecord: AudioRecord? = null
    private var recordingJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var isRecording = false
    var onLog: ((String) -> Unit)? = null

    // Transcript pairs: timestamp -> transcript text
    private val transcriptBuffer = mutableMapOf<Long, String>()

    private fun log(msg: String) {
        Log.i(TAG, msg)
        onLog?.invoke("[Collector] $msg")
    }

    fun getStorageDir(): File {
        val dir = File(context.filesDir, "voice_training")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    // Call this when STT produces a final transcript — pairs audio with text
    fun onTranscript(text: String) {
        if (text.isBlank()) return
        transcriptBuffer[System.currentTimeMillis()] = text
    }

    // Get stats about collected data
    fun getStats(): CollectionStats {
        val dir = getStorageDir()
        val wavFiles = dir.listFiles { f -> f.extension == "wav" } ?: emptyArray()
        val txtFiles = dir.listFiles { f -> f.extension == "txt" } ?: emptyArray()
        val totalBytes = wavFiles.sumOf { it.length() }
        val totalSeconds = wavFiles.size * SEGMENT_SECONDS
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
                audioRecord = AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    maxOf(bufferSize * 2, SEGMENT_SAMPLES * 2)
                )

                if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                    log("AudioRecord init failed")
                    return@launch
                }

                audioRecord?.startRecording()
                isRecording = true
                log("Recording started for voice collection")

                while (isActive) {
                    // Record one segment
                    val segment = ShortArray(SEGMENT_SAMPLES)
                    var pos = 0

                    while (pos < SEGMENT_SAMPLES && isActive) {
                        val read = audioRecord?.read(segment, pos, minOf(1024, SEGMENT_SAMPLES - pos)) ?: -1
                        if (read < 0) break
                        pos += read
                    }

                    if (pos >= SEGMENT_SAMPLES / 2) { // At least half a segment
                        saveSegment(segment, pos)
                    }

                    // Clean old files if storage is too high
                    cleanIfNeeded()
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

    private fun saveSegment(samples: ShortArray, length: Int) {
        try {
            val timestamp = System.currentTimeMillis()
            val dir = getStorageDir()
            val wavFile = File(dir, "voice_${timestamp}.wav")

            // Write WAV file
            writeWav(wavFile, samples, length)

            // Check if we have transcripts that overlap with this segment's timeframe
            val segmentStart = timestamp - (SEGMENT_SECONDS * 1000)
            val matchingTranscripts = transcriptBuffer.filter { (ts, _) ->
                ts in segmentStart..timestamp
            }

            if (matchingTranscripts.isNotEmpty()) {
                val txtFile = File(dir, "voice_${timestamp}.txt")
                val combined = matchingTranscripts.values.joinToString(" | ")
                txtFile.writeText(combined)

                // Clean matched transcripts
                matchingTranscripts.keys.forEach { transcriptBuffer.remove(it) }

                log("Saved paired segment: ${length / SAMPLE_RATE}s audio + transcript")
            } else {
                log("Saved audio segment: ${length / SAMPLE_RATE}s (no transcript)")
            }

            // Keep transcript buffer from growing forever
            if (transcriptBuffer.size > 100) {
                val cutoff = System.currentTimeMillis() - 300_000 // 5 min
                transcriptBuffer.keys.removeAll { it < cutoff }
            }
        } catch (e: Exception) {
            log("Save failed: ${e.message}")
        }
    }

    private fun writeWav(file: File, samples: ShortArray, length: Int) {
        val byteLength = length * 2
        val fos = FileOutputStream(file)

        // WAV header
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray())
        header.putInt(36 + byteLength)
        header.put("WAVE".toByteArray())
        header.put("fmt ".toByteArray())
        header.putInt(16) // chunk size
        header.putShort(1) // PCM
        header.putShort(1) // mono
        header.putInt(SAMPLE_RATE)
        header.putInt(SAMPLE_RATE * 2) // byte rate
        header.putShort(2) // block align
        header.putShort(16) // bits per sample
        header.put("data".toByteArray())
        header.putInt(byteLength)

        fos.write(header.array())

        // Audio data
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
            // Delete oldest unpaired audio files first, then oldest paired
            val wavFiles = files.filter { it.extension == "wav" }.sortedBy { it.lastModified() }
            var freed = 0.0
            for (f in wavFiles) {
                if (freed > totalMB - MAX_STORAGE_MB * 0.8) break
                val txtFile = File(f.path.replace(".wav", ".txt"))
                // Delete unpaired first
                if (!txtFile.exists()) {
                    freed += f.length() / (1024.0 * 1024.0)
                    f.delete()
                }
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
