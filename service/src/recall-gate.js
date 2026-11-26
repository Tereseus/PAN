// When a voice line is a question about the past, and whether the talk it came in already has the
// answer. Used by router.js routeStream before it searches memory (Long conversation test through
// ΠAN's own path, 2026-11-26):
//  - Story lines went to the memory search. "You won't believe what happened at the gardening class
//    today." matched the recall words ("what happened") and a date ("today"), the search found
//    nothing, and the coded refusal answered "I don't have anything recorded about believe from
//    today." Ten of 50 test talks had a line like it: "tell me about it", "I've got to remember to
//    pack the charger", "I can't even remember the last time I cooked". A line that tells is not a
//    line that asks: only a question sentence searches.
//  - "What was the title of the song I wrote last night?" with the song named four turns up got
//    "I don't have anything recorded about title from yesterday": a named day skipped the check
//    of the talk itself, and the refusal answered without the model ever seeing the talk.

const SENTENCE = /[^.!?？。！]+[.!?？。！]*/g;
// The words a question sentence starts with in English, after a greeting or the name. This is the
// grammar of a question (an interrogative or an inverted auxiliary), not a list of topics.
const LEAD = /^(?:(?:hey|hi|ok|okay|so|and|but|oh|um|uh|well|wait)\b[,\s]*)*(?:(?:pan|pam|ΠAN)\b[,\s]*)?/i;
const ASKS = /^(?:what|when|where|who|whom|whose|which|why|how|did|do|does|was|were|is|are|am|have|has|had|can|could|would|will|should|remind)\b/i;

/** The sentences of a line, trimmed. */
export function sentences(text) {
  return (String(text || '').match(SENTENCE) || []).map((s) => s.trim()).filter(Boolean);
}

/** Is this one sentence a question: a question mark, or a question's word order? */
export function questionForm(sentence) {
  const s = String(sentence || '').trim();
  if (/[?？]\s*$/.test(s)) return true;
  return ASKS.test(s.replace(LEAD, ''));
}

/**
 * Does the line ASK about the past: a sentence that is a question and carries the recall words
 * (recallRe, router.js RECALL_RE). A telling sentence with the same words does not count.
 */
export function asksAboutPast(text, recallRe) {
  return sentences(text).some((s) => recallRe.test(s) && questionForm(s));
}

// Five letters are enough to meet "write" in "writing" or "risks" in "risk", and few enough
// words share them by chance.
const stem = (w) => String(w).toLowerCase().slice(0, 5);

/**
 * Does the talk he is in hold most of what the question names (subject words, no time words)?
 * Then it is answered from the talk, whatever day the question names.
 */
export function talkCovers(terms, history) {
  const hay = String(history || '').toLowerCase();
  const words = [...new Set((terms || []).map(stem))].filter((w) => w.length >= 4);
  if (!hay.trim() || !words.length) return false;
  const hayStems = new Set((hay.match(/[a-z]{4,}/g) || []).map(stem));
  const found = words.filter((w) => hayStems.has(w)).length;
  return found * 2 >= words.length;
}

/**
 * The coded "nothing saved" answer, or null when the model should answer instead. With a talk
 * going on, the model reads it (the answer may be there in other words: "who was upset" about
 * "my ex said I was too distracted"), told the saved memory has nothing. Never a single word from
 * the question as its subject: "about believe", "about title".
 */
export function noRecordAnswer({ when, history }) {
  if (String(history || '').trim()) return null;
  return when ? `I don't have anything recorded from ${when.label}.` : `I don't have anything saved about that.`;
}
