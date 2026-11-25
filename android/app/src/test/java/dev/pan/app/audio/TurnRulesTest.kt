package dev.pan.app.audio

import dev.pan.app.audio.TurnRules.Action
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnRulesTest {
    @Test fun aNoWordsClipWhileAQuestionWaitsCancelsNothing() =
        assertEquals(Action.TENTATIVE, TurnRules.decide(unheard = true, questionWaiting = true, wouldJoin = true))
    @Test fun itIsNotGluedOntoTheQuestionEither() =
        assertEquals(Action.TENTATIVE, TurnRules.decide(unheard = true, questionWaiting = true, wouldJoin = false))
    @Test fun aNoWordsClipWithNothingWaitingIsAnOrdinaryTurn() =
        assertEquals(Action.NEW, TurnRules.decide(unheard = true, questionWaiting = false, wouldJoin = false))
    @Test fun aNoWordsClipStillJoinsANoWordsLineBefore() =
        assertEquals(Action.JOIN, TurnRules.decide(unheard = true, questionWaiting = false, wouldJoin = true))
    @Test fun wordsSaidABreathLaterStillJoinTheQuestion() =
        assertEquals(Action.JOIN, TurnRules.decide(unheard = false, questionWaiting = true, wouldJoin = true))
    @Test fun wordsSaidLaterAreANewTurn() =
        assertEquals(Action.NEW, TurnRules.decide(unheard = false, questionWaiting = true, wouldJoin = false))

    @Test fun aRealReplyPromotesTheTentativeTurn() = assertTrue(TurnRules.promotes("Sure."))
    @Test fun anEmptyChunkDoesNot() = assertFalse(TurnRules.promotes("  "))

    @Test fun aCancelledTurnSaysNothing() = assertTrue(TurnRules.silentNoAnswer(stillWanted = false, intent = null))
    @Test fun aTurnTheHubDroppedAsLateSaysNothing() = assertTrue(TurnRules.silentNoAnswer(stillWanted = true, intent = "cancelled"))
    @Test fun aWantedTurnWithNoAnswerIsReported() = assertFalse(TurnRules.silentNoAnswer(stillWanted = true, intent = null))
}
