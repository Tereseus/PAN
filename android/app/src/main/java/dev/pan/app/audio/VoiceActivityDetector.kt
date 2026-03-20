package dev.pan.app.audio

import dev.pan.app.util.Constants

class VoiceActivityDetector {
    private var speechActive = false
    private var silenceFrames = 0
    private val silenceThreshold = 30 // frames of silence before speech "ends" (~2s at 64ms/frame)

    fun isSpeech(rmsLevel: Double): Boolean {
        if (rmsLevel > Constants.VAD_ENERGY_THRESHOLD) {
            speechActive = true
            silenceFrames = 0
            return true
        }

        if (speechActive) {
            silenceFrames++
            if (silenceFrames > silenceThreshold) {
                speechActive = false
                silenceFrames = 0
            }
            return speechActive
        }

        return false
    }

    fun speechJustEnded(rmsLevel: Double): Boolean {
        // Returns true on the frame where speech transitions to silence
        if (!speechActive && silenceFrames == 0 && rmsLevel <= Constants.VAD_ENERGY_THRESHOLD) {
            return false
        }
        return !speechActive && silenceFrames == 0
    }
}
