// Am I part of this? (docs/INTUITION-STATE.md section 15, 2026-11-13)
//
// PAN's place in the talk and the firm rules that decide a line before any model runs. Plain
// rules on what the hub already knows, no model of any kind: it runs on every voice turn and
// takes well under a millisecond. The owner's rule (2026-11-03): no LLM keeps Intuition's state.
//
// Places (15.1): partner (he is talking with PAN), on_call (people talk among themselves, PAN is
// welcome but not in it), observer (PAN has no place: dictating, muted), interpreter (a mode).
// guardian (safety) is decided elsewhere and always wins.
//
// Firm rule built here (15.3 rule 4): a line said to another person by name ("Maria, ...",
// "hey Maria ...", "..., Maria?") is theirs, so PAN stays quiet, even if it knows the answer.
// Names come from the history's own speaker labels (any script: "Μαρία: ...", "マリア: ...").
// Without one, only a capitalised word set off at the END ("..., Maria?") or after "hey" counts:
// speech-to-text capitalises every first word, so "Tomorrow, will it rain?" must not be a name.

const TALK_MS = 45_000;            // PAN spoke this recently: he is talking with it (router TALK_MS)
// "assistant" is how the phone's own history labels PAN's lines: counted as a person, it put
// someone else in every talk and long lines went to the room (Nov 14).
const OWN = new Set(['user', 'you', 'he', 'pan', 'pam', 'him', 'me', 'assistant', 'system', 'ai', 'παν']);
// The speech model's spellings of PAN's name: "Pand" (Nov 14), "Pann", "Pahn", "Pam".
export const PAN_SOUND = /^pa+h?(?:n+d?|m)$/i;
// Capitalised openers that are not names. A miss here costs one quiet turn, so keep it wide.
const NOT_NAMES = new Set(`okay ok well so yes yeah yep no nope hey hi hello look listen sorry thanks thank right alright
  oh ah um uh hmm wait actually honestly anyway also and but then now please guys everyone everybody man dude mate bro
  sir madam folks friends ladies gentlemen mum mom dad mama papa baby honey darling dear god jesus wow damn great good
  nice cool fine sure true exactly really maybe perhaps listen see come go stop look ja nein bueno vale oui non si sì
  claro pues entonces bon alors donc ναι όχι λοιπόν καλά ρε άντε έλα эй да нет ну так ладно evet hayır tamam peki`.split(/\s+/));

const COMMA = '[,，、:;!]';
const HEY_NAME = /^\s*(?:hey|hi|hello|yo|oi)\s+(\p{L}[\p{L}'’-]{1,24})\b/iu;
const VOCATIVE_END = new RegExp(`${COMMA}\\s*(\\p{Lu}[\\p{L}'’-]{1,24})\\s*[?？!.。]?\\s*$`, 'u');

/** The other people's names in a history block: its speaker labels other than him and PAN. */
// A person called by a title ("Gracias, señor Martínez.", "Κύριε Υπουργέ, ...", "..., Sr. Deputado."):
// the title then a capitalised word, at the start or after a comma, then a comma, a stop or the end.
// Not "remind me to call Dr. Smith" (no start or comma before the title).
const TITLES = ['mr', 'mrs', 'ms', 'miss', 'dr', 'sir', 'madam', 'señor', 'señora', 'señorita', 'sr', 'sra', 'srta', 'sr.ª',
  'don', 'doña', 'monsieur', 'madame', 'm', 'mme', 'mlle', 'herr', 'frau', 'signor', 'signore', 'signora', 'dottor',
  'dottore', 'senhor', 'senhora', 'κύριε', 'κυρία', 'κύριοι', 'sayın', 'bay', 'bayan', 'господин', 'госпожа']
  .sort((a, b) => b.length - a.length)
  .map((w) => { const e = w.replace(/\./g, '\\.'); return `${e[0].toUpperCase()}${e.slice(1)}|${e}`; }).join('|');
const TITLE_CALL = new RegExp(`(?:^|${COMMA})\\s*(?:${TITLES})\\.?\\s+(\\p{Lu}[\\p{L}'’-]{1,24}(?:\\s+\\p{Lu}[\\p{L}'’-]{1,24})?)\\s*(?:${COMMA}|[.!?？。…]|$)`, 'u');

export function namesIn(history) {
  const names = new Set();
  for (const raw of String(history || '').split('\n')) {
    const m = raw.match(/^\s*([^:\n]{1,40}):\s/);
    if (!m) continue;
    const label = m[1].replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (label && !OWN.has(label.toLowerCase())) names.add(label);
  }
  return names;
}

/**
 * The other person a line is said to by name, or null.
 *   text     the line
 *   history  the history block (its speaker labels are the people present)
 */
export function namedOther(text, history = '') {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^(?:(?:hey|hi|hello|ok|okay|yo)[,\s]+)?(?:pa+h?(?:n+d?|m))\b/i.test(t)) return null;    // PAN's own name first
  const present = namesIn(history);
  // A present person's name at the start, set off by a comma or a pause word, in any script.
  for (const n of present) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A calling word may follow the name: Vietnamese "Lan ơi", Korean "민수야", Chinese "小王啊".
    if (new RegExp(`^\\s*(?:(?:hey|hi|hello|ok|okay|yo|oi)[,\\s]+)?${esc}(?:\\s*(?:ơi|à|ya|ah|啊|呀|야|아))?\\s*(?:${COMMA}|$)`, 'iu').test(t)) return n;
    if (new RegExp(`${COMMA}\\s*${esc}\\s*[?？!.。]?\\s*$`, 'iu').test(t)) return n;
  }
  const titled = t.match(TITLE_CALL);
  if (titled) return titled[1];
  // Scripts with capitals: a name-shaped word set off at the start or the end.
  for (const re of [HEY_NAME, VOCATIVE_END]) {
    const m = t.match(re);
    if (!m) continue;
    const w = m[1];
    const lower = w.toLowerCase();
    if (OWN.has(lower) || NOT_NAMES.has(lower) || PAN_SOUND.test(lower)) continue;
    if (re === HEY_NAME && !/^\p{Lu}/u.test(w) && !present.has(w)) continue;
    // "in Porto, Portugal?", "Paris, France": a place name before the comma makes it a
    // place, not someone called by name (Nov 12 bench: the sunrise question went quiet).
    if (re === VOCATIVE_END && !present.has(w)) {
      const words = t.slice(0, m.index).trim().split(/\s+/);
      if (words.length > 1 && /^\p{Lu}/u.test(words[words.length - 1])) continue;   // not "Thanks, John."
    }
    return w;
  }
  return null;
}

// ---- The shape of a line (shared with the nightly learner, situation-learn.js) ----
// The settings the learner may retune, with their starting values. Measured 2026-11-13 on the
// addressed test (15 languages, 180 lines): right after PAN answered him, a short question in his
// voice was a follow-up 66 times of 90 and his talk to the others 5 times of 90; no follow-up ran
// over 15 words, while 27 of 90 of his lines to the others did.
export const DEFAULT_PARAMS = { shortQuestionWords: 6, longLineWords: 15 };
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
const THAI = /[฀-๿]/;
const QMARK = /[?？;;]\s*$/;
// Thai marks a question with a word, not "?": ไหม, มั้ย, หรือ, ล่ะ, อะไร, ไหน, ใคร, เมื่อไหร่, ยังไง, เท่าไหร่.
const THAI_Q = /(?:ไหม|มั้ย|หรือ(?:เปล่า)?|ล่ะ|อะไร|ไหน|ใคร|เมื่อไหร่|ยังไง|อย่างไร|เท่าไหร่|กี่)\s*$/;

/** A line's size in words; CJK and Thai have no spaces, so about 3 characters a word. */
export function lineSize(text) {
  const t = String(text || '').trim();
  return CJK.test(t) || THAI.test(t) ? t.replace(/\s+/g, '').length / 3 : t.split(/\s+/).filter(Boolean).length;
}

export function isQuestion(text) {
  const t = String(text || '').trim();
  return QMARK.test(t) || THAI_Q.test(t);
}

// Acknowledgements that answer nobody ("yeah", "uh-huh", "はいはい", "그렇지", "อือฮึ ใช่"): a line made
// only of these, repeated or mixed, is a backchannel. It needs no answer from PAN, unless PAN's
// last line asked him something ("Shall I set it?" "Yes."), which the caller checks.
const BACKCHANNEL_WORDS = `yeah yes yep yup ya ok okay uh-huh uhhuh mhm mm hmm hm right sure exactly true cool wow oh ah
  alright i see got it fine indeed totally absolutely
  ναι εντάξει μάλιστα αχά σωστά ακριβώς ε α ωραία
  ja genau stimmt okay achso ach so klar eben
  oui ouais d'accord voilà ah bon exactement bien sûr
  sí si vale claro ya exacto bueno
  sì certo esatto va bene giusto
  sim pois é tá claro exato certo
  да ага угу ну ясно точно конечно
  evet tamam hı hıhı aynen tabii
  ừ vâng dạ đúng rồi ờ à
  ใช่ ค่ะ คะ ครับ อือ อือฮึ อ๋อ อย่างนั้น โอเค จริง
  네 응 그렇지 맞아 그래 아 어 예 그쵸 그렇죠
  はい うん そう そうね そうですね なるほど ええ へえ ふーん
  对 對 嗯 是 好 对对 係 系 哦 喔 啊 好的 冇错 没错`.split(/\s+/).filter(Boolean);
const BC_ALT = BACKCHANNEL_WORDS.sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const BACKCHANNEL = new RegExp(`^(?:(?:${BC_ALT})[\\s,，、.。!！…~-]*){1,6}$`, 'iu');

export function isBackchannel(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.。!！…?？]+$/u, '');
  return !!t && t.length <= 30 && BACKCHANNEL.test(t);
}

/** Did PAN's last line in the history ask him something? ("PAN: Shall I set it?") */
export function panAskedLast(history) {
  const lines = String(history || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(pan|pam|assistant)\s*(?:\([^)]*\))?\s*:\s*(.*)$/i);
    if (m) return isQuestion(m[2]);
  }
  return false;
}

/** { question, short_question, long, backchannel } for a line, with the given (or default) settings. */
export function shapeOf(text, params = DEFAULT_PARAMS) {
  const size = lineSize(text);
  const question = isQuestion(text);
  return { size: Math.round(size * 10) / 10, question, short_question: question && size <= params.shortQuestionWords,
    long: size > params.longLineWords, backchannel: !question && isBackchannel(text) };
}

/** How many other people are in the talk: distinct speaker labels in the last lines. */
export function othersIn(history, last = 12) {
  const lines = String(history || '').split('\n').filter((l) => l.trim()).slice(-last);
  return namesIn(lines.join('\n')).size;
}

/**
 * PAN's place in the talk for this line, with the reasons, from what the hub already knows.
 *   { text, history, sincePanMs, mode: 'interpreting' | 'dictation' | 'muted' | null }
 * Returns { place, named_other, others, reasons[] }.
 */
export function participationOf({ text, history = '', sincePanMs = null, mode = null, params = DEFAULT_PARAMS } = {}) {
  const reasons = [];
  const named = namedOther(text, history);
  const others = othersIn(history);
  let place;
  if (mode === 'interpreting') { place = 'interpreter'; reasons.push('interpreting'); }
  else if (mode === 'dictation' || mode === 'muted') { place = 'observer'; reasons.push(mode); }
  else if (Number.isFinite(sincePanMs) && sincePanMs < TALK_MS) { place = 'partner'; reasons.push(`PAN spoke ${Math.round(sincePanMs / 1000)} s ago`); }
  else if (others > 0) { place = 'on_call'; reasons.push(`${others} other ${others === 1 ? 'person' : 'people'} talking`); }
  else { place = 'partner'; reasons.push('nobody else heard'); }
  if (named) reasons.push(`said to ${named} by name`);
  return { place, named_other: named, others, shape: shapeOf(text, params), reasons };
}
