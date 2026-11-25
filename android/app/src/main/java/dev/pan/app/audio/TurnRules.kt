package dev.pan.app.audio

/**
 * What a new line does to the turn still waiting for its reply. Plain rules, so a test holds them
 * (TurnRulesTest). From the car, 2026-11-24 and 2026-11-25:
 *  - a question was heard by the hub and was still waiting for its answer when a clip of road
 *    noise came in. The phone treated the clip as a new turn: it cancelled the question, the hub
 *    cancelled it too, and the noise got nothing back. He heard nothing, then "you never replied".
 *  - a spoken request was cancelled the same way by a 2 s clip the phone's ear
 *    wrote no words for, and the cancelled turn then said "Your computer isn't answering."
 */
object TurnRules {
    enum class Action {
        /** Joined to the line before it (carry_on), which is cancelled and re-sent with it. */
        JOIN,
        /** A new turn: whatever is still waiting for its reply is cancelled. */
        NEW,
        /**
         * Sent on its own, marked tentative, and nothing is cancelled. Only if the hub answers it
         * (it was real words meant for ΠAN) does it take over from the waiting turn.
         */
        TENTATIVE,
    }

    /**
     * [unheard]: the phone's ear wrote no words for this clip (only the hub can tell if it was
     * speech). [questionWaiting]: a turn WITH words is still waiting for its reply.
     * [wouldJoin]: the carry_on rule would join it to the line before.
     */
    fun decide(unheard: Boolean, questionWaiting: Boolean, wouldJoin: Boolean): Action = when {
        unheard && questionWaiting -> Action.TENTATIVE
        wouldJoin -> Action.JOIN
        else -> Action.NEW
    }

    /** A tentative turn takes over once the hub streams a real reply to it. */
    fun promotes(firstChunk: String): Boolean = firstChunk.isNotBlank()

    /**
     * A turn whose reply came back with nothing to say must stay silent when it was cancelled (a
     * newer turn moved on, or the hub dropped it as late), and never say "Your computer isn't
     * answering": that is only true when the hub really did not answer a turn still wanted.
     */
    fun silentNoAnswer(stillWanted: Boolean, intent: String?): Boolean =
        !stillWanted || intent == "cancelled"
}
