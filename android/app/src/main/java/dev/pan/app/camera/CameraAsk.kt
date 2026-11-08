package dev.pan.app.camera

/**
 * Whether a heard line asks PAN to look through the phone's camera ("what am I looking at?",
 * "what is this?"). The phone checks its own words with this before the hub is asked, and a
 * match takes the photo (PanForegroundService.handleCameraCommand).
 *
 * The phone's recogniser drops letters: "What am I looking at?" came through as "what am i
 * lookin at" on 2026-11-08, matched nothing, and the hub answered from the computer's screen
 * ("You're looking at your browser"). Then "tell me what I'm looking at" and "look through the
 * camera of my phone" missed too. So -in endings count as -ing, and those ways of asking count.
 */
object CameraAsk {
    private val phrases = listOf(
        "what am i looking at", "what am i seeing",
        "what i'm looking at", "what i am looking at", "what im looking at",
        "take a photo", "take a picture", "take photo", "take picture",
        "what do you see", "what can you see",
        "what's in front of me", "what is in front of me",
        "describe what you see",
        "what's around me", "what is around me",
        "snap a photo", "snap a picture",
    )

    // Asked to look with it: "look through the camera of my phone", "use my phone's camera".
    // Not "what I was pointing at with the camera" (no asking word), nor "look at the garage
    // camera" (another camera).
    private val withCamera = Regex("\\b(look|use)\\b[^.?!]{0,30}\\b(my|the|your)\\s+(phone'?s\\s+)?camera\\b")

    // "What is that" means look only when nothing else follows it. "What is that movie
    // called, the one with the..." is him reaching for a name, and answering it with "the
    // camera is turned off" took the turn from the hub's word search (2026-11-03).
    private val deictic = Regex("\\b(what is|what's|look at|identify|describe|capture) (this|that)\\b(.*)$")
    private val tail = Regex("^\\s*((thing|things|one|here|there|right|over|called|pan|please|for me|real quick|now)\\b[\\s,.?!]*)*$")

    private val droppedG = Regex("\\b(look|see)in'?(?![a-z])")

    fun matches(text: String): Boolean {
        val lower = normalize(text)
        if (phrases.any { lower.contains(it) }) return true
        if (withCamera.containsMatchIn(lower)) return true
        val m = deictic.find(lower) ?: return false
        return tail.matches(m.groupValues[3])
    }

    /** Lower case, curly apostrophes made plain, "lookin" and "seein'" as "looking" and "seeing". */
    fun normalize(text: String): String =
        text.lowercase().trim().replace('’', '\'').replace(droppedG, "$1ing")
}
