// Which lines the voice model (Syrinx, 2B) may answer alone. Until now it answered every line
// unless a rule saw a question about the world or it chose [THINK] itself, and it does not know
// what it does not know: on the owner's real lines (Nov 21 smartness test) it made up a fact
// ("he won them from 1991 through 1993"), promised to tell a Claude thread something it never sent,
// and explained its own fast voice with an invented reason. With setting voice_reader_alone on,
// it keeps only the short lines (a greeting, "can you hear me", a word of thanks) and the lines
// that are an action PAN runs itself (its intent is not plain talk); every other line goes to the
// hub model, the same road as [THINK].

const TALK = new Set(['', 'query', 'question', 'chat', 'conversation']);
export const SHORT_WORDS = 6;

/** True when the voice model may answer this line itself. */
export function readerMayAnswer(text, intent) {
  if (!TALK.has(String(intent || '').toLowerCase())) return true;
  const words = String(text || '').match(/[\p{L}\p{N}']+/gu) || [];
  return words.length <= SHORT_WORDS;
}
