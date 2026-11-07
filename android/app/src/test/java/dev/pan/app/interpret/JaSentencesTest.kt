package dev.pan.app.interpret

import org.junit.Assert.assertEquals
import org.junit.Test

class JaSentencesTest {
    @Test fun runOnLineSplits() = assertEquals(listOf("ギリシャですか。", "いいですね"), JaSentences.split("ギリシャですかいいですね"))

    @Test fun twoPoliteSentences() = assertEquals(listOf("大阪から来ました。", "あなたは"), JaSentences.split("大阪から来ましたあなたは"))

    @Test fun oneSentenceStaysWhole() = assertEquals(listOf("この寿司は千二百円です。"), JaSentences.split("この寿司は千二百円です。"))

    @Test fun becauseCarriesOn() = assertEquals(listOf("雨ですから行きません"), JaSentences.split("雨ですから行きません"))

    @Test fun butCarriesOn() = assertEquals(listOf("高いですがおいしいです"), JaSentences.split("高いですがおいしいです"))
}
