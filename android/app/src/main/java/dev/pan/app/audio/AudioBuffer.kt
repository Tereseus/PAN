package dev.pan.app.audio

class AudioBuffer(private val maxSeconds: Int = 30, private val sampleRate: Int = 16000) {
    private val maxSamples = maxSeconds * sampleRate
    private val buffer = ShortArray(maxSamples)
    private var writePos = 0
    private var hasData = false

    @Synchronized
    fun write(data: ShortArray, size: Int) {
        for (i in 0 until size) {
            buffer[writePos % maxSamples] = data[i]
            writePos++
        }
        hasData = true
    }

    @Synchronized
    fun drain(): ShortArray {
        if (!hasData) return ShortArray(0)

        val length = minOf(writePos, maxSamples)
        val result = ShortArray(length)

        if (writePos <= maxSamples) {
            System.arraycopy(buffer, 0, result, 0, length)
        } else {
            val start = writePos % maxSamples
            val firstPart = maxSamples - start
            System.arraycopy(buffer, start, result, 0, firstPart)
            System.arraycopy(buffer, 0, result, firstPart, start)
        }

        writePos = 0
        hasData = false
        return result
    }
}
