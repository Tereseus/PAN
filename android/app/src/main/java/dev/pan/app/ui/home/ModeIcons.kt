package dev.pan.app.ui.home

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * The five listening-mode pictures on the mic button (audio/ListenMode.kt), one set on a 960 grid.
 * Microphone, crossed microphone and ear are Google's Material Symbols, Rounded, weight 400
 * (Apache 2.0, github.com/google/material-design-icons). Π (Name only) and the hat with glasses
 * (Don't remember) are our own, drawn on the same grid in the same weight.
 */
object ModeIcons {
    // Material Symbols use a viewBox of 0 -960 960 960: shifted down by 960 here.
    private const val MIC = "M480-400q-50 0-85-35t-35-85v-240q0-50 35-85t85-35q50 0 85 35t35 85v240q0 50-35 85t-85 35Zm0-240Zm-40 480v-83q-92-13-157.5-78T203-479q-2-17 9-29t28-12q17 0 28.5 11.5T284-480q14 70 69.5 115T480-320q72 0 127-45.5T676-480q4-17 15.5-28.5T720-520q17 0 28 12t9 29q-14 91-79 157t-158 79v83q0 17-11.5 28.5T480-120q-17 0-28.5-11.5T440-160Zm40-320q17 0 28.5-11.5T520-520v-240q0-17-11.5-28.5T480-800q-17 0-28.5 11.5T440-760v240q0 17 11.5 28.5T480-480Z"
    private const val MIC_OFF = "M672-377q-14-8-18-24.5t4-30.5q7-11 11.5-23.5T676-481q4-17 15.5-28t28.5-11q17 0 28 12t9 29q-3 23-10.5 45T727-392q-8 14-24.5 18.5T672-377ZM480-594Zm0-286q50 0 85 35t35 85v190q0 20-12.5 30T560-530q-15 0-27.5-10.5T520-571v-189q0-17-11.5-28.5T480-800q-17 0-28.5 11.5T440-760v30q0 20-12.5 30T400-690q-15 0-27.5-10.5T360-731v-29q0-50 35-85t85-35Zm-40 720v-83q-92-12-157.5-77.5T203-479q-2-17 9-29t28-12q17 0 29 11.5t15 28.5q14 71 69 115.5T480-320q34 0 64.5-10.5T600-360l57 57q-29 23-63.5 39T520-243v83q0 17-11.5 28.5T480-120q-17 0-28.5-11.5T440-160Zm324 76L84-764q-11-11-11-28t11-28q11-11 28-11t28 11l680 680q11 11 11 28t-11 28q-11 11-28 11t-28-11Z"
    private const val HEARING = "M200-600q0 63 20.5 119.5T278-377q11 14 11 30.5T277-318q-13 12-30 10.5T219-323q-46-57-72.5-128T120-600q0-80 26.5-151T219-879q11-14 28-15.5t30 10.5q12 12 12 28.5T278-825q-37 47-57.5 104T200-600Zm360 100q-42 0-71-29.5T460-600q0-42 29-71t71-29q42 0 71 29t29 71q0 41-29 70.5T560-500Zm200 260q0-17 11.5-28.5T800-280q17 0 28.5 11.5T840-240q0 66-47 113T680-80q-62 0-101.5-31T518-202q-17-50-32.5-70T414-336q-62-50-98-113t-36-151q0-119 80.5-199.5T560-880q119 0 199.5 80.5T840-600q0 17-11.5 28.5T800-560q-17 0-28.5-11.5T760-600q0-85-57.5-142.5T560-800q-85 0-142.5 57.5T360-600q0 68 27 116t77 86q52 38 81 74t43 78q14 44 33.5 65t58.5 21q33 0 56.5-23.5T760-240Z"

    // Ours, on the plain 0..960 grid. Π: a bar and two legs, 80 wide, rounded like the symbols.
    private const val PI = "M240,200 H720 Q760,200 760,240 Q760,280 720,280 H240 Q200,280 200,240 Q200,200 240,200 Z " +
        "M320,240 Q360,240 360,280 V760 Q360,800 320,800 Q280,800 280,760 V280 Q280,240 320,240 Z " +
        "M640,240 Q680,240 680,280 V760 Q680,800 640,800 Q600,800 600,760 V280 Q600,240 640,240 Z"
    // A plain hat (crown with a dent, curved brim) over a pair of round glasses: the generic
    // "someone you can't make out" figure, drawn here, not taken from any other icon.
    private const val HAT = "M260,430 L305,225 Q315,185 355,195 Q480,235 605,195 Q645,185 655,225 L700,430 Z " +
        "M130,440 Q480,515 830,440 Q860,434 862,460 Q864,484 828,496 Q480,585 132,496 Q96,484 98,460 Q100,434 130,440 Z"
    private const val GLASSES = "M200,700 A130,130 0 1,0 460,700 A130,130 0 1,0 200,700 Z " +
        "M500,700 A130,130 0 1,0 760,700 A130,130 0 1,0 500,700 Z"
    private const val BRIDGE = "M440,672 H520 V728 H440 Z"
    private const val GLASS_HOLES = "M270,700 A60,60 0 1,0 390,700 A60,60 0 1,0 270,700 Z " +
        "M570,700 A60,60 0 1,0 690,700 A60,60 0 1,0 570,700 Z"

    private fun icon(name: String, vararg paths: Pair<String, Boolean>, shift: Boolean = false): ImageVector {
        val b = ImageVector.Builder(name, 24.dp, 24.dp, 960f, 960f)
        b.addGroup(translationY = if (shift) 960f else 0f)
        for ((d, holes) in paths) {
            b.addPath(PathParser().parsePathString(d).toNodes(), fill = SolidColor(Color.Black),
                pathFillType = if (holes) PathFillType.EvenOdd else PathFillType.NonZero)
        }
        b.clearGroup()
        return b.build()
    }

    val Mic: ImageVector by lazy { icon("mic", MIC to false, shift = true) }
    val MicOff: ImageVector by lazy { icon("mic_off", MIC_OFF to false, shift = true) }
    val Hearing: ImageVector by lazy { icon("hearing", HEARING to false, shift = true) }
    val Pi: ImageVector by lazy { icon("pi", PI to false) }
    fun of(m: dev.pan.app.audio.ListenMode.Mode): ImageVector = when (m) {
        dev.pan.app.audio.ListenMode.Mode.NORMAL -> Mic
        dev.pan.app.audio.ListenMode.Mode.LISTEN -> Hearing
        dev.pan.app.audio.ListenMode.Mode.NAME -> Pi
        dev.pan.app.audio.ListenMode.Mode.FORGET -> Incognito
    }
    val Incognito: ImageVector by lazy { icon("incognito", HAT to false, "$GLASSES $GLASS_HOLES" to true, BRIDGE to false) }
}
