package dev.pan.app.audio

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallRulesTest {
    @Test fun aCallAnsweredOnAMutedPhoneTurnsItsMicOn() = assertTrue(CallRules.opensMic(micOn = false))
    @Test fun aMicAlreadyOnIsLeftAlone() = assertFalse(CallRules.opensMic(micOn = true))

    @Test fun theMicTheCallTurnedOnGoesOffWhenItEnds() = assertTrue(CallRules.closesMic(openedByCall = true, micOn = true))
    @Test fun aMicThatWasOnBeforeTheCallStaysOn() = assertFalse(CallRules.closesMic(openedByCall = false, micOn = true))
    @Test fun aMicMutedByHandDuringTheCallIsNotTouched() = assertFalse(CallRules.closesMic(openedByCall = true, micOn = false))

    @Test fun outsideACallALineIsJoinedToTheOneBefore() = assertTrue(CallRules.joinsLineBefore(wouldJoin = true, inCall = false))
    @Test fun inACallEveryLineGoesAlone() = assertFalse(CallRules.joinsLineBefore(wouldJoin = true, inCall = true))
    @Test fun nothingToJoinIsNotJoined() = assertFalse(CallRules.joinsLineBefore(wouldJoin = false, inCall = false))
}
