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

    /** The line is a request to turn the phone's light on or off, and nothing else. */
    fun flashlight(line: String): Boolean =
        FLASHLIGHT.matches(line.lowercase().trim().trimEnd('.', '!', '?').trim())
}
