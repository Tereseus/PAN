package dev.pan.app.tts

import org.junit.Assert.assertEquals
import org.junit.Test

class LineClausesTest {
    @Test fun shortLineStaysWhole() = assertEquals(listOf("Where is the station?"), LineClauses.split("Where is the station?"))

    @Test fun firstClauseGoesAlone() = assertEquals(
        listOf("Thank you very much,", "I will take the train to Kyoto."),
        LineClauses.split("Thank you very much, I will take the train to Kyoto."))

    @Test fun tinyOpeningIsNotAPiece() = assertEquals(
        listOf("Excuse me, where is the station?", "I am lost and very tired."),
        LineClauses.split("Excuse me, where is the station? I am lost and very tired."))

    @Test fun numbersStayTogether() = assertEquals(listOf("It costs 1,200 yen", "and 3.5 dollars"), LineClauses.split("It costs 1,200 yen and 3.5 dollars"))

    @Test fun japaneseCutsAfterAParticle() = assertEquals(
        listOf("この寿司は", "千二百円です。"), LineClauses.split("この寿司は千二百円です。"))

    @Test fun japaneseCutsWithoutAComma() = assertEquals(
        listOf("駅の近くのラーメン屋に", "よく行きます。"), LineClauses.split("駅の近くのラーメン屋によく行きます。"))

    @Test fun japaneseKeepsDoubleParticles() = assertEquals(
        listOf("東京駅には", "新しいお店があります。"), LineClauses.split("東京駅には新しいお店があります。"))

    @Test fun kanaWordsAreNotCut() = assertEquals(listOf("ありがとうございました。"), LineClauses.split("ありがとうございました。"))

    @Test fun englishCutsAtAJoint() = assertEquals(
        listOf("I often go to a ramen shop", "near the station."), LineClauses.split("I often go to a ramen shop near the station."))

    @Test fun japaneseSplitsWithoutSpaces() = assertEquals(
        listOf("ありがとうございます、", "駅はどこですか。", "道に迷いました。"),
        LineClauses.split("ありがとうございます、駅はどこですか。道に迷いました。"))

    @Test fun laterSentencesStayWhole() = assertEquals(
        listOf("Thank you very much,", "first go left, then go right.", "After that it is near."),
        LineClauses.split("Thank you very much, first go left, then go right. After that it is near."))

    @Test fun nothingIsLost() {
        val line = "Good morning everyone, the meeting starts at ten. Please sit down. Thanks."
        assertEquals(line, LineClauses.split(line).joinToString(" "))
    }
}
