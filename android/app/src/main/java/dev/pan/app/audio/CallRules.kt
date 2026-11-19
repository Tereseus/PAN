package dev.pan.app.audio

/**
 * What a call does to the microphone and to the lines said during it. Plain rules, so a test
 * holds them (CallRulesTest). From the owner's first real call, 2026-11-19:
 *  - the other phone was muted (the app starts muted) and the call was answered from the
 *    notification: its sound went one way for 15 seconds, until the mic was turned on by hand;
 *  - every line he said to the person also went to the hub joined to the lines before it,
 *    40 KB growing to 492 KB a line, 2 MB in 50 seconds, where the call's own sound was 36 KB.
 */
object CallRules {
    /** The call's sound starts: the mic is turned on for it when it is off. */
    fun opensMic(micOn: Boolean): Boolean = !micOn

    /**
     * The call's sound ends: the mic goes back off only when the call turned it on and nobody
     * touched it since ([openedByCall] is dropped by any mic press during the call).
     */
    fun closesMic(openedByCall: Boolean, micOn: Boolean): Boolean = openedByCall && micOn

    /**
     * A line said a breath after the last one is joined to it, words and sound, when ΠAN had not
     * answered ([wouldJoin]). Not in a call: there every line is said to the person, none of
     * them is answered, and the joined sound grew without end.
     */
    fun joinsLineBefore(wouldJoin: Boolean, inCall: Boolean): Boolean = wouldJoin && !inCall
}
