package dev.pan.app.stt

import kotlinx.coroutines.flow.MutableStateFlow

/**
 * What the phone is hearing right now, word by word, before the line is finished.
 * The box at the bottom of Home shows it, so he sees his line before it goes.
 * Empty when nobody is talking, and while PAN itself is talking.
 */
object LiveWords {
    val text = MutableStateFlow("")
}
