package dev.pan.app.service

/**
 * The few things the phone does by itself the moment it hears them, with no hub. A line counts
 * only when the whole of it is the command: any sentence that held the word "flashlight" or
 * "torch" used to toggle the light.
 */
object InstantWords {
    private const val LIGHT = """(?:flash ?light|torch)"""
    private val FLASHLIGHT = Regex(
        """^(?:(?:hey|ok|okay)\s+)?(?:pan[,\s]+)?(?:please\s+)?(?:""" +
            """(?:turn|switch|put)\s+(?:on|off)\s+(?:the\s+|my\s+)?$LIGHT""" +
            """|(?:turn|switch|put)\s+(?:the\s+|my\s+)?$LIGHT\s+(?:on|off)""" +
            """|(?:toggle\s+)?(?:the\s+|my\s+)?$LIGHT(?:\s+(?:on|off))?""" +
            """)(?:\s+please)?$"""
    )

    // The battery, asked as the whole line ("what's my battery", "battery level", "how much battery
    // do I have left"). Any line holding "battery" with "what" or "level" used to answer it: in the
    // car (Nov 26) a long line read aloud got "Battery is at -2147483648 percent".
    private val BATTERY = Regex(
        """^(?:(?:hey|ok|okay)\s+)?(?:pan[,\s]+)?(?:""" +
            """(?:what(?:'s| is)\s+(?:the\s+|my\s+|your\s+)?battery(?:\s+(?:level|at|percentage))?)""" +
            """|(?:how much\s+battery(?:\s+(?:do i have|have i got|is)(?:\s+left)?)?(?:\s+left)?)""" +
            """|(?:(?:my\s+|the\s+)?battery\s+(?:level|percentage|status))""" +
            """|(?:how(?:'s| is)\s+(?:the\s+|my\s+)?battery)""" +
            """)$"""
    )

    /** The line is a question about the battery, and nothing else. */
    fun battery(line: String): Boolean =
        BATTERY.matches(line.lowercase().replace('’', '\'').trim().trimEnd('.', '!', '?').trim())

    /** A battery level that can be said: 0 to 100. A device with no battery (a car unit) gives garbage. */
    fun batteryLevel(raw: Int): Int? = raw.takeIf { it in 0..100 }

    /** The line is a request to turn the phone's light on or off, and nothing else. */
    fun flashlight(line: String): Boolean =
        FLASHLIGHT.matches(line.lowercase().trim().trimEnd('.', '!', '?').trim())
}
