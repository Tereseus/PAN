import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { insert, all, get, logEvent, allScoped, getScoped } from './db.js';
import { claude, askAIStream, getConfiguredModel, getModelForCaller } from './claude.js';
import { askAIWithFallback, askAIStreamWithFallback, readChain } from './llm-fallback.js';
import { buildToolBlocks } from './tools.js';
import { outLoud, keepFigures } from './sums.js';
import { lookupNotes, searchQuery, DEFAULT_ENGINE, ENGINES } from './web-lookup.js';
import { wikiNotes } from './library/zim.js';
import { peekSearch, peekDecline } from './search-again.js';
import { readerMayAnswer } from './reader-alone.js';
import { buildSelfBlock, buildSelfLine } from './self.js';
import { anonymizeForAI } from './anonymize.js';
import { isAvailable as weztermAvailable, openTerminal as weztermOpen, sendText as weztermSend, getText as weztermGet, listPanes as weztermList } from './wezterm.js';
import * as playwright from './playwright-bridge.js';
import { findSkill, getSkillPrompt, listSkills } from './skills.js';
import { resolvePreference, resolveDeviceAlias } from './routes/preferences.js';
import {
  smartPickApp, rankedAppsForAction, pickDevice,
  detectCorrection, learnCorrection,
  setLastAction, getLastAction, intentToActionType,
  setDialogState, getDialogState,
} from './smart-router.js';
import { searchMemory, warmVectors, searchMemoryByDate, parseWhen, isReadablePreview } from './memory-search.js';
import { writeThought } from './thoughts.js';
import { isBench, benchContext } from './bench-context.js';
import * as messageMode from './message-mode.js';
import * as layingOut from './intuition/laying-out.js';
import { cleanName as cleanPanName, mapName as mapPanName, callsOwnName, nameLine as panNameLine } from './pan-name.js';
// The smart model: the person's own terminal (task 1091), picked in Settings (smart-model-pick.js).
import { smartModel } from './smart-model-pick.js';
import { projectTurn, projectAnswerModel, projectReply } from './projects.js';
import { recordTiming } from './voice-timing.js';
import { noteMealMention } from './intuition/nourishment.js';
import { noteSignalsInUtterance } from './intuition/signals.js';
import { getCurrentSnapshot } from './intuition/index.js';
import { getConversationState, getConversationBuffer, dictatingToClaude, panSpokeWithin, overheardWithin, lastLook } from './conv-state-watcher.js';
import { sourceAnswer, sourceName } from './looks.js';
import { recentThoughts } from './intuition/mind.js';
import { loadModes, saveMode, dropMode } from './intuition/world.js';
import { hisTimeZone, utcOffsetHours } from './intuition/time.js';
import { buildBrief, briefMode } from './intuition/brief.js';
import { notePhoneGps, placeLine, daylightLine, weatherLine } from './intuition/place.js';
import { followUpOf, followUpLine, historyLines } from './intuition/conversation.js';
import { shelfForTurn, notesNamedIn } from './intuition/shelf.js';
import { pauseForTalk } from './memory/things.js';

// The talk before this line, oldest first, for a tool that needs it (tools.js: the currency
// tool reads "what about fifty thousand yen" by the line before it).
function talkBefore(context, text) {
  const lines = historyLines(context?.conversation_history).map((l) => l.text).filter(Boolean);
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  if (lines.length && same(lines[lines.length - 1], text)) lines.pop();
  return lines.slice(-8);
}
import { asksTheWorld, asksForSomething, lostBy } from './intuition/reader.js';
import { participationOf, shapeOf, panAskedLast } from './intuition/participation.js';
import { currentParams as situationParams } from './intuition/situation-learn.js';
import { planFromResult as planProsody } from './tts-prosody.js';
import { warmForLanguage, languageNamed, languageName } from './hub-asr.js';
import { translateLocal, translatorUp, pairInstalled } from './translate-local.js';
import { studentChain } from './llm.js';
import { warmReader } from './voice-reader.js';
import { asksForCamera } from './camera-ask.js';
import { asksToMute } from './mute-ask.js';
import { modeTurn, modeAck, noteMode } from './listen-mode.js';
import { may, refusal } from './people.js';
import { ringing, ringQuestion, wantsStop, stoppedWords } from './ringing.js';
import { alone } from './alone.js';
import { messageTurn, parseMessage } from './person-messages.js';
import { asksAboutPast, talkCovers, noRecordAnswer } from './recall-gate.js';

// Recall-intent sniff — only when text matches this do we run a DB lookup on
// the first pass. Pure conversation never touches FTS5/vector. See task #744
// (#NEW-1) and docs/CONVERSATION-AND-INTERJECTION.md.
const RECALL_RE = /\b(remember|recall|forgot|what (did|was|were|happened)|when (did|was|were)|where (did|was|were)|who (did|was|were|said)|find.*about|look.*up|tell me about)\b/i;

// Evidence that a past-question is about HIS OWN history rather than the world.
//
// RECALL_RE alone is far too broad to refuse on: it matches "what WAS the
// capital of peru". Refusing a general-knowledge question would be a worse
// bug than the one being fixed, so the deterministic refusal needs a second
// signal - a named date, or a shared-history pronoun.
//
// Checked against the whole 65-case corpus: exactly ONE case is eligible
// ("what did we decide about the pendant"), and that one has records, so it
// synthesises normally. Every general-knowledge case passes through.
const OWN_HISTORY_RE = /\b(we|i|i'm|im|my|our|us)\b/i;

// Words too generic to prove a hit is about the thing he asked.
const _RECALL_STOP = new Set(['about','after','again','against','anything','around','because',
  'been','before','being','below','between','both','could','decide','decided','decision','did',
  'does','doing','done','down','during','each','from','further','gave','give','going','have',
  'having','here','how','into','just','know','like','made','make','module','more','most','much',
  'makes','making','must','need','needed','once','only','other','over','plan','project','said','same','say','see',
  'should','since','some','stuff','such','system','take','talk','talked','than','that','their',
  'them','then','there','these','they','thing','things','this','those','through','thought','time',
  'under','until','using','very','want','wanted','were','what','when','where','which','while',
  'with','work','worked','would','your']);

// Did the search actually find the thing he named?
//
// The emptiness check was not enough. Asked about a "submarine project" that
// has never existed, FTS still returned readable rows - real sentences about
// other projects, matched on generic words like "project" and "decide" - so
// memResults was NOT empty, the block was labelled "Relevant memories", and
// the model produced a confident architecture plan from unrelated text.
//
// A hit only counts if a DISTINCTIVE word from his question appears in it.
// 'submarine' appears nowhere -> nothing relevant was found. 'pitch' and
// 'formations' do appear -> genuine recall, pass it through.
// What is he asking ABOUT, as opposed to when. Reuses the recall stop-list and
// drops time words, so "what did i do on autokratia today" yields ['autokratia']
// and "what did i do today" yields [] (meaning: the whole day is the answer).
const _TIME_WORDS = new Set(['today', 'yesterday', 'tonight', 'morning', 'afternoon',
  'evening', 'night', 'week', 'month', 'year', 'days', 'last', 'ago',
  'january', 'february', 'march', 'april', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);

function _subjectTerms(text) {
  const words = String(text || '').toLowerCase().match(/[a-z]{4,}/g) || [];
  return [...new Set(words)].filter((w) => !_RECALL_STOP.has(w) && !_TIME_WORDS.has(w));
}

function _recallIsRelevant(text, hits) {
  const terms = String(text || "").toLowerCase().match(/[a-z]{4,}/g) || [];
  const distinctive = [...new Set(terms)].filter((w) => !_RECALL_STOP.has(w));
  if (distinctive.length === 0) return true;   // nothing specific asked; do not block
  const hay = hits.map((h) => String(h.preview || "")).join(" ").toLowerCase();
  return distinctive.some((w) => hay.includes(w));
}

// Is the answer to "what did I say the dog is called" sitting in the conversation the
// phone just sent? Then it is not a memory question at all, and the coded "nothing
// saved" refusal below must not fire: it answered that line while "the neighbour's dog
// is called biscuit" was two turns up (voicebench recall scenarios, 2026-11-02).
function _historyMentions(text, history) {
  const hay = String(history || '').toLowerCase();
  if (!hay.trim()) return false;
  const terms = String(text || '').toLowerCase().match(/[a-z]{4,}/g) || [];
  return [...new Set(terms)].filter((w) => !_RECALL_STOP.has(w)).some((w) => hay.includes(w));
}

// Stricter: EVERY word that names the subject is in that conversation.
function _historyNames(text, history) {
  const hay = String(history || '').toLowerCase();
  const terms = [...new Set(String(text || '').toLowerCase().match(/[a-z]{4,}/g) || [])].filter((w) => !_RECALL_STOP.has(w));
  return !!hay.trim() && terms.length > 0 && terms.every((w) => hay.includes(w));
}

// Build the situation block from the live intuition snapshot. Returns '' when
// no snapshot is available (boot-up, isolated tests). See task #745 (#NEW-2).
// Date and time on every voice turn. Without it the model could not answer "what time is it
// in Tokyo", so the phone answered time questions itself with a hard-coded shortcut, which
// also swallowed "what time is it over there". His clock, not the hub's: the hub keeps his
// job's time zone, so "what time is it" got New York time wherever he was (intuition/time.js).
const voiceHistoryBlock = (history) => {
  const h = fitHistory(history);
  return h ? `\nRecent conversation:\n${h}\n` : '';
};

// The voice reader runs with a 4,096 token window (steward.js -c 4096), and the reply's 300 come out
// of it too. A long talk went over it: the reader answered 400, the backup echoed the history with
// no JSON, and he heard "I didn't catch that". 15 of 20 Greek bench turns did that, because Greek
// costs about twice the tokens of English per letter (hub, 2026-11-12). So the history gets a token
// budget (the same on the warm read and on the turn, or the read ahead stops matching) and his line
// its own. The guess is per character, checked against the reader's own tokenizer on 18 languages:
// 0.87 to 1.6 times the real count; Pulaar and Wolof read low, which the spare room covers
// (2,000 history + 700 line + about 600 for the rest + 300 reply, under 4,096 even at 0.87).
const HISTORY_TOKENS = 2000;
const HEARD_TOKENS = 700;
const OLD_LINE_TOKENS = 120;   // lines above the last four are shortened to about this
const KEEP_WHOLE = 4;          // the last lines stay word for word (up to HEARD_TOKENS each)
export function estTokens(s) {
  let t = 0;
  for (const ch of String(s || '')) {
    const c = ch.codePointAt(0);
    if (c < 128) t += 0.36;
    else if (c < 0x370 || (c >= 0x1E00 && c < 0x1F00)) t += 1.0;      // accented Latin, Latin extended
    else if (c < 0x530) t += 0.6;                                     // Greek, Cyrillic
    else if (c >= 0x0E00 && c < 0x0E80) t += 0.6;                     // Thai
    else if (c >= 0xAC00 && c < 0xD7B0) t += 0.75;                    // Hangul
    else if (c >= 0x3040 && c < 0x3100) t += 0.8;                     // kana
    else if ((c >= 0x4E00 && c < 0xA000) || (c >= 0x3400 && c < 0x4DC0)) t += 1.15;  // CJK
    else t += 1.0;
  }
  return t;
}
// Keeps the end of a long text: the end is what the next speaker answers.
export function clipToTokens(s, max) {
  s = String(s || '');
  if (estTokens(s) <= max) return s;
  const chars = [...s];
  let t = 0, i = chars.length;
  while (i > 0 && t + estTokens(chars[i - 1]) <= max - 1) t += estTokens(chars[--i]);
  const cut = chars.slice(i).join('');
  const sp = cut.indexOf(' ');
  return '…' + (sp > 0 && sp < 40 ? cut.slice(sp + 1) : cut);
}
export function fitHistory(history, budget = HISTORY_TOKENS) {
  const lines = String(history || '').split('\n').filter((l) => l.trim());
  if (!lines.length) return '';
  const clipLine = (l, max) => {
    const m = l.match(/^([^:\n]{1,40}:\s)([\s\S]*)$/);
    return m ? m[1] + clipToTokens(m[2], max) : clipToTokens(l, max);
  };
  const sum = (ls) => ls.reduce((n, l) => n + estTokens(l) + 1, 0);
  let out = lines.map((l) => clipLine(l, HEARD_TOKENS));
  // Older lines are shortened only when the whole does not fit, so a normal talk goes in untouched.
  if (sum(out) > budget) out = out.map((l, k) => (k >= out.length - KEEP_WHOLE ? l : clipLine(l, OLD_LINE_TOKENS)));
  let total = sum(out);
  while (out.length > 1 && total > budget) total -= estTokens(out.shift()) + 1;
  if (total > budget) out[0] = clipLine(out[0], budget);
  return out.join('\n');
}

// The voice student and, when a voice box serves it, the same model on the hub for when the box is off.
function studentModels() {
  const read = (key) => {
    try { return String(get(`SELECT value FROM settings WHERE key = '${key}'`)?.value || '').replace(/^"|"$/g, '').trim(); } catch { return ''; }
  };
  return [read('voice_student_model'), read('voice_student_backup')];
}

/**
 * His turn is coming: reads the conversation into the voice reader before his words arrive, when
 * the reader is what will answer (a GPU reads it in 0.03 s). Must build what studentPrompt builds
 * on a plain turn, or the turn shares nothing with it.
 */
export function warmStudent(history, context = {}) {
  const [model, backup] = studentModels();
  if (!studentChain(model, backup)[0]?.startsWith('reader:')) return;
  // The turn's prompt opens with the situation line (studentPrompt, routeStream). Without it here
  // the read never matched the turn whenever a line existed, which is nearly always (2026-11-12).
  const situation = situationOnEveryTurn() ? situationFor(context) : '';
  _warmSituation = { org: context.org_id || 'org_personal', line: situation, at: Date.now(), brief: briefApplies(context) };
  const block = [situation, voiceHistoryBlock(history).trim()].filter(Boolean).join('\n\n');
  warmReader(block, `${block ? '\n\n' : ''}${nowLine()}\n\nMic heard: "`);
}

// voice_situation: the situation line goes in on every turn that has one, unless 'off' (then only
// when he asks what he is doing or where he is, routeStream).
// situation_rules: 'off' (default), 'bench' (bench turns only, to test it while his own turns
// stay as they were), 'on'. The nightly learner scores the rules in shadow either way.
function situationRulesOn(context) {
  try {
    const v = String(get("SELECT value FROM settings WHERE key = 'situation_rules'")?.value || '').replace(/^"|"$/g, '').trim().toLowerCase();
    return v === 'on' || (v === 'bench' && /-bench$/.test(String(context.device_id || '')));
  } catch { return false; }
}

function situationOnEveryTurn() {
  try {
    return String(get("SELECT value FROM settings WHERE key = 'voice_situation'")?.value || '').replace(/^"|"$/g, '').trim().toLowerCase() !== 'off';
  } catch { return true; }
}

// Questions about the world (reader.js asksTheWorld) answered by the bigger model, not the 2B voice
// model: 'cloud' = on, 'bench' = only for benchmark devices (a silent replay), anything else = off.
// LOOKING A WORLD QUESTION UP (web-lookup.js): the hub's own browser reads a search page and the hub
// model gets a few lines of it. Right-answer bench, 88 general questions (Nov 20): 58 right and 18
// false from the model's own head, 80 right and 7 false with the lines, in every language asked.
// Setting web_lookup: 'all' = every device, 'bench' = benchmark devices only, else off.
// web_lookup_engine: the search site the person chose (web-lookup.js ENGINES), DuckDuckGo if unset.
const WEB_LOOKUP_MS = 3000;   // the longest a turn waits for the page; past it the model answers from what it knows
function webLookupOn(deviceId) {
  try {
    const v = String(get("SELECT value FROM settings WHERE key = 'web_lookup'")?.value || '').replace(/^"|"$/g, '').trim().toLowerCase();
    return v === 'all' || (v === 'bench' && /-bench$/.test(String(deviceId || '')));
  } catch { return false; }
}
// wiki_lookup: world questions ask offline Wikipedia first (library/zim.js wikiNotes) and the web only
// when Wikipedia does not hold it; with Wikipedia notes the hub model may still ask for a web search
// for something that changes (owner, 2026-11-23). 'all', 'bench' (benchmark devices only, the
// default until the answer bench says so) or 'off'.
function wikiLookupOn(deviceId) {
  try {
    const v = String(get("SELECT value FROM settings WHERE key = 'wiki_lookup'")?.value || 'bench').replace(/^"|"$/g, '').trim().toLowerCase();
    return v === 'all' || (v === 'bench' && /-bench$/.test(String(deviceId || '')));
  } catch { return false; }
}
// web_lookup_again: when the notes miss something that changes, the hub model may ask for one more
// search in its own words (search-again.js). 'all' = every device, 'bench' = benchmark devices only.
function lookAgainOn(deviceId) {
  try {
    const v = String(get("SELECT value FROM settings WHERE key = 'web_lookup_again'")?.value || '').replace(/^"|"$/g, '').trim().toLowerCase();
    return v === 'all' || (v === 'bench' && /-bench$/.test(String(deviceId || '')));
  } catch { return false; }
}
function webLookupEngine() {
  try {
    const v = String(get("SELECT value FROM settings WHERE key = 'web_lookup_engine'")?.value || '').replace(/^"|"$/g, '').trim().toLowerCase();
    return ENGINES[v] ? v : DEFAULT_ENGINE;
  } catch { return DEFAULT_ENGINE; }
}
// With the lookup on, the keyword tools for headlines and Wikipedia leave a question about the
// world to it ("who won the World Cup this year" got headlines and "I don't know", Nov 20).
function toolSkips(deviceId, text) {
  return webLookupOn(deviceId) && worldQuestionsOn(deviceId) && !!worldModel(deviceId) && asksTheWorld(text) ? ['search', 'wikipedia'] : undefined;
}
function worldQuestionsOn(deviceId) {
  try {
    const v = String(get("SELECT value FROM settings WHERE key = 'voice_world_questions'")?.value || '').replace(/^"|"$/g, '').trim().toLowerCase();
    return v === 'cloud' || (v === 'bench' && /-bench$/.test(String(deviceId || '')));
  } catch { return false; }
}

// The hub's own model for those questions, so no cloud and no key: setting voice_world_model, e.g.
// 'ollama:phi4-mini:3.8b'. 'bench=<model>' = benchmark devices only (a silent replay before it goes
// on for him). Empty or anything else = the cloud model of the voice chain, as before.
function worldModel(deviceId, key = 'voice_world_model') {
  try {
    // <key>_bench: the model a benchmark device gets, while everyone else keeps <key>. The
    // smartness test (evals/smartbench) tries a candidate on his real lines this way (Nov 21).
    if (/-bench$/.test(String(deviceId || ''))) {
      const b = String(get(`SELECT value FROM settings WHERE key = '${key}_bench'`)?.value || '').replace(/^"|"$/g, '').trim();
      if (/^(?:ollama|reader):\S+$/.test(b)) return b;
    }
    const v = String(get(`SELECT value FROM settings WHERE key = '${key}'`)?.value || '').replace(/^"|"$/g, '').trim();
    const m = v.replace(/^bench=/, '');
    if (!/^(?:ollama|reader):\S+$/.test(m)) return '';
    return v.startsWith('bench=') && !/-bench$/.test(String(deviceId || '')) ? '' : m;
  } catch { return ''; }
}
const HUB_TEMPERATURE = 0.3;   // steadier facts: at the default, phi4-mini named Inception once and Interstellar the next time (Nov 16)
const HUB_SENTENCES = 3;       // a hub model's spoken reply stops after this many sentences (plainAsReply)
const WORLD_LOCAL_MS = 4000;   // a hub model reads the prompt before its first word; past this the voice model answers
// THE HUB MODEL TAKES EVERY LINE THE VOICE MODEL HANDS UP, not only questions about the world: a
// reached-for word, live data, who PAN is, a reread, his own chances, [THINK], the camera asked for
// twice, his name with no answer, something he told PAN. Those went to the cloud model of the voice
// chain, which a hub with no key does not have (the owner, Nov 16: no keys, one model). Setting
// voice_hub_paths: 'all' = every device, 'bench' = benchmark devices only, else the cloud model as
// before. The model is voice_world_model's.
// voice_reader_alone: 'all' or 'bench' (devices ending in -bench) = the voice model answers only
// short talk and its own actions alone (reader-alone.js). Empty = as before.
function readerAloneOn(deviceId) {
  try {
    const v = String(get("SELECT value FROM settings WHERE key = 'voice_reader_alone'")?.value || '').replace(/^"|"$/g, '').trim().toLowerCase();
    return v === 'all' || (v === 'bench' && /-bench$/.test(String(deviceId || '')));
  } catch { return false; }
}

function hubPathsOn(deviceId) {
  try {
    const v = String(get("SELECT value FROM settings WHERE key = 'voice_hub_paths'")?.value || '').replace(/^"|"$/g, '').trim().toLowerCase();
    return v === 'all' || (v === 'bench' && /-bench$/.test(String(deviceId || '')));
  } catch { return false; }
}
// THE HUB MODEL'S PROMPT: ONE FIXED BLOCK FIRST, THEN ONLY WHAT IS NEW. A hub with no graphics card
// reads about 100 tokens a second, and the model keeps what it read last time as long as the next
// prompt starts the same. With a rule per kind of line near the top, every kind started differently
// and the whole talk was read again: first word 0.5 to 1.6 s straight to the model, 1 to 5 s in a
// real turn. With the first line, every rule and the facts about PAN in one block that never
// changes, then the talk, the clock, his line and the kind of line last: 0.6 s for every kind
// (phi4-mini on the hub CPU, Nov 16, scratchpad cache_test.py). Asked for plain spoken words, not
// JSON (see plainAsReply below). These rules are the cloud prompts' rules in plain-words form: a
// change to one of those belongs here too.
// Asked "what's my name?" under a line that says "your name is PAN", phi4-mini answered "PAN" (Nov 16).
const HUB_PRONOUNS = 'In his line, "I", "me" and "my" mean him, and "you" and "your" mean you, PAN.';
const HUB_AMBIENT = 'reply with exactly [AMBIENT] and nothing else';
const HUB_WORLD = 'He asked something that needs real knowledge or judgment. Answer it correctly and plainly, the way a smart friend would out loud, in one to three short spoken sentences, talking to him as "you". Give the real figure, step or reason when there is one. If you are not sure, say so in a few words and give what you do know; never make up a term, a number or a product. Stay on his question: nothing about his work, his projects or the background line unless he asked. When the conversation above is already on this subject, answer as its next line: build on what was said and use its details, and never start over with a general overview.';
const HUB_RULES = {
  WORLD: HUB_WORLD,
  WORLD_MAYBE: `The WORLD rule, but if he was not talking to you (the TV, someone else in the room), ${HUB_AMBIENT}.`,
  LOOKED: 'The WORLD rule, and the notes above his line were looked up on the web just now and are newer than what you remember: where they speak to his question, trust them over your memory. Say the answer first, in one sentence, exactly as the notes give it (names, scores, figures and dates copied from the notes, never from memory). Then add one or two sentences of what is worth knowing about it (who, since when, where, how much), using only what the notes say: a name, a score or a figure that is not in the notes must not be said. If the notes hold nothing more, stop after the answer. When the notes do not cover his question at all, answer from what you know. If the notes show that something you said earlier in this conversation was wrong, say so in a few plain words and give what the notes say. When it is something that changes (who holds a post, a price, this year\'s events) and the notes do not cover it, say you are not sure instead of guessing. Never say that you looked it up or read notes.',
  LOOKED_MAYBE: `The LOOKED rule, but if he was not talking to you (the TV, someone else in the room), ${HUB_AMBIENT}.`,
  LOOKED_SEARCH: 'The LOOKED rule, and almost always you just answer from the notes. Read the notes first: if any line in them answers his question, answer it and never search. Only when no line in the notes answers it, and it is something that changes (a recent result or winner, who holds a post, a price), reply with exactly [SEARCH: the few words you would type into a search box, with the year when it matters] instead of saying you are not sure.',
  LOOKED_SEARCH_MAYBE: `The LOOKED_SEARCH rule, but if he was not talking to you (the TV, someone else in the room), ${HUB_AMBIENT}.`,
  ASKED: 'He asked you to come up with something yourself: a question for him, a joke, an idea, a story, your opinion. Do it now, in one to three short spoken sentences. If he wants a question, ask him one real, specific question about him or about what he is doing, and nothing else. Never just agree, and never ask what he would like.',
  ASKED_MAYBE: `The ASKED rule, but if he was not talking to you (the TV, someone else in the room), ${HUB_AMBIENT}.`,
  WORD: `He stopped mid-sentence, reaching for a word or a name. If you are confident which word or name he means, your reply is only that word or name with a question mark, the way a friend helps out ("Inception?"). If you are not sure, ${HUB_AMBIENT}.`,
  DATA: `Answer from the data given, briefly, the way you would say it out loud; if his words are not asking for it, answer what he did say. If he was not talking to you (the TV, someone else in the room), ${HUB_AMBIENT}.`,
  SELF: `He asks who he is or who you are. Answer from the facts about you, in one or two short spoken sentences, talking to him as "you". If he was not talking to you, ${HUB_AMBIENT}.`,
  KIND: `He is asking about his own chances or abilities. Answer like a good friend who believes in him: warm and encouraging but honest, in one or two short spoken sentences. Never promise an outcome you cannot know, never a put-down, never sarcasm. If he was not talking to you, ${HUB_AMBIENT}.`,
  ABOUT_TALK: `He is asking about this conversation itself. Tell him from the conversation, in one or two short spoken sentences, talking to him as "you". Stay on what he is talking about. If you do not know, say so. If he was not talking to you, ${HUB_AMBIENT}.`,
  LOST: `He did not follow your last answers, or says they were wrong or off the point. Read the conversation again and answer what he is asking NOW, plainly and correctly, in one to three short spoken sentences, talking to him as "you". If an earlier answer of yours was wrong, made up or had nothing to do with his question, own it once in a few plain words ("I got that wrong") and give the right answer; never defend it and never repeat it. If the conversation shows you already owned it, do not apologise again and do not repeat advice you already gave. If he has moved on to a new question, just answer the new question. Stay on what he is talking about. If you do not know, say so. If he was not talking to you, ${HUB_AMBIENT}.`,
  THINK: 'This one needs real thought. Answer it the way a smart friend would out loud: a real view and the reason for it, in two or three short spoken sentences, talking to him as "you". If he says you did not answer him, answer his last real question from the conversation now. Never dodge: no "I can\'t tell you", no "who\'s asking", no "I already did".',
  WORDS_ALONE: `Answer from his words alone, in one or two short spoken sentences. If he was not talking to you, ${HUB_AMBIENT}.`,
  NAMED: 'He said your name, so he is talking to you: answer him briefly, the way you would say it out loud.',
  TOLD: `He told you this without asking anything, or reacted to what you last said. Answer the way a friend in the room would: one short spoken sentence that fits (sympathy, a light comment, or a quick useful tip; for a fact to remember, a brief acknowledgement). No question unless it is the natural reply, never an offer or a menu. If it plainly was not said to you (he is talking to someone else, reading something out, or dictating), ${HUB_AMBIENT}.`,
};
// His first talk on the new app (Nov 17): "How can I assist you today?" after small talk, the same
// sentence word for word to two wordings of one question, and a survey of what cultures believe
// for a question with no settled answer.
const HUB_MANNER = 'Talk like a person, not a help desk: never offer help, never ask how you can assist, never say you are here for him. Never say a sentence you already said in this conversation: if he asks the same thing again your last answer missed, so answer it another way. When a question has no settled answer, give your own view in a sentence instead of listing what people think.';
const HUB_FIXED = 'You are PAN, his voice assistant and a friend in the room. Reply with only the words you say out loud: no JSON, no lists, no asterisks. ' + HUB_PRONOUNS + ' ' + HUB_MANNER
  + '\n\nHow you answer depends on the kind of line. The kind is named on the last line of this prompt. Follow only the rule for that kind:\n'
  + Object.entries(HUB_RULES).map(([k, v]) => `${k}: ${v}`).join('\n');
// middle: the talk, the clock, any data, his line, in that order. selfLine (self.js buildSelfLine) is
// always there, right after the fixed block: it is the same every turn, so it costs nothing after the first.
// A few words after the kind, for the kinds phi4-mini got wrong with the rule that far up (Nov 16:
// "You asked me what you just asked me", and "Pan" for his name).
// Tried and taken back (Nov 17, replay of his real lines): the manner rules again at the very end of
// the prompt changed nothing (phi4-mini still offered help and repeated a sentence that was in the
// talk), and a reminder to answer questions about itself from the self line made it say "I'm
// running on NVIDIA Parakeet" to a line about solar panels. The manner is the model's, not the
// prompt's. What did work at the end: telling it who "me" is when he asks to be asked something.
const HUB_ASKED_HINT = 'In his line "me" is him. If he wants a question, ask him one about his day, his work or something from the conversation above.';
const HUB_HINTS = {
  ASKED: HUB_ASKED_HINT,
  ASKED_MAYBE: HUB_ASKED_HINT,
  ABOUT_TALK: 'In the conversation above the "User" lines are his and the "PAN" lines are yours. Tell him what he asked or what was said: "You asked ...".',
  SELF: 'In his line "my" and "I" mean him, not you.',
};
function hubPrompt(kind, middle, selfLine) {
  return [HUB_FIXED, selfLine, ...middle, `Kind of line: ${kind}.${HUB_HINTS[kind] ? ' ' + HUB_HINTS[kind] : ''}`].filter(Boolean).join('\n\n');
}
// What a cloud prompt holds between its first line and its rule (its own self line left out).
function hubMiddle(prompt) {
  return String(prompt).split('\n\n').slice(1, -1).filter((part) => !part.startsWith('About you (live'));
}
// Read the fixed block once when this code starts, so his first question does not pay for it (about
// 8 s on the hub CPU). Only when a hub model is set for every device.
setTimeout(async () => {
  try {
    const m = worldModel('');
    if (!m || !(worldQuestionsOn('') || hubPathsOn(''))) return;
    const t0 = Date.now();
    for await (const _ of askAIStreamWithFallback(hubPrompt('NAMED', ['Mic heard: "Hello PAN."'], buildSelfLine({})), { callerClass: 'voice', caller: 'router', maxTokens: 8, _skipAnonymize: true, chain: [m], temperature: HUB_TEMPERATURE })) { /* drain */ }
    console.log(`[routeStream] hub model ${m} read its fixed block in ${Date.now() - t0} ms`);
  } catch (e) { console.warn(`[routeStream] hub model warm-up failed: ${e.message}`); }
}, 25_000).unref?.();

// A model asked for plain spoken words: wrap its stream as the reply JSON the rest of the turn reads
// ("to" first, so the gate opens on the first word). "[AMBIENT]" becomes the ambient reply. A model
// further down the chain that answers in JSON anyway (the voice model does) is passed through as is.
const OPENERS = ['fair point. ', 'fair. ', 'fair enough. ', 'fair, ', 'fair point, ', 'fair enough, '];

async function* plainAsReply(stream, maxSentences = 0) {
  const esc = (s) => JSON.stringify(String(s).replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ')).slice(1, -1);
  let head = '', mode = '', said = '';
  // maxSentences: the reply stops at the end of that sentence. phi4-mini gave five where the prompt
  // asked for one to three (Nov 16), and on a hub with no graphics card every extra one is a second.
  const clip = (piece) => {
    const from = said.length; said += piece;
    if (!maxSentences) return null;
    const re = /[.!?]+["')\]]?\s/g; let m, n = 0;
    while ((m = re.exec(said))) if (++n >= maxSentences) return said.slice(from, m.index + m[0].length).trimEnd();
    return null;
  };
  // A spoken reply has no square brackets: a tuned hub model sometimes adds the quiet tag AFTER an
  // answer ("I don't know. [AMBIENT]"), and that would be read out. The reply ends at the bracket.
  // A quote mark at the very end is held back until more words come; one left open is dropped
  // (it ended a question with a lone ").
  let cut = false, held = '', quotes = 0;
  const tidy = (piece) => {
    if (cut) return '';
    let p = held + piece; held = '';
    const b = p.indexOf('[');
    if (b >= 0) { cut = true; p = p.slice(0, b).trimEnd(); }
    else { const q = p.match(/"\s*$/); if (q) { held = p.slice(q.index); p = p.slice(0, q.index); } }
    quotes += (p.match(/"/g) || []).length;
    return p;
  };
  for await (const chunk of stream) {
    if (mode === 'json') { yield chunk; continue; }
    if (mode === 'plain') {
      const c = clip(chunk);
      yield esc(tidy(c !== null ? c : chunk));
      if (c !== null || cut) break;
      continue;
    }
    head += chunk;
    let t = head.replace(/^[\s"]+/, '');
    if (!t) continue;
    if (t[0] === '{' || t[0] === '`') { mode = 'json'; yield head; continue; }
    if (t[0] === '[') { yield JSON.stringify({ intent: 'ambient', addressed: 0.1, response: '[AMBIENT]' }); return; }
    // "PAN: I'm PAN." (phi4-mini, Nov 16): the speaker label it copied from the talk is not said.
    if (t.length < 6 && ['PAN: ', 'You: ', 'User: '].some((l) => l.startsWith(t))) continue;   // also "You: I believe you can"
    t = t.replace(/^(?:PAN|You|User):\s*/, '');
    if (!t) continue;
    // The round 18 hub model opens with "Fair point." or "Fair." whenever he pushes back: four
    // replies in a row in one talk (2026-11-18; 2.4% of its training answers open that way). Until
    // a round caps it, the opener is not said when an answer follows it. Alone, it stands.
    if (t.length < 14 && OPENERS.some((o) => o.startsWith(t.toLowerCase()))) continue;
    t = t.replace(/^Fair(?: point| enough)?[.,!]\s+(?=\S)/i, '');
    if (t) t = t[0].toUpperCase() + t.slice(1);
    mode = 'plain';
    const c = clip(t);
    yield '{"to":"pan","response":"' + esc(tidy(c !== null ? c : t));
    if (c !== null || cut) break;
  }
  if (!mode && head.trim()) { mode = 'plain'; yield '{"to":"pan","response":"' + esc(tidy(head.trim())); }
  if (mode === 'plain' && held && !cut && quotes % 2 === 1) yield esc(held.trimEnd());   // it closes a quote that was opened
  if (mode === 'plain') yield '","intent":"query","addressed":0.9}';
}

function nowLine(zone) {
  const d = new Date();
  const tz = zone || hisTimeZone();
  let when;
  try { when = d.toLocaleString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); }
  catch { when = d.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); }
  const off = utcOffsetHours(d.getTime(), tz);
  return `Now: ${when} (${tz}, UTC${off >= 0 ? '+' : ''}${off}).`;
}

function buildSituationBlock(orgId) {
  try {
    const snap = getCurrentSnapshot(orgId || null);
    const now = snap?.now;
    if (!now) return '';
    const lines = [];
    if (snap.commander) lines.push(`- Commander: ${snap.commander}${now.last_seen ? ` (${now.last_seen})` : ''}`);
    if (now.where) lines.push(`- Where: ${now.where}`);
    if (now.activity) lines.push(`- Activity: ${now.activity}`);
    if (now.focus) lines.push(`- Focus: ${now.focus}${now.direction ? ` — direction: ${now.direction}` : ''}`);
    if (now.mood) lines.push(`- Mood: ${now.mood}${now.need ? ` — need: ${now.need}` : ''}`);
    if (now.engagement) lines.push(`- Engagement: ${now.engagement}`);
    if (now.last_heard) lines.push(`- Last heard: "${String(now.last_heard).slice(0, 140)}"`);
    return lines.length ? `\nSituation right now:\n${lines.join('\n')}\n` : '';
  } catch { return ''; }
}

// One line of what is going on around him, for the short voice prompts, which never got the
// block above. Facts only, each from a live source and only while fresh: the phone's place,
// what his computers are showing (pan-client presence), the phone camera's last look, what
// the conversation is about, and whether other people are talking nearby. The owner, 2026-11-03:
// Intuition should know "what you're doing, who you're talking to, what they're talking
// about", and voice and Intuition should feed each other.
// A window title worth telling the model. "envir_utf8: 1" (a console's title) went into every voice
// turn on 2026-11-12 as "his desktop shows ...". Drops key: value settings, bare paths, shell
// prompts and titles with no word of three letters.
function meaningfulTitle(t) {
  const s = String(t || '').trim();
  if (/^[\w.-]+\s*[:=]\s*[\w.-]{0,12}$/.test(s)) return false;          // envir_utf8: 1
  if (/^(?:[A-Za-z]:)?[\\/~][^\s]*$/.test(s)) return false;              // C:\..., /home/..., ~/...
  if (/^[\w.-]+@[\w.-]+:\S*\s*[$#]?$/.test(s)) return false;              // user@host:~$
  return /\p{L}{3,}/u.test(s.replace(/[\w]*_[\w]*/g, ''));
}

// The standing facts about him, and whether a text (a window title, his line) names something in
// them: a word of four letters or more that is not a filler ("eternity", "godot", "game").
function aboutHim() {
  try { return String(get("SELECT value FROM settings WHERE key = 'about_him'")?.value || '').replace(/^"|"$/g, '').trim().slice(0, 160); } catch { return ''; }
}
function touches(about, text) {
  const hay = String(text || '').toLowerCase();
  return _subjectTerms(about).some((w) => new RegExp(`\\b${w}`).test(hay));
}
// The line the voice model gets under the history when his own words touch those facts and no
// window brought them in already. Under the history, so the read ahead of the history still counts.
function aboutHimFor(text, situationLine) {
  const about = aboutHim();
  return about && !String(situationLine || '').includes(about) && touches(about, text) ? `(About him, in case it is what he means: ${about}.)` : '';
}

// What warmStudent put at the top of the read ahead (routeStream reuses it for 2 min).
let _warmSituation = null;
const WARM_SITUATION_MS = 2 * 60_000;
function warmedSituation(context = {}) {
  const w = _warmSituation;
  if (!w || w.org !== (context.org_id || 'org_personal') || Date.now() - w.at > WARM_SITUATION_MS || !!w.brief !== briefApplies(context)) return null;
  // He moved: the turn's fix names a place the read ahead's line does not (Nov 14, one town read
  // out while the phone said another).
  const addr = context.sensors?.phone?.gps?.address;
  if (addr && !w.line.includes(String(addr).slice(0, 60))) return null;
  try { notePhoneGps(context.sensors?.phone?.gps); } catch {}
  return w.line;
}

// The brief (intuition/brief.js): the situation line plus his threads, the things in play and the
// talk, about 500 tokens. Only where voice_brief allows it: bench turns by default, until the voice
// model is trained to read it.
function briefApplies(context = {}) {
  const mode = briefMode();
  return mode === 'on' || (mode === 'bench' && isTestTurn(context));
}
function situationFor(context = {}) {
  const line = buildSituationLine(context);
  if (!briefApplies(context)) return line;
  try { return buildBrief(line, { org: context.org_id || 'org_personal' }).text || line; } catch { return line; }
}
/** The brief as it stands now, for GET /api/v1/brief (the phone keeps a copy). */
export function briefNow(context = {}) {
  const line = buildSituationLine(context);
  const b = buildBrief(line, { org: context.org_id || 'org_personal' });
  return { text: b.text || line, parts: b.parts, tokens: Math.round(estTokens(b.text || line)), mode: briefMode(), built_at: Date.now() };
}

/** What his computers show now: [{ device: 'desktop' | 'laptop', title }], fresh in the last
 *  2 min, at most two. The situation line's windows, and where looks.js finds the window an
 *  answer was read from ("how did you know about MovieWriter?", 2026-11-08). */
export function screenTitlesNow(now = Date.now()) {
  try {
    return all(`SELECT device_id, activity, screen_title, platform FROM device_presence WHERE as_of > :since ORDER BY as_of DESC LIMIT 5`,
      { ':since': now - 2 * 60_000 })
      .filter(p => p.screen_title && meaningfulTitle(p.screen_title) && !/^idle$/i.test(p.activity || '') && !/minipc|hub/i.test(p.device_id || '') && !/android|ios/i.test(p.platform || ''))
      .slice(0, 2)
      .map(p => ({ device: /mint|desktop/i.test(p.device_id || '') ? 'desktop' : 'laptop', title: String(p.screen_title) }));
  } catch { return []; }
}

function buildSituationLine(context = {}) {
  try {
    const parts = [];
    const now = Date.now();
    const org = context.org_id || 'org_personal';
    // Place: this turn's fix, else the last known one with its age (intuition/place.js).
    // Daylight comes from that place and the date, computed, so "is it dark", "when does the
    // sun come up" are known the way a person in the room knows them.
    try { notePhoneGps(context.sensors?.phone?.gps); } catch {}
    const placeBit = placeLine(context.sensors?.phone?.gps);
    if (placeBit) parts.push(placeBit);
    try { const light = daylightLine(hisTimeZone()); if (light) parts.push(light); } catch {}
    try { const wx = weatherLine(); if (wx) parts.push(wx); } catch {}
    // Device names stay home: a hostname is a label, not something a cloud model needs.
    // The phone's own row (recordVoiceTurn) is its place, which is already above.
    const screens = screenTitlesNow(now).map(s => `his ${s.device} shows "${s.title.slice(0, 40)}"`);
    parts.push(...screens);
    // A few standing facts about him (setting `about_him`), so a window title like "War of
    // Eternity (DEBUG)" is not filled in by guessing: on Nov 12 the voice model told him he was
    // doing work he no longer does, and he had to correct it. Only while such a
    // window is up: given on every turn, the voice model wove the game into answers on
    // unrelated subjects, then could not say what game
    // it meant (his talks of Nov 15). His own words can call for it too (aboutHimFor, routeStream).
    const about = aboutHim();
    if (about && screens.some((t) => touches(about, t))) parts.push(about);
    // The last look, named by the camera that took it (looks.js): this said "the phone camera" for
    // the pendant's frames too.
    const seen = lastLook(org);
    const look = seen && seen.source !== 'screen'
      ? { description: seen.description || seen.said, age_ms: now - seen.at, name: sourceName(seen).replace(/^your /, 'his ') }
      : (() => { const w = getCurrentSnapshot(context.org_id || null)?.signals?.world_context; return w ? { ...w, name: w.source === 'pendant' ? 'his pendant camera' : "his phone's camera" } : null; })();
    if (look?.description && (look.age_ms ?? Infinity) < 15 * 60_000) {
      parts.push(`${look.name} saw ${String(look.description).slice(0, 70)} ${Math.max(1, Math.round(look.age_ms / 60_000))} min ago`);
    }
    const cs = getConversationState(org);
    const topicNow = cs?.topic && cs.distilled_at && now - cs.distilled_at < 10 * 60_000 ? String(cs.topic) : '';
    if (topicNow) parts.push(`the talk is about ${topicNow.slice(0, 50)}`);
    // What the things on his screens or in the talk are, from his notes (memory/things.js), so the
    // state says what he is doing ("WOE Camera is his thread for ..."), not only a window's name.
    try { parts.push(...notesNamedIn([...screens, topicNow], 2)); } catch {}
    if (dictatingToClaude()) parts.push('he has been dictating to Claude on his computer');
    if (overheardWithin(2 * 60_000, org) >= 2) parts.push('other voices nearby (TV or people)');
    return parts.length ? `Situation (background only, never read it out): ${parts.join('; ')}.` : '';
  } catch { return ''; }
}

// Build the conversation-state block. Reads the in-memory distilled state
// maintained by conv-state-watcher.js (a sibling of webcam/screen watchers,
// stream-paced — debounce-distills 500ms after each STT Final). Gives the
// router pre-chewed context about the dialogue itself: topic, phase,
// pending question, user's phrasing tempo, and whether the LAST utterance
// looked like a complete thought or mid-sentence. This is the conversation
// "endpointing" signal we're growing toward — see #NEW-conv-state.
function buildConvStateBlock(orgId) {
  try {
    const cs = getConversationState(orgId || null);
    if (!cs) return '';
    const lines = [];
    if (cs.topic)             lines.push(`- Topic: ${cs.topic}`);
    if (cs.phase)             lines.push(`- Phase: ${cs.phase}`);
    // pending_question intentionally NOT injected into the prompt.
    //
    // WHY (2026-09-11): the distiller is told to set this only when a question
    // is "not yet answered", and it does not reliably clear it once answered.
    // Because this block is rebuilt on EVERY turn, a stale entry made the model
    // re-answer an old question forever. Reproduced from two fresh devices:
    //   "name three countries in south america"
    //     -> "Two plus two is four. Want me to tackle a harder one?"
    //   "how tall is the eiffel tower"
    //     -> "Two plus two is four. And the Eiffel Tower is about 330 meters tall."
    // It presents to the user as "it did not understand my request".
    //
    // The genuinely useful case - PAN asked the user something and wants the
    // next utterance read as the answer - is already covered by open_question
    // in the dialog-state block, which HAS clearing logic (see the
    // open_question handling further down). This one was the unreliable
    // duplicate, so it is dropped rather than patched.
    if (cs.user_pattern)      lines.push(`- User pattern: ${cs.user_pattern}`);
    if (typeof cs.likely_turn_complete === 'boolean')
                              lines.push(`- Last utterance looked ${cs.likely_turn_complete ? 'complete' : 'mid-sentence'}`);
    if (cs.summary)           lines.push(`- Summary: ${cs.summary}`);
    return lines.length ? `\nConversation state:\n${lines.join('\n')}\n` : '';
  } catch { return ''; }
}

// Build a wider recent-thoughts block — last 15 thoughts within 20min, blends
// intuition verdicts + router thoughts so PAN grounds replies in real continuity
// across a multi-turn conversation. See #746 + #986 (epic batch 1).
function buildRecentMindBlock() {
  try {
    const thoughts = recentThoughts({ limit: 15, sinceMs: 20 * 60_000 });
    if (!thoughts || thoughts.length === 0) return '';
    const lines = thoughts
      .slice()
      .reverse() // oldest first reads more naturally
      .map(t => {
        const src = t.source ? `[${String(t.source).slice(0, 12)}]` : '';
        const txt = String(t.thought || '').slice(0, 200);
        return `- ${src} "${txt}"`;
      });
    return `\nRecently in my mind (last 20 min):\n${lines.join('\n')}\n`;
  } catch { return ''; }
}

// ─── #986 batch 1: deeper context builders ──────────────────────────────────
// All defensive — return '' on any error so a missing table never breaks the
// router. Goal: ~5k tokens of grounded context per turn. See epic #986.

// Last 15 dialog turns from events table. Pulls UserPromptSubmit + Stop
// (assistant reply) pairs. Falls back silently if events schema differs.
// IMPORTANT: bounded by created_at when no session_id — otherwise the
// full-table scan on a multi-million-row events table will time out the
// router (~30s hang). With the (event_type, created_at) filter the planner
// hits idx_events_created and returns in <50ms.
// `voiceOnly` exists because UserPromptSubmit / AssistantMessage / Stop are
// CLAUDE CODE hook events. Every message typed to Claude, and every reply
// Claude writes, lands in PAN's events table - so the voice prompt was being
// fed a running transcript of a completely different conversation, in markdown,
// and PAN concluded it should answer from THAT. Measured: 2877 of 10974 prompt
// characters, containing lines about knobs, silo textures and this very fix.
// It is also why voice answers drift onto whatever Claude was last doing.
function buildDialogHistoryBlock(sessionId, voiceOnly = false) {
  try {
    // Spoken turns only on the voice path. DashboardChat stays in because the
    // dashboard and the phone are meant to share one thread; the Claude Code
    // hook events are what has to go.
    const types = voiceOnly
      ? `'DashboardChat','MobileSend','VoiceCommand','RouterCommand'`
      : `'UserPromptSubmit','Stop','AssistantMessage','DashboardChat','MobileSend','VoiceCommand','RouterCommand'`;
    const limit = voiceOnly ? 8 : 15;
    const sql = sessionId
      ? `SELECT event_type, data, created_at FROM events
         WHERE session_id = :sid
           AND event_type IN (${types})
         ORDER BY id DESC LIMIT ${limit}`
      : `SELECT event_type, data, created_at FROM events
         WHERE created_at > datetime('now','-2 hours','localtime')
           AND event_type IN (${types})
         ORDER BY id DESC LIMIT ${limit}`;
    const rows = all(sql, sessionId ? { ':sid': sessionId } : {});
    if (!rows || rows.length === 0) return '';
    const lines = rows.slice().reverse().map(r => {
      let txt = '';
      try {
        const d = JSON.parse(r.data || '{}');
        txt = d.prompt || d.last_assistant_message || d.text || d.message || d.command || '';
      } catch { txt = String(r.data || '').slice(0, 200); }
      if (!txt) return null;
      const who = (r.event_type === 'UserPromptSubmit' || r.event_type === 'DashboardChat' || r.event_type === 'MobileSend' || r.event_type === 'VoiceCommand' || r.event_type === 'RouterCommand') ? 'commander' : 'PAN';
      const ts = (r.created_at || '').slice(11, 16); // HH:MM
      return `- ${ts} ${who}: "${String(txt).replace(/\s+/g,' ').slice(0, voiceOnly ? 100 : 200)}"`;
    }).filter(Boolean);
    return lines.length ? `\nRecent dialog (last ${limit} turns):\n${lines.join('\n')}\n` : '';
  } catch { return ''; }
}

// Top 5 active tasks (in_progress). Grounds the model in what we're working on
// right now so "the bug" / "that task" / "yeah ship it" can resolve correctly.
function buildActiveTasksBlock() {
  try {
    const rows = all(
      `SELECT title, status, priority FROM project_tasks
       WHERE status IN ('in_progress','in_test')
       ORDER BY priority DESC, id DESC LIMIT 5`
    );
    if (!rows || rows.length === 0) return '';
    // De-duplicate by title. Auto-filed bugs repeat verbatim - the live prompt
    // carried "Vision: apps markup=ok but vision says blank (auto-filed)" four
    // times, which is three wasted lines and three chances to distract.
    const seen = new Set();
    const lines = [];
    for (const r of rows) {
      const title = String(r.title || '').slice(0, 100);
      if (!title || seen.has(title)) continue;
      seen.add(title);
      lines.push(`- [${r.status}/p${r.priority || 0}] ${title}`);
    }
    if (!lines.length) return '';
    return `\nActive tasks:\n${lines.join('\n')}\n`;
  } catch { return ''; }
}

// Recent foreground apps from activity_events (screen-watcher). Last hour, top
// 5 unique apps by most-recent timestamp. Tells PAN what surfaces you've been
// touching so "yes do that one" can resolve to a specific app/window.
function buildRecentTopicsBlock() {
  try {
    const rows = all(
      `SELECT app_name, window_title, MAX(created_at) AS last_seen, COUNT(*) AS hits
       FROM activity_events
       WHERE created_at > datetime('now','-1 hour','localtime')
         AND app_name IS NOT NULL AND app_name != ''
       GROUP BY app_name
       ORDER BY last_seen DESC LIMIT 5`
    );
    if (!rows || rows.length === 0) return '';
    const lines = rows.map(r => `- ${String(r.app_name).slice(0, 60)}${r.window_title ? ` — ${String(r.window_title).slice(0, 80)}` : ''} (${r.hits}×)`);
    return `\nRecent surfaces (last hour):\n${lines.join('\n')}\n`;
  } catch { return ''; }
}

// Dismissal feedback. If user has been shutting down PAN's interjections,
// the model should tone down. Reads pan_interjections last 30min.
function buildDismissalFeedbackBlock() {
  try {
    const row = get(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('dismiss','ignored') THEN 1 ELSE 0 END) AS dismissed,
         SUM(CASE WHEN status IN ('accept','thanks') THEN 1 ELSE 0 END) AS positive
       FROM pan_interjections
       WHERE created_at > datetime('now','-30 minutes','localtime')`
    );
    if (!row || !row.total) return '';
    if (row.dismissed > 1 || (row.dismissed && row.total >= 3)) {
      return `\nUser reactions (last 30 min): dismissed ${row.dismissed} of my last ${row.total} nudges. Tone DOWN — be brief, don't push.\n`;
    }
    if (row.positive >= 2) {
      return `\nUser reactions (last 30 min): ${row.positive} positive of ${row.total}. Engagement is good.\n`;
    }
    return '';
  } catch { return ''; }
}

// Top 10 memory_items by confidence — durable facts about the commander.
// Single SELECT, ~2ms. Helps with "remember when I said…" / personalization.
function buildMemoryFactsBlock() {
  try {
    const rows = all(
      `SELECT item_type, content, confidence FROM memory_items
       WHERE content IS NOT NULL AND content != ''
       ORDER BY confidence DESC, id DESC LIMIT 10`
    );
    if (!rows || rows.length === 0) return '';
    const lines = rows.map(r => `- (${r.item_type}) ${String(r.content || '').slice(0, 160)}`);
    return `\nWhat I know about the commander:\n${lines.join('\n')}\n`;
  } catch { return ''; }
}

// Dialog-state block: the lightweight per-session state we keep in-memory in
// smart-router.js. Includes the last topic PAN talked about and any question
// PAN asked that's still awaiting an answer. Critical for "yes/no" replies
// and "do the same" references to resolve correctly.
function buildDialogStateBlock(sessionId) {
  if (!sessionId) return '';
  try {
    const ds = getDialogState(sessionId);
    if (!ds) return '';
    const lines = [];
    if (ds.last_topic)    lines.push(`- Last topic I was on: ${String(ds.last_topic).slice(0, 200)}`);
    if (ds.open_question) lines.push(`- I asked the commander: "${String(ds.open_question).slice(0, 200)}" (${Math.round(ds.awaiting_answer_age_ms/1000)}s ago — they may be answering this)`);
    return lines.length ? `\nDialog state:\n${lines.join('\n')}\n` : '';
  } catch { return ''; }
}

// Top 3 most-important recent episodic memories — past sessions that matter.
function buildEpisodicHitsBlock() {
  try {
    const rows = all(
      `SELECT summary, outcome, importance, created_at FROM episodic_memories
       WHERE created_at > datetime('now','-7 days','localtime')
       ORDER BY importance DESC, id DESC LIMIT 3`
    );
    if (!rows || rows.length === 0) return '';
    const lines = rows.map(r => `- [${r.outcome}/${(r.importance ?? 0).toFixed(1)}] ${String(r.summary || '').slice(0, 200)}`);
    return `\nRecent episodes:\n${lines.join('\n')}\n`;
  } catch { return ''; }
}

// Log a step in the command processing pipeline
function logStep(commandId, step, detail) {
  if (!commandId) return;
  try {
    insert(`INSERT INTO command_logs (command_id, step, detail) VALUES (:cid, :step, :detail)`, {
      ':cid': commandId,
      ':step': step,
      ':detail': typeof detail === 'string' ? detail : JSON.stringify(detail)
    });
  } catch {}
  console.log(`[PAN Log] cmd=${commandId} ${step}: ${typeof detail === 'string' ? detail.slice(0, 100) : JSON.stringify(detail).slice(0, 100)}`);
}

// Server-side quick classification — catches obvious patterns without Claude
function serverClassify(text) {
  const lower = text.toLowerCase();
  if (lower.match(/(create|make)\s+(a\s+)?(folder|file|directory)/)) return 'system';
  if (lower.match(/(delete|remove)\s+(the\s+|a\s+)?(folder|file)/)) return 'system';
  if (lower.match(/(open|launch)\s+(the\s+)?\w+.*(project|dev|terminal)/)) return 'terminal';
  if (lower.match(/(add|put)\s+.*(list|grocery)/)) return 'memory';
  if (lower.match(/(play|pley|plai|payl|p[la]{1,2}y)\s+(some|song|music|something|somthing|anything)/)) return 'music';
  if (lower.match(/(open|lauch|opn|launch)\s+(spotify|youtube|music|apple\s*music)/)) return 'music';
  if (lower.match(/\b(spotify)\b.*\b(open|play|start|launch)\b|\b(open|play|start|launch)\b.*\b(spotify)\b/)) return 'music';
  if (lower.match(/(set|seet)\s+.*(alrm|alarm|timer|timr)/)) return 'calendar';
  if (lower.match(/(remind|remindme|remaind)\s+(me\s+)?(to|about)/)) return 'memory';
  if (lower.match(/^(take|jot)\s+a\s+(note|memo)/)) return 'memory';
  return null;
}

// Is this utterance plainly aimed at PAN?
//
// WHY (2026-09-11): the classifier prompt says "NEVER ambient: questions
// (what/when/where/how/why/who/can you), commands (play/open/set/remind/add)"
// and the model does not reliably obey it. "hey what is the weather like
// tomorrow" came back intent=ambient and the phone silently dropped it, so the
// user got no answer and no error - the worst possible failure.
// quickAmbientCheck was innocent; all five of its rules return false for it.
//
// Whether something is a question or an imperative is cheap to decide, so
// decide it rather than trusting the model. Used ONLY to veto a wrong
// 'ambient', never to force one, so the model keeps its freedom elsewhere.
function looksDirectedAtPan(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  // Strip a leading greeting and/or wake word: "hey pan, what is..." -> "what is..."
  const body = t
    .replace(/^(?:hey|hi|hello|ok|okay)[,\s]+/, '')
    .replace(/^(?:pan|pam|ben|pen)[,\s]+/, '');
  const opener = /^(?:what|when|where|why|who|whose|which|how|can|could|would|should|will|is|are|am|do|does|did|tell|show|give|play|open|set|remind|add|search|find|send|call|start|stop|turn|make|read|write|check|look)\b/;
  return opener.test(body);
}

// He called PAN by name: "hey Pan, ...", "Pan, ...", "..., Pan?". Not "Pan replies and I can't
// see it" or "the PAN app": that is him talking ABOUT PAN, usually to Claude.
// "Pand", "Pann", "Pahn": the speech model's spellings of the name (Nov 14) count as the name.
function saysPanName(text) {
  const t = String(text || '').trim();
  if (/^(?:hey|hi|hello|ok|okay|yo)[,\s]+(?:pan|pam|pa+h?n+d?)\b/i.test(t)) return true;
  if (/\b(?:pan|pam|pa+h?n+d?)[\s?.!]*$/i.test(t)) return true;
  return /^(?:pan|pam)\b/i.test(t) && !/^(?:pan|pam)(?:['’]s\b|\s+(?:is|was|isn't|wasn't|replies|replied|says|said|should|shouldn't|does|doesn't|did|didn't|has|hasn't|had|can't|cannot|could|couldn't|keeps|kept|answers|answered|needs|thinks|knows|will|won't|would|wouldn't|seems|seemed|gets|got|just|still|always|never|app|thread|project|dashboard|hub|phone|voice)\b)/i.test(t);
}

// He TELLS PAN something without asking anything: how he is ("I'm so tired today"), what
// happened, a fact to keep ("the neighbour's dog is called Biscuit"). Syrinx files those as
// room talk and he got silence (2026-11-03). Short first-person lines only: a long one is
// dictation or a story told to someone else.
const TELLS_PAN = /^(?:(?:oh|ah|man|ugh|well|so|honestly|god|okay|ok|yeah|hey|pan|pam)[,\s]+)*(?:i'?m|i am|i'?ve|i have|i feel|i felt|i just|i had|i got|i finally|i was|i can'?t|i don'?t|i really|my \w+(?:['’]s)? (?:is|are|was|were|just|finally|has|had)\b|we (?:just|finally|had|got)\b|(?:the|our|my) [\w'’ ]{1,30} (?:is|was|are) (?:called|named)\b|today (?:was|is)\b)/i;
function tellsPan(text) {
  const t = String(text || '').trim();
  return TELLS_PAN.test(t) && t.split(/\s+/).length <= 20 && !t.endsWith('?');
}

// He asks about his own chances or worth: "do you think I'm going to get that job as a fellow
// at Anthropic?" got "Hardly. ... you're just a tool" from Syrinx (2026-11-03): round 9's data
// carries put-downs. Until a retrain filters them, these go to the cloud model, told to be
// honest and kind. Round 10 (rewritten put-downs) still told "was it stupid to build my own
// pendant" "you're just wasting your time", so past tense and "am I wasting my time" count too.
// "What do you think I'm looking for?" is not about his chances (Nov 12): after "you think" it
// needs an outcome or a judgement of him, not just "I".
const REASSURANCE = /\b(?:(?:do|did) you (?:think|reckon)|you think)\b.*\b(?:i(?:'m| am) (?:going to|gonna|good|smart|ready|able|qualified|enough|too old|too late|stupid|an idiot|wasting)|i(?:'ll| will| can| could|'d| would) (?:ever |really |actually )?(?:get|make|pass|win|land|be|do it|manage|succeed)|(?:was|is) it (?:stupid|dumb|crazy|a mistake|a waste)|my chances)\b|\bwhat are (?:the|my) chances\b|\b(?:am i|will i) (?:ever |really |actually |just )?(?:good|smart|ready|able|going to|gonna|get|make|be|pass|win|land|qualified|enough|too old|too late|stupid|an idiot|wasting my time)\b|\b(?:is|was) it (?:too late|stupid|dumb|crazy|silly|a mistake|a waste of time) (?:for me|to)\b|\bwhat are my chances\b/i;

// Second opinion before OmniΠ's camera flag takes a photo. Its false alarms in testing were
// "skip this song", "which server should we use", "no I don't think that's right", "let's see
// if you can send a message to the terminal": a pointing word about something you can't
// photograph, or no pointing word at all. A miss here costs nothing worse than today
// (the full prompt answers); a wrong photo is the annoying failure.
function looksVisual(text) {
  const t = String(text || '').toLowerCase();
  if (!/\b(this|these|that|those|here|look|looks|looking|see|seeing|read|wearing|colou?r|ripe)\b/.test(t)) return false;
  return !/\b(song|track|music|playlist|server|page|website|app|message|terminal|code|idea|logic|game|thread|email|meeting)\b|\bthat'?s (right|wrong|true)\b|\blet'?s see\b/.test(t);
}

// HELP WHEN HE IS STUCK (the owner, 2026-11-02: "you're thinking of something and you can't remember
// it. It should be able to recognize that and be like, oh, let me just tell him... based on if he
// wants me to or doesn't"). The phone marks a turn `unfinished` when he stopped mid-sentence and
// its 1.4 s wait for the rest ran out. If the words so far end like a search for a word or a name
// ("that film with the dreams inside dreams, the..."), a friend offers it as a question
// ("Inception?") and lets him carry on; finishing someone's sentence is an ordinary move in
// recorded conversation. Setting voice_interject: 'off' = stay quiet and wait for the rest,
// anything else = offer it. Only word-search endings: Smart Turn also calls some whole questions
// unfinished ("what colour did I say the fence will be", voicebench 2026-11-02), and those are
// answered as usual. Speech recognisers drop most "uh"s, so the trailing article carries it.
const WORD_SEARCH = /\b(?:the|a|an|that|this|his|her|their|my|your|with|called|named|uh|um|er|erm)[\s.,?!-]*$|\bwhat(?:'?s| is| was) (?:it|that|the|his|her|their) (?:called|word|name|thing)\b|\b(?:forget|forgot|can'?t remember|cannot remember)\b|\btip of my tongue\b|\byou know the one\b/i;

// A whole question that ends in a pronoun is not a search for a word. "Why did you say X?
// What do you mean by that?" came flagged unfinished, ended in "that", was sent down the
// word search, and he got silence (Nov 15). A trailing "that" or "this" with a question mark, or
// as the object of the word before it, ends a sentence. "The name of that..." still counts.
const PRONOUN_END = /\b(?:that|this|her)\s*\?+\s*$|\b(?:by|about|mean|meant|say|said|do|did|does|is|was|like|for|on|to|want|need|see|know|think|with)\s+(?:that|this)[\s.,?!-]*$/i;

// Standing instructions: "translate everything I say into Japanese from now on". Before this,
// the request only lived in the history lines, and the next turn answered in English. Kept
// per device until he cancels it or STANDING_TTL_MS passes after its last use, and repeated
// on every turn. Saved in the world (intuition/world.js): in memory only, every Craft swap
// silently ended interpreting. Read back on the first use after a start.
const _standing = new Map();   // device key -> { text, at, last?, lang? }
let _standingLoaded = false;
function standing() {
  if (!_standingLoaded) {
    _standingLoaded = true;
    for (const [k, s] of loadModes(inForce)) _standing.set(k, s);
  }
  return _standing;
}
// From its last use, not from when he gave it: a day of interpreting outlasts two hours.
function inForce(s) {
  return !!s && Date.now() - (s.last || s.at) <= STANDING_TTL_MS;
}
// The interpreting ones also as he says them, with no "from now on": "translate everything I say
// into Greek" set nothing, the local model answered "Got it, I'll translate everything you say
// into Greek", and every line after it was answered as chat (2026-11-03, his first real try).
const STANDING_SET_RE = /\b(from now on|from this moment on|from here on|until i say otherwise|until i tell you (to stop|otherwise)|for the rest of (the|this) (conversation|chat|session)|be (my|our) (\w+ )?(interpreter|translator)|(interpret|translate) for (me|us|her|him|them)|(translate|interpret) between|(interpreter|translator|translation) mode|(translat\w*|interpret\w*) (all|everything)|(translat\w*|interpret\w*) (what|whatever) (i|we|he|she|they)|(keep|start|begin|go on) (translating|interpreting))\b/i;
const STANDING_CLEAR_RE = /\b(stop translating|stop interpreting|interpreter off|translation off|back to normal|normal mode|cancel (that|the) instruction|forget (that|the) instruction|stop doing that)\b/i;
// A standing instruction that is a translation: the interpreting path in routeStream.
const INTERPRET_RE = /\b(translat\w*|interpret\w*)\b/i;
// The whole line is "translate to Greek" / "interpret now into Japanese": nothing in it to
// translate, so it starts interpreting. Such a line with "now" in it came back as the word "now"
// in Greek, twice (2026-11-17). With something to translate in it ("translate that to Greek",
// "translate to Greek: where is the station") it stays a single translation.
const BARE_INTERPRET_RE = /^\W*(?:(?:okay|ok|so|now|please|and|just|hey|pan)\W+)*(?:translat\w*|interpret\w*)\s+(?:(?:now|please)\s+)?(?:in)?to\s+\w+(?:\s+(?:now|please))?\W*$/i;
const setsStanding = (t) => STANDING_SET_RE.test(t) || (BARE_INTERPRET_RE.test(t) && !!languageNamed(t));
// Greek, Cyrillic, Hebrew, Arabic, Indic, Thai, Japanese, Chinese and Korean scripts: not English.
const NON_LATIN_RE = /[Ͱ-ϿЀ-ӿ֐-ۿऀ-෿฀-๿぀-ヿ㐀-鿿가-힯]/;
// Plainly English: two of these words, or one in a line of four words or fewer. Words that are
// also Spanish, Italian, French or German ("a", "no", "in", "on", "do", "me") are not counted.
const ENGLISH_WORDS_RE = /\b(?:the|and|is|are|was|were|you|he|she|it|we|they|my|your|of|for|with|this|that|what|where|when|how|why|who|does|did|can|could|would|will|please|thank|thanks|hello|yes|not|okay|have|has|there|here|from|want|need|like|much|many)\b/gi;
function looksEnglish(text) {
  const t = String(text || '');
  const hits = (t.match(ENGLISH_WORDS_RE) || []).length;
  return hits >= 2 || (hits === 1 && t.trim().split(/\s+/).length <= 4);
}
const STANDING_TTL_MS = 2 * 60 * 60 * 1000;
// How long the cloud model gets for its first words on an interpreting line before the hub's own
// translator, when one is installed, answers instead. Healthy, gemini-3.5-flash-lite starts in
// 0.5-0.9 s.
const INTERPRET_FIRST_TOKEN_MS = 2500;
// After this many interpreting lines in a row with nothing from the cloud, the cloud is skipped
// for INTERPRET_CLOUD_PAUSE_MS and the hub's translator answers at once (~0.3 s), not after the
// 2.5 s wait: with one model out of quota and the other stalling, every line took ~2.8 s
// (2026-11-03). The first line after the pause tries the cloud again.
const INTERPRET_CLOUD_TRIES = 2;
const INTERPRET_CLOUD_PAUSE_MS = 2 * 60_000;
const _interpretCloud = { fails: 0, pausedUntil: 0 };
// Lines coming out in these languages go to the cloud first; every other line goes to the hub's
// translator first. On 100 held-out lines per direction it scored chrF 76 overall and 77-87 for
// most directions, but 48.6 into Japanese and 35.7 into Chinese (2026-11-04). So the free daily
// quota is spent only there, and running out of it no longer adds a 2.5 s wait to every line.
// Those numbers are MADLAD's. A language with a quickmt model is not cloud first any more: 0.04 s
// against the cloud's 0.9 s, and on everyday lines every fact into Japanese right (pairInstalled).
const INTERPRET_CLOUD_FIRST = new Set(['ja', 'zh', 'yue']);

// Whether a device is interpreting now, read only: /query/stream picks the speech model by the
// language it names ({ code: "ja", name: "Japanese" }; code null when none was named) before the
// turn reaches routeStream. null when not interpreting.
export function interpretingFor(key) {
  const s = standing().get(key || 'default');
  if (!inForce(s) || !INTERPRET_RE.test(s.text)) return null;
  return interpretingLanguage(s);
}

// After a Craft swap or a restart, the speech model for a language he is still interpreting is
// loaded again before the other person's next line, not by it (~4 s on a busy hub).
setTimeout(() => {
  try {
    for (const s of standing().values()) {
      if (inForce(s) && INTERPRET_RE.test(s.text)) warmForLanguage(interpretingLanguage(s).code);
    }
  } catch {}
}, 10_000).unref?.();

// The language an interpreting instruction is for: the one he named, else the one Whisper heard
// the other person speak (learnInterpretingLanguage), else { code: null } and Whisper hears all.
function interpretingLanguage(s) {
  return languageNamed(s.text) || (s.lang ? { code: s.lang, name: languageName(s.lang) } : { code: null, name: null });
}

/**
 * "Be our interpreter" with no language: the first clear line Whisper hears from the other person
 * says which, and the lines after it go to that language's faster model (hub-asr.js). Whisper
 * names what it heard; a wrong name on a scrap of speech would stick, so only a full line counts.
 */
export function learnInterpretingLanguage(key, code, heard) {
  const s = standing().get(key || 'default');
  if (!s || s.lang || !code || code === 'en' || String(heard || '').trim().length < 12) return;
  if (!INTERPRET_RE.test(s.text) || languageNamed(s.text)) return;
  s.lang = code;
  saveMode(key || 'default', s);
  console.log(`[interpreting] no language named; heard ${code} (${languageName(code) || '?'}), using it`);
  warmForLanguage(code);
}

// The words around an instruction that say nothing else: "from now on translate EVERYTHING I
// SAY INTO Japanese", "SHE SPEAKS Spanish", "OKAY stop translating". A line that is only these,
// the instruction and a language name is the instruction and nothing more.
const INSTRUCTION_FILLER = /\b(she|he|they|we|i'?m|i'?ve|i|you|me|us|her|him|them|it|it'?s|speaks?|speaking|in|into|to|is|are|please|the|a|an|language|only|our|my|his|their|friend|other|person|people|and|so|be|for|from|now|right|no|yes|yeah|on|everything|all|that|what|say|says|saying|said|told|between|can|could|would|will|mode|okay|ok|alright|hey|pan|then|just|of|both)\b/gi;
const INTERPRET_ALL_RE = new RegExp(INTERPRET_RE.source, 'gi');

function onlyInstruction(rest, named) {
  const r = named ? rest.replace(new RegExp(`\\b${named.name}\\b`, 'i'), '') : rest;
  return !r.replace(INTERPRET_ALL_RE, '').replace(INSTRUCTION_FILLER, '').replace(/[^a-z]+/gi, '');
}

function interpretAck(name) {
  return name ? `Okay, I'll interpret. ${name} and English.` : "Okay, I'll interpret.";
}

// "Translate that" / "say that again" while interpreting means PAN's last line, said again: the
// model translated the request itself ("Λοιπόν, μετάφρασέ το αυτό στα ελληνικά", 2026-11-03).
const SAY_AGAIN_RE = /^\s*(?:(?:so|okay|ok|now|please|and|just|can you|could you)\s+)*(?:translate|say|repeat)\s+(?:that|it|this)(?:\s+(?:again|one more time))?(?:\s+(?:in|into|to)\s+\w+)?(?:\s+(?:please|again|now))?[\s.!?]*$/i;

// The script a reply in another language has to be written in. The phone picks the voice by the
// script (TtsManager.scriptLocale), so a romanized line ("kalimera", "Arigatou") was read out
// by the English voice, and asking for "its own script" was not enough (2026-11-03).
const SCRIPTS = {
  el: 'the Greek alphabet', ja: 'Japanese kana and kanji', zh: 'Chinese characters', yue: 'Chinese characters',
  ko: 'Hangul', ru: 'Cyrillic', uk: 'Cyrillic', bg: 'Cyrillic', sr: 'Cyrillic', ar: 'Arabic script',
  fa: 'Arabic script', ur: 'Arabic script', he: 'the Hebrew alphabet', hi: 'Devanagari', th: 'Thai script',
  ka: 'the Georgian alphabet', hy: 'the Armenian alphabet', bn: 'Bengali script',
};
function inScript(code) {
  return SCRIPTS[code] ? `, written in ${SCRIPTS[code]}, never in Latin letters` : '';
}

// "Ask them how much this costs" is said to them as "How much does this cost?". A translator
// only translates, and NLLB said "Ρώτα τους πόσο κοστίζει αυτό" to the shopkeeper (2026-11-03).
// The common shapes of "ask them ..." and "tell her ...", for the hub's translator (the cloud
// model is told the same in its prompt); null for any other line. He also leads in with words for
// PAN ("I need you to ask them ...", "No, I said tell her ...") and repeats himself as "I asked
// them how much this costs", which the hub said word for word (2026-11-04).
const SPOKEN_LEAD = /^\s*(?:(?:so|and|okay|ok|alright|all right|no|well|look|hey|pan|um|uh|now|please|just|then|can you|could you|would you|i said(?: to)?|i(?:['’]d like| (?:need|want|wanted|would like|asked|told)) you to)[\s,]+)*/i;
const TO_YOU = [
  [/\b(?:they|she|he)'re\b/gi, "you're"], [/\b(?:she|he)'s\b/gi, "you're"], [/\b(?:they|she|he)'ve\b/gi, "you've"],
  [/\b(?:they|she|he)'ll\b/gi, "you'll"], [/\b(?:they|she|he)'d\b/gi, "you'd"], [/\b(?:themselves|himself|herself)\b/gi, 'yourself'],
  [/\b(?:their|his)\b/gi, 'your'], [/\bher\b(?=\s*$|\s*[,.!?]|\s+(?:to|for|with|about|and|if|that|now|please|again)\b)/gi, 'you'],
  [/\bher\b/gi, 'your'], [/\b(?:they|she|he|them|him)\b/gi, 'you'],
  [/\byou (is|was|has|does|doesn't|isn't|wasn't|hasn't)\b/gi, (m, v) => `you ${{ is: 'are', was: 'were', has: 'have', does: 'do', "doesn't": "don't", "isn't": "aren't", "wasn't": "weren't", "hasn't": "haven't" }[v.toLowerCase()]}`],
  [/\byou (wants|needs|likes|knows|speaks|takes|accepts|sells|serves|goes|sees|makes|gets|thinks|works|lives|comes|understands|prefers|recommends|delivers)\b/gi, (m, v) => `you ${verbBase(v)}`],
];
function toYou(s) {
  return TO_YOU.reduce((t, [re, w]) => t.replace(re, w), String(s));
}
function verbBase(v) {
  const w = v.toLowerCase();
  return { has: 'have', does: 'do', goes: 'go' }[w] || w.replace(/(ss|sh|ch|x|o)es$/, '$1').replace(/ies$/, 'y').replace(/s$/, '');
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function askedAs(body) {
  // A closing "please" was for PAN; "for the bill" already says it.
  const b = body.trim().replace(/[\s,]+please$/i, '');
  let m;
  if ((m = b.match(/^for (.+)$/i))) return `${cap(toYou(m[1]))}, please.`;
  if ((m = b.match(/^to (.+)$/i))) return `Please ${toYou(m[1])}.`;
  if ((m = b.match(/^(?:if|whether) (?:they|she|he|you) (can|could|will|would) (.+)$/i))) return `${cap(m[1].toLowerCase())} you ${toYou(m[2])}?`;
  if ((m = b.match(/^(?:if|whether) (?:they|she|he|you) (?:are|is) (.+)$/i))) return `Are you ${toYou(m[1])}?`;
  if ((m = b.match(/^(?:if|whether) (?:they|she|he|you) (?:have|has) (.+)$/i))) return `Do you have ${toYou(m[1])}?`;
  if ((m = b.match(/^(?:if|whether) (?:they|she|he|you) (\w+) (.+)$/i))) return `Do you ${verbBase(m[1])} ${toYou(m[2])}?`;
  if ((m = b.match(/^(?:if|whether) (there|it|this|that|these|those|the \w+) (is|are|was|were) (.+)$/i))) return `${cap(m[2].toLowerCase())} ${m[1]} ${toYou(m[3])}?`;
  if ((m = b.match(/^(?:if|whether) (it|this|that|the \w+) (\w+?s) (.+)$/i))) return `Does ${m[1]} ${verbBase(m[2])} ${toYou(m[3])}?`;
  if ((m = b.match(/^(how much|how many|how long|how far|how|where|when|what time|what|which|who|why) (.+)$/i))) {
    const wh = cap(m[1].toLowerCase());
    const rest = m[2];
    let r;
    if ((r = rest.match(/^(this|it|that|these|those|the \w+(?: \w+)?) (is|are|was|were)$/i))) return `${wh} ${r[2]} ${r[1]}?`;
    if ((r = rest.match(/^(?:they|she|he|you) (?:are|is) (.+)$/i))) return `${wh} are you ${toYou(r[1])}?`;
    if ((r = rest.match(/^(?:they|she|he|you) (\w+)(.*)$/i))) return `${wh} do you ${verbBase(r[1])}${toYou(r[2])}?`;
    if ((r = rest.match(/^(this|it|that|the \w+(?: \w+)?) (\w+s)\b(.*)$/i))) return `${wh} does ${r[1]} ${verbBase(r[2])}${toYou(r[3])}?`;
    return `${wh} ${toYou(rest)}?`;
  }
  return `${cap(toYou(b))}?`;
}
function toDirectSpeech(line) {
  const t = String(line || '').trim().replace(SPOKEN_LEAD, '');
  let m = t.match(/^(?:ask|i asked) (?:them|her|him|the \w+)\s+(.+?)[\s.?!]*$/i)
    || t.match(/^ask\s+((?:if|whether|for|how|where|when|what|which|who|why)\b.+?)[\s.?!]*$/i);
  if (m) return askedAs(m[1]);
  m = t.match(/^(?:tell (?:them|her|him|the \w+)|let (?:them|her|him|the \w+) know)\s+(?:that\s+)?(.+?)[\s.!]*$/i);
  if (m) return `${cap(toYou(m[1]))}.`;
  return null;
}

// The language a line is written in, by its script; null for Latin. Kanji alone reads as
// Chinese, so a caller that expects Japanese says so.
function scriptLang(text) {
  const t = String(text || '');
  if (/[぀-ヿ]/.test(t)) return 'ja';
  if (/[가-힯]/.test(t)) return 'ko';
  if (/[㐀-鿿]/.test(t)) return 'zh';
  if (/[Ͱ-Ͽ]/.test(t)) return 'el';
  if (/[Ѐ-ӿ]/.test(t)) return 'ru';
  if (/[֐-׿]/.test(t)) return 'he';
  if (/[؀-ۿ]/.test(t)) return 'ar';
  if (/[ऀ-ॿ]/.test(t)) return 'hi';
  if (/[฀-๿]/.test(t)) return 'th';
  return null;
}

// His last line in the history ("translate that" points at it).
function lastUserLine(history) {
  for (const line of String(history || '').split('\n').reverse()) {
    const m = line.match(/^User:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

function lastTranslation(history) {
  const lines = String(history || '').split('\n').reverse();
  for (const line of lines) {
    const m = line.match(/^PAN:\s*(.+)$/);
    if (m && !/^Okay, (I'll interpret|I've stopped)/.test(m[1]) && !/^Okay, \w+\.$/.test(m[1])) return m[1].trim();
  }
  return null;
}

// The lines that only switch interpreting on, say its language or switch it off get a fixed
// reply, at once: the local model took 2-3 s to answer them and said "I'm not a native speaker,
// you'll have to teach me the nuance first" to "be my Turkish interpreter", and "She speaks
// Spanish?" to "she speaks Spanish", over the first words of the person he was talking to
// (2026-11-03). Only a line that is the instruction and nothing else: "translate for her: how
// much is this?" still goes on whole. Read before standingInstruction() changes anything.
function interpreterAck(key, text) {
  const t = String(text || '');
  const s = standing().get(key);
  const on = inForce(s) && INTERPRET_RE.test(s.text);
  const named = languageNamed(t);
  if (STANDING_CLEAR_RE.test(t)) {
    // With the language in it too: a stop line that named the language fell through here, was translated
    // into Japanese as a line of its own and left the phone interpreting (2026-11-17). And with
    // nothing in force on the hub: the phone may still think it is interpreting, and the event
    // after this reply is what ends it there.
    if (!onlyInstruction(t.replace(new RegExp(STANDING_CLEAR_RE.source, 'gi'), ''), named)) return null;
    return on ? "Okay, I've stopped." : "I'm not interpreting.";
  }
  if (setsStanding(t) && INTERPRET_RE.test(t)) {
    const rest = STANDING_SET_RE.test(t) ? t.replace(new RegExp(STANDING_SET_RE.source, 'gi'), '') : '';
    if (!onlyInstruction(rest, named)) return null;
    return interpretAck(named?.name);
  }
  if (named && on && !languageNamed(s.text) && !s.lang && onlyInstruction(t, named)) return `Okay, ${named.name}.`;
  // A repeat of the instruction while it is in force ("everything I say into Greek", the phone
  // having sent the start of it as a turn of its own): confirm it, do not translate it.
  if (on && /\b(everything|all)\b/i.test(t) && onlyInstruction(t, named)) return interpretAck(interpretingLanguage(s).name);
  return null;
}

/** The instruction in force for this turn, or null. The turn that sets one returns null. */
function standingInstruction(key, text) {
  const t = String(text || '');
  if (STANDING_CLEAR_RE.test(t)) { standing().delete(key); dropMode(key); return null; }
  if (setsStanding(t)) {
    const entry = { text: t.trim(), at: Date.now() };
    standing().set(key, entry);
    saveMode(key, entry);
    if (!INTERPRET_RE.test(t)) return null;
    // The other person's first line should not wait for its speech model to load.
    warmForLanguage(languageNamed(t)?.code);
    // The interpreter answers this turn too (standingPrompt, `setting`): "I told you to translate
    // everything in Greek, so I said, ask them how much this costs" has words for the other
    // person in it, and the local model called that line room talk (2026-11-03). A line that is
    // only the instruction never gets here (interpreterAck).
    return { ...entry, setting: true };
  }
  const s = standing().get(key);
  if (!s) return null;
  if (!inForce(s)) { standing().delete(key); dropMode(key); return null; }
  // "Be our interpreter" [pause] "she speaks Spanish": the phone sends the pause as two turns.
  // The second only says the language the first left out, so it is the rest of the instruction,
  // not a line to translate.
  const named = languageNamed(t);
  if (named && INTERPRET_RE.test(s.text) && !languageNamed(s.text) && !s.lang && onlyInstruction(t, named)) {
    s.text = `${s.text} ${t.trim()}`;
    saveMode(key, s);
    warmForLanguage(named.code);
    return null;
  }
  s.last = Date.now();
  saveMode(key, s);
  return s;
}

// Fast ambient pre-filter — detects speech clearly not directed at PAN without LLM call
// Only fires for voice/mic input (dashboard input is always a command)
function quickAmbientCheck(text) {
  const t = text.trim();
  // 1. Addressing someone else by name: "hey John", "hi Sarah", "hello guys"
  //
  // The exclusion list is the whole rule. Anything this catches is muted
  // WITHOUT ever reaching the classifier, so a word wrongly treated as a name
  // silently swallows the turn - "hey listen do you think this holds up" was
  // dropped on the floor, and so were "hey so", "hey wait", "hey quick".
  // Found by ambient-trap-hey-opener in the corpus.
  //
  // Everything here is a word that can FOLLOW "hey" while he is talking to PAN:
  // question words, discourse markers, pronouns, and the familiar forms he uses
  // toward PAN as readily as toward a person. A pre-filter earns its place only
  // by being nearly always right; when in doubt it must defer to the classifier,
  // which now has a calibrated number for exactly this.
  const NOT_A_NAME = '(?:pan|pam|what|how|when|where|why|who|which|can|could|would|should|will|do|does|did|is|are|am|was|have|has|had|so|the|a|an|listen|look|look-see|wait|hold|hang|quick|quickly|sorry|just|um|uh|erm|er|ok|okay|alright|right|yeah|yes|no|now|again|also|about|by|for|one|two|real|really|mate|man|dude|buddy|love|there|here|this|that|these|those|it|its|i|im|ive|id|ill|we|weve|you|your|youre|my|me|us|they|them|he|she|his|her|tell|show|give|play|open|set|remind|add|search|find|send|call|start|stop|turn|make|read|write|check|help|got|get|need|want|think|know|remember)';
  if (new RegExp('^(?:hey|hi|hello)\\s+(?!' + NOT_A_NAME + '\\b)[a-z]{2,}', 'i').test(t)) return true;
  // 2. Common person nouns as direct address at start
  if (/^(?:mom|dad|honey|babe|sis|bro|buddy|guys|everyone|y'all|folks)\b/i.test(t)) return true;
  // 3. "I'll be there / meet you / call you back" — talking to someone else
  if (/^I'(?:ll|m)\s+(?:be\s+there|meet\s+you|call\s+you\s+back|see\s+you)/i.test(t)) return true;
  // 4. Name + "I'll meet/be/call" — "Sarah I'll meet you..."
  //
  // Only with the same talking-to-someone phrases as rule 3. It used to be any
  // "<Word> I'm/I'll ..." under the i flag, so "So I'm thinking we should redo the
  // pendant" and "Honestly I'm exhausted" never reached the model (voice plan,
  // phase 1). A sentence-initial word cannot be told from a name by shape alone.
  const TO_SOMEONE = String.raw`(?:be\s+there|meet\s+you|call\s+you(?:\s+back)?|see\s+you|on\s+my\s+way)`;
  if (new RegExp(String.raw`^[a-z]+[,.]?\s+I'(?:ll|m)\s+` + TO_SOMEONE, 'i').test(t)) return true;
  // 5. Filler acknowledgement followed by "call/meet/be" — "ok I'll call you back"
  if (new RegExp(String.raw`^(?:ok|okay|alright|yeah|sure|cool|got\s*it)[,.]?\s+I'(?:ll|m)\s+` + TO_SOMEONE, 'i').test(t)) return true;
  return false;
}

// Quick system handlers that need no Claude call at all
async function tryQuickSystem(text) {
  const lower = text.toLowerCase();

  if (lower.includes('status')) {
    const stats = getScoped(null, `SELECT
      (SELECT COUNT(*) FROM events WHERE org_id = :org_id) as events,
      (SELECT COUNT(*) FROM memory_items WHERE org_id = :org_id) as memories,
      (SELECT COUNT(*) FROM projects WHERE org_id = :org_id) as projects
    `);
    return {
      intent: 'system',
      response: `PAN status: ${stats.events} events, ${stats.memories} memories, ${stats.projects} projects.`
    };
  }

  // PC/desktop sleep — must check BEFORE the generic "sleep" PAN-pause handler below
  if (lower.includes('sleep') && (lower.includes('computer') || lower.includes(' pc') || lower.includes('desktop') || lower.includes('machine'))) {
    const { execSync } = await import('child_process');
    try {
      if (process.platform === 'win32') {
        execSync('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', { windowsHide: true });
      } else {
        execSync('systemctl suspend', {});
      }
      return { intent: 'system', response: 'Putting the computer to sleep.' };
    } catch (e) {
      return { intent: 'system', response: `Couldn't sleep the computer: ${e.message}` };
    }
  }

  if (lower.includes('stop') || lower.includes('pause') || lower.includes('sleep')) {
    return { intent: 'system', response: 'PAN paused. Say "PAN wake up" to resume.', action: 'pause' };
  }

  // Incognito status check
  if (lower.match(/incognito|private\s*mode/)) {
    try {
      const row = get("SELECT value FROM settings WHERE key LIKE 'incognito_active_%'");
      if (row) {
        const state = JSON.parse(row.value);
        if (state.active) {
          return { intent: 'system', response: `Incognito is on. Started ${Math.round((Date.now() - state.started_at) / 60000)} minutes ago. Events are temporary.` };
        }
      }
      return { intent: 'system', response: 'Incognito is off. All events are being recorded normally.' };
    } catch {
      return { intent: 'system', response: 'Incognito is off.' };
    }
  }

  // Screen recording
  if (lower.match(/start\s+(screen\s+)?record/)) {
    const { startRecording } = await import('./screen-recorder.js');
    const result = startRecording({ fps: 2 });
    if (result.error) return { intent: 'system', response: `Already recording: ${result.file}` };
    return { intent: 'system', response: `Recording started at 2 FPS. Say "stop recording" when done.` };
  }

  if (lower.match(/stop\s+(screen\s+)?record/)) {
    const { stopRecording } = await import('./screen-recorder.js');
    const result = stopRecording();
    if (result.error) return { intent: 'system', response: 'Not currently recording.' };
    return { intent: 'system', response: `Recording saved (${result.duration} seconds). File: ${result.file}` };
  }

  return null;
}

// Single unified Claude call — classifies AND handles in one shot
async function handleUnified(text, context) {
  const cmdId = context._commandId || null;

  // Debug trace — captured so callers (chat surfaces, comms popout) can show
  // PAN's reasoning alongside the reply. Filled progressively as the call
  // proceeds. Attached to the returned result as `_debug` so it survives the
  // intent-specific shaping in processUnifiedResult.
  const dbg = {
    started_at: Date.now(),
    ai_started_at: null,
    ai_latency_ms: null,
    total_latency_ms: null,
    model: null,
    caller: 'router',
    source: context.source || null,
    intent: null,
    why: null,
    recall_hit: false,
    skill_matched: null,
    situation: null,
    conversation: null,
    mind: null,
    raw_response: null,
    error: null,
  };
  try { dbg.model = getModelForCaller('router'); } catch {}

  // Build project list for context
  const projects = allScoped(null, "SELECT name, path FROM projects WHERE org_id = :org_id ORDER BY name");
  const projectList = projects.map(p => `- ${p.name}: ${p.path.replace(/\//g, '\\')}`).join('\n');

  // #NEW-1: Memory lookup is now intent-gated. Pure conversation never hits
  // FTS5/vector — the model emits {intent:"memory",action:"recall"} when it
  // actually needs facts, and processUnifiedResult handles that path (line 495+).
  // Only the explicit recall sniff bypasses the gate on the first pass.
  let memoryContext = '';
  if (asksAboutPast(text, RECALL_RE)) {
    // #461: searchMemory stalls indefinitely when ollama/embeddings are degraded,
    // freezing the whole voice turn past the phone's 30s stream cap (a complex 2nd
    // question hung here and returned null/empty). Bound it — degrade to "answer
    // without memory" instead of hanging.
    let memResults = [];
    try {
      memResults = await Promise.race([
        // vec0 scan is 4-6s and SYNCHRONOUS; see skipVector in memory-search.js.
        // The race below cannot bound it - it blocks its own timer.
        searchMemory(text, { limit: 5, caller: 'router', skipVector: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('searchMemory timeout 2.5s')), 2500)),
      ]);
    } catch (e) {
      memResults = [];
      logStep(cmdId, 'memory_recall_gate', `recall search bailed (${e.message}) — degraded embeddings, answering without memory`);
    }
    memoryContext = memResults.length > 0
      ? `\nRelevant memories:\n${memResults.map(r => `- ${r.preview}`).join('\n')}`
      : '';
    dbg.recall_hit = memResults.length > 0;
    if (memResults.length > 0) logStep(cmdId, 'memory_recall_gate', `recall match — ${memResults.length} hits`);
  } else {
    logStep(cmdId, 'memory_recall_gate', 'no recall match — skipping DB lookup');
  }

  // #NEW-2 + #NEW-3: feed intuition snapshot + recent mind into the prompt so
  // the model answers from the situation, not from raw words alone.
  // #NEW-conv-state: also feed the live conversation-state distillation
  // (topic/phase/pending_question/user_pattern/likely_turn_complete/summary)
  // maintained by conv-state-watcher. The router doesn't think about the
  // whole conversation — it just reads the pre-chewed state.
  //
  // VOICE FAST-PATH (added 2026-06-01): when this is a live voice call we
  // SKIP the heavy context blocks. Building all 10 blocks below pulls 8+s
  // of synchronous SQLite reads on the main thread — fine for the dashboard
  // (user can wait), fatal for voice (the human is listening to silence).
  // Voice gets only the cheap blocks: situation snapshot, recent mind,
  // conv-state distillation. Those three are pre-computed and cheap to read.
  // Everything else (dialog history, active tasks, dismissal feedback,
  // memory facts, episodic hits) is the dashboard / PTY chat experience.
  // Task #63 is the proper fix (move SQLite off main thread); this is the
  // tactical fix so voice calls feel real-time today.
  const isVoiceCall = context.source === 'voice-call' || context.source === 'phone';
  const situationBlock = buildSituationBlock(context.org_id);
  const recentMindBlock = buildRecentMindBlock();
  const convStateBlock  = buildConvStateBlock(context.org_id);
  // #986 batch 1: deeper context — dialog history, active tasks, surfaces,
  // dismissal feedback, memory facts, episodic hits. ~5k tokens total.
  // All defensive: missing table → empty block.
  // Dialog-state key: use session_id when present (voice/PTY), thread_id when
  // the call comes through /api/v1/chat (dashboard), or a fixed 'global' key
  // so the in-memory Map still works for ad-hoc calls without continuity loss.
  const dialogKey = context.session_id || context.thread_id || 'global';
  const dialogHistoryBlock     = isVoiceCall ? '' : buildDialogHistoryBlock(context.session_id || null);
  const dialogStateBlock       = buildDialogStateBlock(dialogKey); // cheap — in-memory Map, keep
  const activeTasksBlock       = isVoiceCall ? '' : buildActiveTasksBlock();
  const recentTopicsBlock      = isVoiceCall ? '' : buildRecentTopicsBlock();
  const dismissalFeedbackBlock = isVoiceCall ? '' : buildDismissalFeedbackBlock();
  const memoryFactsBlock       = isVoiceCall ? '' : buildMemoryFactsBlock();
  const episodicHitsBlock      = isVoiceCall ? '' : buildEpisodicHitsBlock();
  try {
    const cs = getConversationState(context.org_id || null);
    if (cs) {
      dbg.conversation = {
        topic: cs.topic || null,
        phase: cs.phase || null,
        pending_question: cs.pending_question || null,
        user_pattern: cs.user_pattern || null,
        likely_turn_complete: cs.likely_turn_complete ?? null,
        summary: cs.summary || null,
        distilled_at: cs.distilled_at || null,
        latency_ms: cs.latency_ms || null,
      };
    }
  } catch {}

  // Capture raw versions for the debug trace shown in the comms popout.
  try {
    const snap = getCurrentSnapshot(context.org_id || null);
    dbg.situation = snap?.now ? {
      where: snap.now.where || null,
      activity: snap.now.activity || null,
      focus: snap.now.focus || null,
      direction: snap.now.direction || null,
      mood: snap.now.mood || null,
      need: snap.now.need || null,
      engagement: snap.now.engagement || null,
      commander: snap.commander || null,
      last_heard: snap.now.last_heard ? String(snap.now.last_heard).slice(0, 200) : null,
    } : null;
  } catch {}
  // Raw mind stream is fed to the prompt (situation+mind blocks above) but NOT
  // exposed in the UI debug — the user only wants the synthesized `mind`
  // sentence from the model, not the raw 6-thought list. Keep collecting in
  // buildRecentMindBlock; just don't echo it back.

  // Include conversation history if available
  const conversationHistory = context.conversation_history || '';
  const historyBlock = conversationHistory
    ? `\nRecent conversation:\n${conversationHistory}\n`
    : '';

  // Include sensor data if available
  const sensors = context.sensors || null;
  let sensorBlock = '';
  if (sensors) {
    const parts = [];
    const phone = sensors.phone || {};
    if (phone.gps) {
      const addr = phone.gps.address ? ` (${phone.gps.address})` : '';
      parts.push(`Location: ${phone.gps.lat?.toFixed(5)}, ${phone.gps.lng?.toFixed(5)}${addr}${phone.gps.altitude ? ` alt:${Math.round(phone.gps.altitude)}m` : ''}${phone.gps.speed ? ` speed:${phone.gps.speed.toFixed(1)}m/s` : ''}`);
    }
    if (phone.compass != null) parts.push(`Compass: ${Math.round(phone.compass)}°`);
    if (phone.barometer_hpa != null) parts.push(`Pressure: ${phone.barometer_hpa.toFixed(0)}hPa`);
    if (phone.light_lux != null) parts.push(`Light: ${Math.round(phone.light_lux)}lux`);
    if (phone.accelerometer) parts.push(`Accel: x=${phone.accelerometer.x?.toFixed(1)} y=${phone.accelerometer.y?.toFixed(1)} z=${phone.accelerometer.z?.toFixed(1)}`);
    const pendant = sensors.pendant || {};
    if (pendant.temperature_c != null) parts.push(`Temp: ${pendant.temperature_c}°C`);
    if (pendant.humidity_pct != null) parts.push(`Humidity: ${pendant.humidity_pct}%`);
    if (pendant.gas) parts.push(`Gas: ${JSON.stringify(pendant.gas)}`);
    if (parts.length > 0) sensorBlock = `\nUser's current sensor readings: ${parts.join(' | ')}\n`;
  }

  // NanoClaw: check for matching skill before calling Claude
  // findSkill returns { skill, params } or null
  const skillMatch = findSkill(text);
  const skillBlock = skillMatch
    ? (logStep(cmdId, 'skill_matched', `${skillMatch.skill.name}${Object.keys(skillMatch.params).length ? ' params:' + JSON.stringify(skillMatch.params) : ''}`), getSkillPrompt(skillMatch))
    : '';
  if (skillMatch) {
    try { dbg.skill_matched = { name: skillMatch.skill.name, params: skillMatch.params || {} }; } catch {}
  }

  logStep(cmdId, 'unified_call', 'single Claude call for classify+handle');

  let raw = '';
  try {
    const isDash = context.source === 'dashboard';
    // Load personality from settings
    const personality = personalityFor(context);
    const personalityBlock = personality ? `\nPersonality: ${personality}\nAlways stay in character.` : '';
    // Anonymize user text ONLY — sensor data (GPS, etc.) must pass through
    // so location-aware queries work. The sensor block is structured data the
    // user consented to share; the text may contain unintentional PII.
    const safeText = anonymizeForAI(text);

    const hintBlock = context.intent_hint
      ? `\nOVERRIDE: Server pattern matched — your response MUST use {"intent":"${context.intent_hint}",...}. Do not use a different intent.\n`
      : '';
    dbg.ai_started_at = Date.now();
    // #996: route through the fallback chain (ai_fallback_chain_*).
    // Honors `ai_fallback_enabled=false` for users who want single-backend semantics.
    const _fallbackMeta = {};
    let weatherBlock = '';
    try { weatherBlock = await buildToolBlocks(text, sensors, { recent: talkBefore(context, text), skip: toolSkips(context?.device_id, text) }); } catch {}
    let selfBlock = '';
    try { selfBlock = buildSelfBlock(); } catch {}
    raw = await askAIWithFallback(
      `You are PAN, a personal AI. Be conversational, short (1-2 sentences, TTS). Return only JSON.${personalityBlock}
${memoryFactsBlock}${activeTasksBlock}${recentTopicsBlock}${dismissalFeedbackBlock}${dialogHistoryBlock}${historyBlock}${situationBlock}${convStateBlock}${dialogStateBlock}${recentMindBlock}${episodicHitsBlock}${skillBlock}${sensorBlock}${weatherBlock}${selfBlock}${hintBlock}

=== CURRENT TURN ===
${isDash ? `The commander just said: "${safeText}"` : `Mic heard (may have STT typos/garbling — infer the most likely intent): "${safeText}"`}
Answer THIS message specifically. The blocks above are background context — use them to ground your answer, but the response must address what the commander just said, not what was said before.

${isDash ? 'Always respond.' : 'CRITICAL: If speech is clearly NOT directed at you (PAN), return ambient — but you MAY still interject vocally if the ambient conversation reveals something you should warn about, correct, or volunteer. See AMBIENT INTERJECTION RULES below.'}
${isDash ? '' : `Rule: no question and no command for PAN → ambient.
NEVER ambient: questions (what/when/where/how/why/who/can you), commands (play/open/set/remind/add), anything addressed to "Pan"/"Pam".
Ambient: side-conversation to another person, or a statement not asking PAN anything ("I'll call you back", "yeah that makes sense").

AMBIENT INTERJECTION RULES (only for ambient turns):
Set "interjection" (1 sentence, ≤ 15 words) ONLY when a trigger fires:
- SAFETY: about to do something dangerous. High confidence only — wrong guesses are nagging.
- CORRECTION: says something recent context proves wrong.
- VOLUNTEER: wonders aloud ("what was that song again") and PAN actually knows.
- TIME-CRITICAL: what they just said makes a scheduled event relevant now.
Otherwise OMIT the field. Silence is the default — never chatter on filler, agreement, or thinking-aloud.
Response shape when interjecting: {"intent":"ambient","response":"[AMBIENT]","interjection":"Hey, the meeting starts in five.","interjection_reason":"safety|correction|volunteer|time"}`}

Two debug fields, both required, both ONE sentence, never lists:
- "why" (≤ 20 words): why you chose this reply for this utterance. Current turn only.
- "mind" (≤ 25 words): your current read on the user/situation, blending the situation and recent-mind blocks into one thought ("Watching them debug PAN routing; focused, asking direct questions"). Do not restate raw thoughts.

CLASSIFICATION RULES (read carefully — most utterances are NOT terminal):
- A QUESTION about PAN's abilities ("can you do X", "does this work", "is it possible") → intent: "query". NEVER terminal.
- A request to OPEN a terminal/project ("open WoE terminal") → intent: "terminal", action: "open".
- SEND/TYPE text into a terminal ("send hello to the terminal", "type ls in the WoE tab") → intent: "terminal", action: "pipe". "text" = the literal text, unquoted. "target" = a real project/tab name only (PAN, WoE, ...); omit it entirely for generic words like "terminal"/"tab"/"console" so PAN uses the active tab. Never claim you sent something without this action.
- When in doubt between query and terminal → choose query.

"speech_act" (required): command | query | note (first-person thought) | monologue (thinking aloud) | social (to someone else in the room) | ambient (not directed at anyone).

"importance" (0..1, default 0.5) — drives TTS prosody:
  0.0-0.3 casual ack, small-talk · 0.3-0.7 normal answer or confirmation (DEFAULT) · 0.7-1.0 critical/time-sensitive ("deploy failed", "battery 2%").

Response formats:
{"intent":"query","speech_act":"query","response":"answer","importance":0.5} — questions/conversation
{"intent":"terminal","speech_act":"command","action":"open|pipe|send-text|get-text|list-panes","project":"path","name":"name","target":"tab/project name (for pipe)","text":"text to type","pane_id":0,"response":"msg","importance":0.4}
{"intent":"system","speech_act":"command","command":"PowerShell cmd","response":"msg","importance":0.4}
{"intent":"browser","speech_act":"command","action":"list_tabs|read_tab|activate_tab|type_text|click_element|navigate","query":"tab/URL","text":"input","response":"msg","importance":0.4}
{"intent":"memory","speech_act":"note","action":"save|recall","item_type":"type","content":"data","response":"msg","importance":0.4}
{"intent":"music","speech_act":"command","query":"song","service":"spotify|youtube|any","response":"msg","importance":0.4}
{"intent":"calendar","speech_act":"command","response":"msg","importance":0.4}
{"intent":"home","speech_act":"command","action":"on|off|toggle","target":"device as spoken","response":"msg","importance":0.4} — Home Assistant physical devices: lights, plugs, switches, locks, fans, covers, scenes. "turn on the theater", "kill the lights", "lock the front door" → home, NOT music/clarification. "target" is the user's own wording; never invent an entity_id, PAN resolves it.
{"intent":"task","speech_act":"command","text":"instruction for the Claude session","response":"short ack","importance":0.4} — code edits, file searches, multi-step work over the codebase. Only when query/system/browser/terminal cannot do it.
{"intent":"claude_control","speech_act":"command","text":"verbatim instruction","response":"short ack","importance":0.4} — computer control on the Hub's always-on Claude PTY ("open notepad", "rename my Downloads screenshots", "set volume to 50"). Prefer this over "system" whenever the action needs reasoning, naming, or more than one deterministic command. In doubt → claude_control.

Projects: ${projectList}
${memoryContext}`,
      { caller: 'router', callerClass: 'voice', _skipAnonymize: true, source: context.source, device_id: context.device_id, outMeta: _fallbackMeta }
    );

    dbg.ai_latency_ms = Date.now() - dbg.ai_started_at;
    dbg.raw_response = (raw || '').slice(0, 2000);
    // #996: surface fallback metadata so the "🧠 why" dashboard panel shows
    // which backend actually answered. Single-attempt is omitted to keep payload small.
    if (_fallbackMeta.attempts && _fallbackMeta.attempts.length > 1) {
      dbg.fallback_attempts = _fallbackMeta.attempts;
      dbg.served_by = _fallbackMeta.model;
    }
    logStep(cmdId, 'unified_response', raw.slice(0, 200));

    // Strip thinking tags (Qwen 235B sometimes wraps in <think>...</think>)
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // Extract JSON if wrapped in other text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];

    const action = JSON.parse(cleaned);
    dbg.intent = action.intent || null;
    dbg.why = typeof action.why === 'string' ? action.why.slice(0, 400) : null;
    dbg.mind = typeof action.mind === 'string' ? action.mind.slice(0, 500) : null;

    // PAN's-Mind thought — describe what PAN heard and what it decided to do.
    // Ambient utterances get a quieter line; real commands get a higher-importance one.
    try {
      const intent = action.intent || 'query';
      const heardShort = (text || '').trim().slice(0, 80);
      // Life Needs side-channel — scan utterance for meal/hunger phrases
      // regardless of intent (ambient mention of "just had lunch" still moves
      // Nourishment). Cheap regex; failures are non-fatal.
      if (!isBench()) {
        try { noteMealMention(text || '', { source: context?.source || null, intent }); } catch {}
        try { noteSignalsInUtterance(text || '', { source: context?.source || null, intent }); } catch {}
      }
      if (intent === 'ambient') {
        // Ambient interjection — when the model decided this ambient utterance
        // warrants speaking up (safety / correction / volunteer / time-critical),
        // it sets action.interjection. Route through dispatchAction so it goes
        // through the same device-aware speak channel + dedupe + audit log as
        // any other interjection. The chat-thread row gets the brief vocal
        // text as both subject (preview) and body (full).
        if (typeof action.interjection === 'string' && action.interjection.trim().length > 0) {
          const interText = action.interjection.trim().slice(0, 200);
          const interReason = String(action.interjection_reason || 'volunteer').toLowerCase();
          writeThought('router', `Ambient: "${heardShort}" — interjecting (${interReason}): "${interText}"`, { intent, interjection_reason: interReason }, 0.6);
          // Fire-and-forget — don't block the router response. dispatchAction
          // is idempotent on action_key, so even if this duplicates with the
          // intuition deliberation later, only one speak goes out.
          import('./intuition/action.js').then(({ dispatchAction }) => {
            dispatchAction({
              id: `ambient:${interReason}`,
              kind: 'ambient',
              score: 0.7,
              reason: heardShort,
            }, {
              userId: 'owner',
              scoreCtx: { snapshot: { now: { where: context?.where || null } } },
              // Override phrase so the dispatch uses the model's verbatim
              // interjection rather than a generic template.
              phraseOverride: {
                subject: interText.slice(0, 60),
                body:    interText,
                speak:   interText,
              },
            }).catch(() => {});
          }).catch(() => {});
        } else {
          writeThought('router', `I heard "${heardShort}" — not addressed to me, ignoring.`, { intent }, 0.1);
        }
      } else {
        const verb = intent === 'query'
          ? 'answering'
          : intent === 'terminal' ? 'running a terminal action'
          : intent === 'system' ? 'running a system command'
          : intent === 'memory' ? 'saving/recalling a note'
          : intent === 'music' ? 'starting music'
          : intent === 'task' ? 'delegating a task to a Claude session'
          : `handling ${intent}`;
        writeThought('router', `Commander said "${heardShort}" — I'm ${verb}.`, { intent, source: context?.source || null }, 0.7);
      }
    } catch { /* non-fatal */ }

    // #986 batch 1: persist dialog state for next turn.
    // - If model emitted a question (speech_act:'question' or response ends '?'),
    //   record it as open_question so next user utterance is read as the answer.
    // - If user reply was a one-word affirmation/negation, clear any open_question.
    // - Always update last_topic with the model's `mind` synthesis or response.
    try {
      const sid = context?.session_id || context?.thread_id || 'global';
      if (sid) {
        const respTxt   = String(action.response || '').trim();
        const isQuestion = (action.speech_act === 'question') || (/\?\s*$/.test(respTxt) && respTxt.length < 200);
        const userShort  = String(text || '').trim().toLowerCase();
        const isYesNo    = /^(yes|yeah|yep|sure|ok|okay|no|nope|nah|sounds good|do it|go ahead|cancel)\.?$/.test(userShort);
        const topicSeed  = (typeof action.mind === 'string' && action.mind) || respTxt.slice(0, 200);
        const fields = { last_topic: topicSeed };
        if (isQuestion)  fields.open_question = respTxt;
        if (isYesNo)     fields.clear_question = true;
        setDialogState(sid, fields);
      }
    } catch { /* non-fatal */ }

    const finalResult = await processUnifiedResult(action, text, context);
    dbg.total_latency_ms = Date.now() - dbg.started_at;
    try { finalResult._debug = dbg; } catch {}
    return finalResult;
  } catch (e) {
    console.error('[PAN Router] Unified call error:', e.message, '| raw:', typeof raw === 'string' ? raw.slice(0, 300) : raw);
    dbg.error = e.message || String(e);
    dbg.total_latency_ms = Date.now() - dbg.started_at;
    const errResult = { intent: 'query', response: 'PAN is having trouble thinking right now.', importance: 0.5, _debug: dbg };
    try { errResult.prosody = planProsody(errResult); } catch {}
    return errResult;
  }
}

// Resolve which terminal tab/session a "send to terminal" action should hit.
//
// Strategy:
//   1. If `targetHint` is given, match against session id, project name, or
//      session id substring — exact > project-exact > fuzzy. When multiple
//      match, pick the most-recently-active.
//   2. If no hint, pick the most-recently-active PTY, preferring sessions
//      that have a real project tag AND have claude running (the user is
//      almost certainly "talking to" the tab they're actively working in,
//      not the leftover 'default' shell).
//
// Cross-device routing (sending to a tab on a *remote* PC like Predator) is
// not wired here yet — the resolver only sees local PTYs from terminal.js
// `listSessions()`. The user wants this next: device + tab name → remote pipe
// via client-manager. Marked TODO #DEVICE-ROUTE so it doesn't get lost.
async function resolveTerminalTarget(targetHint, context = {}) {
  // PTYs live on the Carrier process, not Craft — direct `listSessions()`
  // import here would read an empty Map. Go through the Super-Carrier HTTP
  // surface which routes terminal endpoints to the Carrier.
  let sessions = [];
  try {
    const PAN_PORT = process.env.PAN_CARRIER_PORT || '7777';
    const res = await fetch(`http://127.0.0.1:${PAN_PORT}/api/v1/terminal/sessions`, { method: 'GET' });
    if (res.ok) {
      const body = await res.json();
      sessions = Array.isArray(body?.sessions) ? body.sessions : [];
    }
  } catch (e) {
    console.warn('[PAN Router] terminal sessions fetch failed:', e?.message);
    sessions = [];
  }

  if (!sessions.length) return { ok: false, reason: 'no_sessions' };

  const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');
  // Strip generic words the LLM tends to literally pass through ("terminal",
  // "tab", "console", "shell", "the terminal") — these mean "any/default",
  // not a real target. Without this guard, "send X to the terminal" fails
  // because no tab is literally named 'terminal'.
  const GENERIC = new Set(['terminal', 'tab', 'console', 'shell', 'theterminal', 'thetab', 'cmd', 'commandline']);
  let hintNorm = norm(targetHint);
  if (GENERIC.has(hintNorm)) hintNorm = '';

  if (hintNorm) {
    const exactId = sessions.find(s => norm(s.id) === hintNorm);
    if (exactId) return { ok: true, session: exactId, match: 'id' };
    const exactProj = sessions.filter(s => norm(s.project) === hintNorm);
    if (exactProj.length) {
      exactProj.sort((a, b) => (b.lastInputTs || 0) - (a.lastInputTs || 0));
      return { ok: true, session: exactProj[0], match: 'project-exact' };
    }
    const fuzzy = sessions.filter(s => norm(s.project).includes(hintNorm) || norm(s.id).includes(hintNorm));
    if (fuzzy.length) {
      fuzzy.sort((a, b) => (b.lastInputTs || 0) - (a.lastInputTs || 0));
      return { ok: true, session: fuzzy[0], match: 'fuzzy' };
    }
    return {
      ok: false,
      reason: 'no_match',
      hint: targetHint,
      available: sessions.map(s => s.project || s.id).filter(Boolean),
    };
  }

  // No hint — rank: claudeRunning > has project > most-recent input
  const ranked = sessions.slice().sort((a, b) => {
    if (!!a.claudeRunning !== !!b.claudeRunning) return (b.claudeRunning ? 1 : 0) - (a.claudeRunning ? 1 : 0);
    if (!!a.project !== !!b.project) return (b.project ? 1 : 0) - (a.project ? 1 : 0);
    return (b.lastInputTs || b.lastOutputTs || 0) - (a.lastInputTs || a.lastOutputTs || 0);
  });
  return { ok: true, session: ranked[0], match: 'mru' };
}

// Post-process the unified response into the correct return format
// Pick which machine should execute a claude_control intent. Order:
//   1. Explicit mention in the user's text ("on minipc", "on the hub", etc.) —
//      strongest signal, user knows exactly what they want
//   2. Intuition's `where` field — wherever the commander currently is, mapped
//      to a device by name overlap (e.g. where="At The Hub" → Hub)
//   3. Default to Hub — the always-on PAN server's local PTY
//
// Returns { device_id, reason }. device_id 'hub' means "use the local
// server-side PTY at /api/v1/claude-control/send"; any other value means
// dispatch via sendToClient to that pan-client.
async function _pickClaudeControlTarget(userText, context) {
  const text = (userText || '').toLowerCase();
  // Snapshot of connected pan-clients with claude_control available.
  // WS sessions live on the Carrier (Craft delegates via /api/carrier/client-send),
  // so we must query the Carrier — the Craft's own client-manager map is empty.
  let candidates = [];
  let _diagAll = [];
  try {
    const carrierPort = parseInt(process.env.PAN_CARRIER_INTERNAL_PORT) || 17760;
    const r = await fetch(`http://127.0.0.1:${carrierPort}/api/carrier/clients`, {
      signal: AbortSignal.timeout(2000),
    });
    const j = await r.json();
    _diagAll = j?.clients || [];
    candidates = _diagAll.filter(c =>
      c.online && c.trusted !== false && c.claude_control?.available);
  } catch (e) {
    console.warn('[PickClaudeControl] carrier query failed:', e.message);
  }
  try {
    console.log('[PickClaudeControl] text=' + JSON.stringify(text.slice(0,120))
      + ' connected=' + _diagAll.length
      + ' candidates=' + candidates.length
      + ' all=' + JSON.stringify(_diagAll.map(c => ({id: c.device_id, online: c.online, cc: c.claude_control?.available}))));
  } catch {}

  // (1) Explicit mention. Match each candidate's device_id and name. Also
  // recognise 'hub' / 'this computer' / 'main pc' as the Hub.
  if (/\b(on |at |to )?(this (computer|pc)|the hub|hub|main|server)\b/.test(text)) {
    return { device_id: 'hub', reason: 'explicit_mention_hub' };
  }
  for (const c of candidates) {
    const id = (c.device_id || '').toLowerCase();
    const name = (c.name || '').toLowerCase();
    if (id && text.includes(id)) return { device_id: c.device_id, reason: 'explicit_mention_device_id' };
    if (name && name.length > 2 && text.includes(name)) return { device_id: c.device_id, reason: 'explicit_mention_name' };
  }

  // (2) Intuition's `where`. If it matches a candidate, use that.
  const where = String(context?.where || '').toLowerCase();
  if (where) {
    if (/(hub|desktop|main|workstation|home)/.test(where)) {
      return { device_id: 'hub', reason: `intuition_where=${where}` };
    }
    for (const c of candidates) {
      const id = (c.device_id || '').toLowerCase();
      if (id && where.includes(id)) return { device_id: c.device_id, reason: `intuition_where=${where}` };
    }
  }

  // (3) Default — Hub.
  return { device_id: 'hub', reason: 'default' };
}

async function processUnifiedResult(action, text, context) {
  const intent = action.intent || 'query';
  // Propagate speech_act through all return paths
  const speech_act = action.speech_act || (intent === 'ambient' ? 'ambient' : 'command');

  switch (intent) {
    case 'claude_control': {
      // Computer-control via a local Claude Code session. The dispatcher
      // chooses which machine should act based on:
      //   1. Explicit mention in the user's text ("on minipc", "on the hub")
      //   2. Intuition's `where` field — wherever the commander currently is
      //   3. Default to Hub
      // The chosen target either runs locally (Hub PTY via /api/v1/claude-control/send)
      // or remotely via sendToClient(device_id, 'send_to_local_claude').
      // Per-machine sessions build their own profiles over time (file paths,
      // app habits, favorites) because each uses `claude --continue` with
      // that machine's local Claude Code memory.
      if (isTestTurn(context)) {
        return { intent: 'claude_control', speech_act, response: '[benchmark: claude-control routing verified — no PTY touched]' };
      }
      try {
        const sendText = action.text || text;
        const target = await _pickClaudeControlTarget(sendText, context);
        const isHub = target.device_id === 'hub' || target.device_id === 'local';

        let j;
        if (isHub) {
          // Hub PTY — the persistent node-pty session in claude-control.js
          const r = await fetch('http://127.0.0.1:7777/api/v1/claude-control/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: sendText, wait_for_output_ms: 4000 }),
            signal: AbortSignal.timeout(8000),
          });
          j = await r.json();
        } else {
          // Remote pan-client. WS sessions live on the Carrier (Craft's
          // client-manager map is empty by design), so we relay through the
          // /api/carrier/client-send endpoint just like /api/v1/client/command
          // does. claude_timeout_ms is the per-call ceiling inside pan-client;
          // the outer fetch timeout has to be a bit larger to allow round-trip
          // overhead. First-call cold start on a fresh `claude --print` session
          // can run 60-90s, so we give it room.
          try {
            const carrierPort = parseInt(process.env.PAN_CARRIER_INTERNAL_PORT) || 17760;
            const relayRes = await fetch(`http://127.0.0.1:${carrierPort}/api/carrier/client-send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                device_id: target.device_id,
                type: 'send_to_local_claude',
                text: sendText,
                claude_timeout_ms: 180_000,
                timeout_ms: 195_000,
              }),
              signal: AbortSignal.timeout(200_000),
            });
            const relayData = await relayRes.json();
            const out = relayData?.result;
            j = {
              ok: !!out?.ok,
              new_output: out?.output || '',
              target: target.device_id,
              error: out?.error || (relayRes.ok ? null : relayData?.error),
            };
          } catch (e) {
            j = { ok: false, error: e.message, target: target.device_id };
          }
        }

        if (!j.ok) {
          const where = target.device_id;
          return { intent: 'query', speech_act, response: `Couldn't reach Claude on ${where}: ${j.error || 'no response'}.` };
        }
        let voiceReply = action.response || (isHub ? `On it — sending to Claude.` : `On it — sending to Claude on ${target.device_id}.`);
        if (j.new_output) {
          const firstUseful = String(j.new_output)
            .split('\n')
            .map(s => s.trim())
            .find(s => s.length > 4 && !/^[$%>#]/.test(s) && !/Claude Code>/.test(s));
          if (firstUseful) voiceReply = firstUseful.slice(0, 240);
        }
        return { intent: 'claude_control', speech_act, response: voiceReply, sent_to_claude: sendText, target: target.device_id, target_reason: target.reason };
      } catch (e) {
        console.error('[PAN Router] claude_control dispatch error:', e.message);
        return { intent: 'query', speech_act, response: `Failed to reach Claude terminal: ${e.message}` };
      }
    }

    case 'task': {
      // Phone → headless Claude session delegate (task #453).
      // The router model decided this needs full capability (code, files, multi-step).
      // Fire-and-forget into a live PTY adapter; return immediate TTS ack.
      //
      // Benchmark/test sources must NEVER touch a real user session — they would
      // inject messages into the active terminal, cost money, and corrupt history.
      if (isTestTurn(context)) {
        return { intent: 'task', speech_act, response: '[benchmark: task routing verified — no session touched]' };
      }
      try {
        const { delegateToPhoneToolsSession } = await import('./terminal.js');
        const delegateText = action.text || text;
        const result = delegateToPhoneToolsSession(delegateText);
        if (result.ok) {
          return {
            intent: 'task',
            speech_act,
            response: action.response || `On it. I'll work on that and follow up.`,
            delegated: { sessionId: result.sessionId, text: delegateText },
          };
        }
        // No live session available — degrade to a query response so the user knows why
        const reason = result.reason === 'no_session'
          ? `I don't have a live Claude session open to do that. Open one in the dashboard and try again.`
          : `Couldn't hand that off (${result.reason}).`;
        return { intent: 'query', speech_act, response: reason };
      } catch (e) {
        console.error('[PAN Router] task delegate error:', e.message);
        return { intent: 'query', speech_act, response: `Task delegate failed: ${e.message}` };
      }
    }

    case 'terminal': {
      // pipe — actually send text into a PAN dashboard PTY (the most common
      // "send X to the terminal" / "type Y in the WoE tab" case). Resolver
      // picks the target by project/tab name, or falls back to MRU when no
      // hint is given. Returns a transparent ack including the resolved
      // session so the user can correct PAN if it picked wrong.
      if (action.action === 'pipe') {
        // DISABLED by user request (2026-05-26) — voice router was auto-piping
        // classifier-generated text (e.g. "pong") into the active PTY tagged
        // source=voice_pipeline. Those ghost messages were appearing in the
        // user's transcript as if they had typed them, and burning model
        // tokens because Claude responded to them. Re-enable only behind an
        // explicit user-toggled setting + confirmation prompt.
        const sendText = (action.text || '').toString();
        console.warn(`[PAN Router] terminal.pipe DISABLED — refused to inject ${JSON.stringify(sendText.slice(0,80))} into PTY (would have tagged source=voice_pipeline)`);
        return {
          intent: 'terminal',
          speech_act,
          response: `Terminal pipe is disabled. Type into the terminal directly.`,
          disabled: { reason: 'voice_pipeline_pty_injection_disabled', would_have_sent: sendText.slice(0, 200) },
        };
        // ↓↓↓ unreachable; preserved for future re-enable ↓↓↓
        if (!sendText.trim()) {
          return { intent: 'terminal', speech_act, response: `I need to know what to send. What text should I type?` };
        }
        const targetHint = action.target || action.tab || action.project_name || action.name || null;
        const resolved = await resolveTerminalTarget(targetHint, context);
        if (!resolved.ok) {
          if (resolved.reason === 'no_sessions') {
            return { intent: 'terminal', speech_act, response: `No terminal tabs are open right now.` };
          }
          if (resolved.reason === 'no_match') {
            const avail = resolved.available?.length ? resolved.available.join(', ') : '(none)';
            return { intent: 'terminal', speech_act, response: `Can't find a terminal matching "${resolved.hint}". Open tabs: ${avail}.` };
          }
          return { intent: 'terminal', speech_act, response: `Couldn't pick a terminal (${resolved.reason}).` };
        }
        const sess = resolved.session;
        try {
          // Pipe runs on the Carrier — call via HTTP so we reach the process
          // that actually owns the PTY map. /api/v1/terminal/pipe handles
          // dedupe + auto-recreate of lost sessions on its own.
          const PAN_PORT = process.env.PAN_CARRIER_PORT || '7777';
          const pipeRes = await fetch(`http://127.0.0.1:${PAN_PORT}/api/v1/terminal/pipe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // #982 — voice-pipeline-originated PTY input gets tagged so phantom-prompt audits
            //         can distinguish it from user_keyboard / mcp_tool / test_harness.
            body: JSON.stringify({ session_id: sess.id, text: sendText, source: 'voice_pipeline' }),
          });
          const pipeJson = pipeRes.ok ? await pipeRes.json() : { ok: false };
          const ok = !!pipeJson?.ok;
          if (!ok) {
            return { intent: 'terminal', speech_act, response: `Tried to send to ${sess.project || sess.id} but the pipe failed.` };
          }
          const where = sess.project ? `the ${sess.project} tab` : sess.id;
          const preview = sendText.length > 40 ? sendText.slice(0, 40) + '…' : sendText;
          // Force a deterministic ack including the resolved target so PAN
          // can never lie about what it sent or where. The LLM's own ack
          // (action.response) is ignored on purpose — that's the pattern
          // that caused the original "Sending hello…" / "I haven't sent
          // anything" contradiction.
          return {
            intent: 'terminal',
            speech_act,
            response: `Sent "${preview}" to ${where} (${sess.id}).`,
            terminal_target: {
              session_id: sess.id,
              project: sess.project || null,
              match: resolved.match,
              text_sent: sendText.slice(0, 200),
            },
          };
        } catch (e) {
          return { intent: 'terminal', speech_act, response: `Pipe error: ${e.message}` };
        }
      }

      if (action.action === 'open') {
        const path = action.project || process.env.USERPROFILE + '\\Desktop';
        const name = action.name || 'PAN Terminal';

        // Try WezTerm CLI first — opens directly without needing the tray agent
        try {
          if (await weztermAvailable()) {
            const result = await weztermOpen(path, name);
            return {
              intent: 'terminal',
              response: action.response || `Opening terminal for ${name}`,
              terminalResult: { ...result, name },
              // No terminalAction — WezTerm handled it directly
            };
          }
        } catch (e) {
          console.error('[PAN Router] WezTerm open failed, falling back to tray:', e.message);
        }

        // Fallback: queue for the tray agent (old behavior)
        return {
          intent: 'terminal',
          response: action.response || `Opening terminal for ${name}`,
          terminalAction: { action: 'open', path, name }
        };
      }

      // WezTerm-specific actions: send-text, get-text, list-panes
      if (action.action === 'send-text' && action.pane_id != null) {
        try {
          if (await weztermAvailable()) {
            await weztermSend(action.pane_id, action.text || '');
            return { intent: 'terminal', response: action.response || `Sent text to pane ${action.pane_id}.` };
          }
        } catch (e) {
          return { intent: 'terminal', response: `Failed to send text: ${e.message}` };
        }
      }

      if (action.action === 'get-text' && action.pane_id != null) {
        try {
          if (await weztermAvailable()) {
            const text = await weztermGet(action.pane_id);
            return { intent: 'terminal', response: text.slice(-1000), paneText: text };
          }
        } catch (e) {
          return { intent: 'terminal', response: `Failed to read pane: ${e.message}` };
        }
      }

      if (action.action === 'list-panes') {
        try {
          if (await weztermAvailable()) {
            const panes = await weztermList();
            const summary = panes.map(p => `Pane ${p.pane_id}: ${p.title || p.cwd || 'untitled'}`).join(', ');
            return { intent: 'terminal', response: action.response || summary || 'No panes open.', panes };
          }
        } catch (e) {
          return { intent: 'terminal', response: `Failed to list panes: ${e.message}` };
        }
      }

      return { intent: 'terminal', response: action.response || 'Terminal action processed.' };
    }

    case 'home': {
      // Smart home via Home Assistant. The classifier hands us the device as
      // the user said it ("the theater"); resolveEntity does the matching, so a
      // model hallucinating an entity_id can't switch the wrong thing on.
      const target = action.target || action.query || text;
      const want = /\b(off|kill|shut|stop)\b/i.test(text) ? 'off'
        : /\b(on|start|fire)\b/i.test(text) ? 'on'
        : (action.action || 'toggle');
      try {
        const { controlEntity } = await import('./home-assistant.js');
        const result = await controlEntity(target, want);
        if (!result.ok) {
          const names = (result.candidates || []).map(c => c.name).slice(0, 3);
          return {
            intent: 'home', route: 'home',
            response: result.reason === 'ambiguous' && names.length
              ? `More than one thing matches "${target}": ${names.join(', ')}. Which one?`
              : `I couldn't find anything called "${target}" in Home Assistant.`,
          };
        }
        return {
          intent: 'home', route: 'home',
          entity_id: result.entity_id,
          response: action.response || `${result.name} ${want === 'toggle' ? 'toggled' : want}.`,
        };
      } catch (e) {
        // Not configured / HA down / token rejected. Say so rather than
        // reporting success for something that physically did not happen.
        return {
          intent: 'home', route: 'home',
          response: /not configured/i.test(e.message)
            ? 'Home Assistant is not set up yet.'
            : `Home Assistant did not respond: ${e.message}`,
        };
      }
    }

    case 'music': {
      // Music — return route + query so the phone executes via resistance router
      return {
        intent: 'music',
        route: 'music',
        query: action.query || text,
        service: action.service || 'any',
        response: action.response || `Playing ${action.query || 'music'}.`,
      };
    }

    case 'browser': {
      // Try Playwright MCP first, fall back to browser extension
      const act = action.action || 'list_tabs';

      // ── Playwright MCP (primary) ──
      try {
        if (await playwright.isAvailable()) {
          let result;
          switch (act) {
            case 'navigate':
            case 'open_url':
              result = await playwright.navigateTo(action.url);
              return { intent: 'browser', response: action.response || `Navigated to ${action.url}` };
            case 'click':
              result = await playwright.clickElement(action.selector || action.query);
              return { intent: 'browser', response: action.response || 'Clicked.' };
            case 'type':
              result = await playwright.typeText(action.selector || action.query, action.text);
              return { intent: 'browser', response: action.response || 'Typed text.' };
            case 'read_tab':
            case 'read_page':
            case 'snapshot':
              result = await playwright.readPage();
              return { intent: 'browser', response: action.response || (result.text || '').slice(0, 500) };
            case 'screenshot':
              result = await playwright.screenshot();
              return { intent: 'browser', response: action.response || 'Screenshot taken.' };
            case 'list_tabs':
              result = await playwright.listTabs();
              if (result.ok && result.tabs) {
                const tabList = result.tabs.map(t => t.title).slice(0, 10).join(', ');
                return { intent: 'browser', response: action.response || `Tabs: ${tabList}` };
              }
              break; // fall through to extension
            case 'new_tab':
              result = await playwright.newTab(action.url);
              return { intent: 'browser', response: action.response || `Opened new tab: ${action.url}` };
            case 'close_tab':
              result = await playwright.closeTab();
              return { intent: 'browser', response: action.response || 'Tab closed.' };
            default:
              // Try raw passthrough for any Playwright MCP tool
              result = await playwright.raw(`browser_${act}`, {
                url: action.url, text: action.text, element: action.query, ref: action.query
              });
              return { intent: 'browser', response: action.response || result.text || 'Done.' };
          }
        }
      } catch (e) {
        console.log('[PAN Router] Playwright failed, falling back to extension:', e.message);
      }

      // ── Browser extension fallback ──
      try {
        const browserCmd = globalThis._panBrowserCommand;
        if (browserCmd) {
          const result = await browserCmd(act, {
            query: action.query || '',
            text: action.text || '',
            url: action.url || '',
          });

          if (result.ok) {
            if (act === 'read_tab' && result.text) {
              return { intent: 'browser', response: action.response || result.text.slice(0, 500) };
            }
            if (act === 'list_tabs' && result.tabs) {
              const tabList = result.tabs.map(t => t.title).slice(0, 10).join(', ');
              return { intent: 'browser', response: action.response || `You have ${result.tabs.length} tabs open: ${tabList}` };
            }
            return { intent: 'browser', response: action.response || 'Done.' };
          }
          return { intent: 'browser', response: action.response || result.error || 'Browser action failed.' };
        }
        return { intent: 'browser', response: 'No browser automation available — install Playwright or the browser extension.' };
      } catch (e) {
        return { intent: 'browser', response: `Browser error: ${e.message}` };
      }
    }

    case 'system': {
      if (action.command) {
        return {
          intent: 'system',
          response: action.response || 'Executing command.',
          desktopAction: { type: 'command', command: action.command }
        };
      }
      return { intent: 'system', response: action.response || 'Command processed.' };
    }

    case 'memory': {
      if (action.action === 'save') {
        if (!isBench()) insert(`INSERT INTO memory_items (item_type, content, context, confidence, classified_at, org_id)
          VALUES (:type, :content, :ctx, 1.0, datetime('now','localtime'), :org_id)`, {
          ':type': action.item_type || 'note',
          ':content': action.content || text,
          ':ctx': JSON.stringify({ source: 'voice_command', original: text }),
          ':org_id': 'org_personal'
        });
        return { intent: 'memory', response: action.response || `Saved: ${action.content}` };
      }

      if (action.action === 'recall' || action.action === 'list') {
        // Use FTS5 + vector searchMemory against events (not memory_items LIKE — that was always empty)
        const searchTerm = action.content || text;
        // VECTORS STAY ON for an EXPLICIT recall.
        //
        // skipVector was applied to every caller this morning to stop the 4-6s
        // synchronous vec0 scan freezing the hub. Correct for the per-turn
        // pre-gate, wrong here, and it cost the thing recall exists for.
        //
        // Measured on the same three queries: FTS-only returns raw hook JSON
        // ({"session_id":...,"transcript_path":...}) because that scaffolding is
        // in every event and bm25 ranks it; the vector half returns what he
        // actually said ("Pike should be three rows finding, not two"). Handed
        // JSON blobs as context, the model invented answers instead of recalling
        // - which is exactly what "what did I work on" was doing.
        //
        // This path only runs when he EXPLICITLY asked to remember something, so
        // it is rare and worth the seconds. The every-turn pre-gate stays
        // FTS-only. The real fix is moving the vec scan off the main thread;
        // until then this is the honest split.
        const hits = await searchMemory(searchTerm, { limit: 10, caller: 'router-recall' });

        if (hits.length === 0) return { intent: 'memory', response: `I searched conversation history for "${searchTerm}" but found nothing. We may not have discussed that yet.` };

        // Synthesize a natural answer from the raw hits instead of listing previews
        const snippets = hits.map((h, i) => `[${i+1}] ${h.preview}`).join('\n');
        const synthesisPrompt = `The user asked: "${text}"\n\nRelevant conversation history:\n${snippets}\n\nAnswer the user's question in 1-3 sentences using only the information above. Be direct and conversational. Do not list sources.`;
        try {
          const synthesized = await claude(synthesisPrompt, { caller: 'recall-synthesis', model: getConfiguredModel?.() || 'claude-haiku-4-5', maxTokens: 200, timeout: 15000, source: context.source, device_id: context.device_id }); // #440: use configured model, increase timeout
          if (synthesized?.trim()) return { intent: 'memory', response: synthesized.trim() };
        } catch {}
        // Fallback: first hit preview only
        return { intent: 'memory', response: hits[0].preview };
      }

      return { intent: 'memory', response: action.response || 'Memory action processed.' };
    }

    case 'calendar': {
      if (!isBench()) insert(`INSERT INTO memory_items (item_type, content, context, confidence, classified_at, org_id)
        VALUES (:type, :content, :ctx, 1.0, datetime('now','localtime'), :org_id)`, {
        ':type': 'calendar_event',
        ':content': text,
        ':ctx': JSON.stringify({ source: 'voice_command', pending_calendar_sync: true }),
        ':org_id': 'org_personal'
      });
      return {
        intent: 'calendar',
        response: action.response || `Saved calendar event: "${text}". (Google Calendar sync coming soon.)`
      };
    }

    case 'ambient':
      return { intent: 'ambient', response: '[AMBIENT]' };

    case 'query':
    default:
      return { intent: 'query', speech_act, response: action.response || 'No response generated.' };
  }
}

/**
 * Smart routing: determine WHERE and HOW to execute an intent.
 *
 * Priority:
 *   1. Saved preference (user or org) — learned from corrections
 *   2. Natural language hint in text ("on the big screen", "projector")
 *   3. Device scoring (capabilities, online status, best app)
 *   4. Hard defaults (terminal→desktop, navigate→phone)
 *
 * Never asks a question we already know the answer to.
 * If we're confident → act. If genuinely ambiguous → ask ONCE, then learn.
 */
async function resolveActionTarget(intent, text, user_id, org_id, activeDevices = [], session_id = null) {
  const action_type = intentToActionType(intent);

  // ── 1. Check saved preference ────────────────────────────────────────────
  const pref = resolvePreference(null, action_type, user_id, org_id);
  if (pref) {
    return {
      device_id: pref.device_id,
      device_type: pref.device_type,
      app: pref.app,
      action_type,
      needsClarification: false,
      source: 'preference',
    };
  }

  // ── 2. Hard defaults (no device knowledge needed) ────────────────────────
  if (intent === 'terminal') return { device_type: 'pc', action_type, needsClarification: false, source: 'default' };
  if (intent === 'system')   return { device_type: 'pc', action_type, needsClarification: false, source: 'default' };
  // claude_control runs the action on whichever machine currently has a
  // local Claude Code session — Hub by default, or a specific pan-client
  // when the user named one explicitly or intuition shows them on another
  // machine. The picker logic itself lives in pickClaudeControlTarget()
  // (below) since it needs the live connected-client list + intuition state.
  if (intent === 'claude_control') return { device_type: 'pc', action_type, needsClarification: false, source: 'default' };
  if (intent === 'navigate') return { device_type: 'phone', action_type, needsClarification: false, source: 'default' };
  // Smart-home commands are executed by the hub against Home Assistant, so they
  // have no user-facing target device. Without this, `home` fell through to
  // pickDevice(), which saw two PCs, could not pick confidently, and asked
  // "Play it on <pc> or <pc>?" for "turn on the theater".
  if (intent === 'home') return { device_type: 'hub', action_type, needsClarification: false, source: 'default' };

  // ── 3. Smart device + app selection ─────────────────────────────────────
  const { device, app, confident, alternatives } = pickDevice(action_type, activeDevices, text);

  if (device && confident) {
    return {
      device_id: device.hostname,
      device_type: device.device_type,
      app,
      action_type,
      needsClarification: false,
      source: 'smart',
    };
  }

  // ── 4. Multiple plausible devices — ask ONCE ─────────────────────────────
  if (device && alternatives && alternatives.length > 0) {
    const topName = device.name || device.hostname;
    const altNames = alternatives.slice(0, 2).map(a => a.device.name || a.device.hostname);
    return {
      action_type,
      needsClarification: true,
      device_id: device.hostname,  // best guess, shown to user
      app,
      clarifyQuestion: `Play it on ${topName} or ${altNames.join(' or ')}?`,
      options: [device, ...alternatives.map(a => a.device)],
    };
  }

  // ── 5. Single device, no ambiguity ───────────────────────────────────────
  if (device) {
    return {
      device_id: device.hostname,
      device_type: device.device_type,
      app,
      action_type,
      needsClarification: false,
      source: 'only_device',
    };
  }

  // ── 6. No devices at all ─────────────────────────────────────────────────
  return { action_type, needsClarification: false, source: 'fallback' };
}

/**
 * Check if this message is a correction of our last action.
 * If yes: re-route to the correct target and save the preference.
 * Returns { handled, response, action } or null.
 */
async function handleCorrectionIfNeeded(text, context, activeDevices) {
  const correction = detectCorrection(text);
  if (!correction) return null;

  const session_id = context.session_id || null;
  const last = session_id ? getLastAction(session_id) : null;
  if (!last) return null;

  // Find the target device the user is pointing at
  let targetDevice = null;
  let targetApp = null;

  if (correction.hasExplicitTarget) {
    const pick = pickDevice(last.action_type, activeDevices, correction.target);
    if (pick.device) {
      targetDevice = pick.device;
      targetApp = pick.app;
    }
  }

  // "other one" / "not that" → pick a different device than last time
  if (!targetDevice && last.device) {
    const others = activeDevices.filter(d => d.hostname !== last.device.hostname && d.online);
    if (others.length === 1) {
      targetDevice = others[0];
      targetApp = smartPickApp(last.action_type, others[0]);
    } else if (others.length > 1) {
      // Still ambiguous after correction — narrow it down
      const names = others.map(d => d.name || d.hostname).join(' or ');
      return {
        handled: true,
        response: `Got it, not ${last.device.name || last.device.hostname}. Which one — ${names}?`,
        action: null,
      };
    }
  }

  if (!targetDevice) return null;

  // Save preference so we never ask again
  if (!isBench()) learnCorrection(last.action_type, targetDevice, targetApp, context.org_id || 'org_personal', context.user_id || null);

  // Update last action
  if (session_id) setLastAction(session_id, last.action_type, targetDevice, targetApp, text);

  const deviceName = targetDevice.name || targetDevice.hostname;
  const appLabel = targetApp ? ` with ${targetApp}` : '';
  return {
    handled: true,
    response: `Got it — playing on ${deviceName}${appLabel}. I'll remember that for next time.`,
    action: {
      type: last.action_type,
      device_id: targetDevice.hostname,
      device_type: targetDevice.device_type,
      app: targetApp,
    },
  };
}

// Thread relay fast path — "tell the billing thread ...", "ask map editor ...".
// Deterministic and BEFORE the classifier: the small local model cannot be
// trusted to pick a thread name out of a sentence, and a wrong guess here
// would put words in a real working thread. Returns null when the utterance is
// not about threads. Benchmarks get the parse but never touch a real thread.
// A benchmark or regression source, or a bench turn from /query/stream (device "<id>-bench"),
// must never reach a real session or thread. The bench form was missed: a hub test of "can you
// see what my PC stuff thread is doing" went through the relay to his real thread (2026-11-03).
function isTestTurn(context) {
  return !!((context?.source && /benchmark|regression/.test(context.source)) || /-bench$/.test(String(context?.device_id || '')));
}

// A message to someone else on this ΠAN ("PAN, tell Maria dinner is ready"): her own device says
// it (person-messages.js). Only a line said to PAN, never while interpreting. It is looked at
// before the thread relay, because a message can hold the word "thread" ("tell Maria the garden
// thread is done"); a line that names a real thread the speaker can reach stays the relay's
// ("tell Maria Homework thread to stop", when there is a thread called that).
async function messageToPerson(text, context, { person = null, addressed = false } = {}) {
  if (!addressed || interpretingFor(context?.device_id)) return null;
  try {
    if (!parseMessage(text, { from: person, addressed })) return null;
    if (!person || may(person, 'own_thread')) {
      const tr = await import('./thread-relay.js');
      if (tr.parseThreadCommand(text, { person, peek: true })?.kind === 'send') return null;
    }
    return messageTurn(text, { person, addressed, test: isTestTurn(context) });
  } catch (e) { console.warn('[router] message parse failed:', e.message); return null; }
}

// Message mode for threads (message-mode.js, task 1089, the owner Nov 26): "ΠAN, message for the
// PAN thread" -> "Go."; every line after it is kept word for word and nothing is answered, until
// "send it" or "over" sends the whole talk to the thread in one piece. The relay sent each piece
// of a long request on its own, cut at his pauses. Bench turns run it too but touch no thread.
async function* _messageMode(text, context) {
  if (interpretingFor(context?.device_id)) return;
  const dev = context.device_id || 'default';
  const done = (response, extra = {}) => ({ type: 'done', result: { intent: 'thread', speech_act: 'command', response, addressed: 1, importance: 0.5, message_mode: true, ...extra } });
  const say = function* (line, extra) { yield { type: 'chunk', text: line }; yield done(line, extra); };
  let tr;
  const r = messageMode.step(dev, text);
  if (r) {
    tr = await import('./thread-relay.js');
    const name = tr.shortTitle(r.thread.title);
    if (r.act === 'keep') {
      console.log(`[message-mode] kept for ${name}: ${JSON.stringify(String(text).slice(0, 60))}`);
      yield { type: 'chunk', text: '' };
      yield { type: 'done', result: { intent: 'ambient', response: '', addressed: 0.9, importance: 0.2, reason: 'still_talking', message_mode: true } };
      return;
    }
    if (r.act === 'cancel') { yield* say(`Dropped. Nothing went to ${name}.`); return; }
    if (r.act === 'empty_send') { yield* say(`You haven't said anything for ${name} yet. Go.`); return; }
    console.log(`[message-mode] sending ${r.size} to ${name}`);
    if (isTestTurn(context)) { yield* say(`[benchmark: message mode, ${r.size} for ${r.thread.title}, no thread touched]`, { thread_parse: { kind: 'message', title: r.thread.title, text: r.text } }); return; }
    const lead = `${r.size[0].toUpperCase()}${r.size.slice(1)}. `;
    yield { type: 'chunk', text: lead };
    for await (const ev of tr.handleThreadCommand({ kind: 'send', thread: r.thread, text: r.text, utterance: r.text }, r.text, context)) {
      yield ev.type === 'done' ? { ...ev, result: { ...ev.result, response: lead + (ev.result.response || ''), message_mode: true } } : ev;
    }
    return;
  }
  const st = messageMode.parseStart(text);
  if (!st) return;
  tr = tr || await import('./thread-relay.js');
  const m = tr.matchThread(st.name, tr.listThreads());
  if (m.ok) {
    messageMode.start(dev, m.thread, st.rest);
    console.log(`[message-mode] taking a message for ${m.thread.title}${st.rest ? ' (first piece in the start line)' : ''}`);
    yield* say('Go.');
    return;
  }
  if (m.reason === 'ambiguous') {
    const names = m.candidates.slice(0, 2).map(c => tr.shortTitle(c.title));
    yield* say(`Which thread, ${names.join(' or ')}?`, { thread_candidates: m.candidates });
  }
}

async function* _threadRelayFastPath(text, context) {
  // "Ask them where the station is" is a line to translate, not a job for a thread.
  if (interpretingFor(context?.device_id)) return;
  let tr;
  try { tr = await import('./thread-relay.js'); } catch (e) { console.warn('[PAN Router] thread-relay unavailable:', e.message); return; }
  let cmd;
  try { cmd = tr.parseThreadCommand(text); } catch (e) { console.warn('[PAN Router] thread parse failed:', e.message); return; }
  if (!cmd) return;
  // A thread named in the middle of a line: the hub model reads the whole line and says whether he
  // is asking to send, or only talking about it (thread-relay.js sendQuestion, Nov 22). Runs on
  // bench turns too, so a replay of his lines shows the decision.
  if (cmd.kind === 'send' && cmd.via === 'anywhere') {
    const m = worldModel(context?.device_id);
    if (m) {
      let ans = '';
      const t0 = Date.now();
      try {
        for await (const c of askAIStreamWithFallback(tr.sendQuestion(cmd.thread.title, text), { callerClass: 'voice', caller: 'router', maxTokens: 4, _skipAnonymize: true, chain: [m], temperature: 0 })) ans += c;
      } catch (e) { console.warn(`[PAN Router] thread send question failed: ${e.message}`); ans = 'yes'; }
      console.log(`[PAN Router] "${tr.shortTitle(cmd.thread.title)}" named in passing: send? ${JSON.stringify(ans.slice(0, 20))} in ${Date.now() - t0} ms`);
      if (!tr.wantsSend(ans)) return;
    }
  }
  if (isTestTurn(context)) {
    const response = `[benchmark: thread relay parsed ${cmd.kind}${cmd.thread ? ' -> ' + cmd.thread.title : ''} — no thread touched]`;
    yield { type: 'chunk', text: response };
    yield { type: 'done', result: { intent: 'thread', speech_act: 'command', response, thread_parse: { kind: cmd.kind, title: cmd.thread?.title || null, text: cmd.text || null } } };
    return;
  }
  writeThought('router', `Thread relay: "${text.slice(0, 80)}" -> ${cmd.kind}${cmd.thread ? ' ' + cmd.thread.title : ''}`, { intent: 'thread' }, 0.5);
  yield* tr.handleThreadCommand(cmd, text, context);
}

async function route(text, context = {}) {
  const cmdId = context._commandId || null;

  logStep(cmdId, 'received', `"${text}" from ${context.source || 'unknown'}, hint=${context.intent_hint || 'none'}`);

  // 1. Quick system commands that need zero Claude calls
  const serverIntent = serverClassify(text);
  if (serverIntent === 'system') {
    const quick = tryQuickSystem(text);
    if (quick) {
      logStep(cmdId, 'classified', 'system (quick, no Claude)');
      logStep(cmdId, 'completed', quick.response?.slice(0, 200));
      insertRouterEvent(text, quick.intent, quick.response, context);
      return quick;
    }
  }

  // 1.2 Thread relay — talk to a Claude Code desktop thread (no LLM)
  {
    let result = null;
    for await (const ev of _threadRelayFastPath(text, context)) if (ev.type === 'done') result = ev.result;
    if (result) {
      logStep(cmdId, 'classified', 'thread (relay fast path, no Claude)');
      insertRouterEvent(text, result.intent, result.response, context);
      try { result.prosody = planProsody(result); } catch {}
      return result;
    }
  }

  // 1.5 Ambient pre-filter — voice input only, no LLM needed for obvious side-conversations
  const isVoice = context.source === 'voice' || context.source === 'mic' || context.source === 'benchmark';
  if (isVoice && context.source !== 'dashboard' && quickAmbientCheck(text)) {
    logStep(cmdId, 'classified', 'ambient (quick pre-filter, no Claude)');
    const r = { intent: 'ambient', response: '[AMBIENT]' };
    insertRouterEvent(text, r.intent, r.response, context);
    return r;
  }

  // 1.8 Correction detection — did the user just correct our last action?
  // Check before calling Claude to save the LLM call entirely.
  {
    let activeDevices = [];
    try {
      activeDevices = all(
        `SELECT hostname, name, device_type, capabilities, online FROM devices
         WHERE last_seen >= datetime('now', '-5 minutes', 'localtime') AND org_id = :o`,
        { ':o': context.org_id || 'org_personal' }
      ) || [];
    } catch {}

    const correctionResult = await handleCorrectionIfNeeded(text, context, activeDevices);
    if (correctionResult) {
      logStep(cmdId, 'correction_handled', correctionResult.response);
      insertRouterEvent(text, 'correction', correctionResult.response, context);
      return { intent: 'correction', response: correctionResult.response, action: correctionResult.action };
    }
  }

  // 2. Everything else — single unified Claude call (classify + handle in one shot)
  // Pass serverClassify hint so LLM can use it for garbled/ambiguous text
  const hintedContext = serverIntent && serverIntent !== 'system'
    ? { ...context, intent_hint: serverIntent, _commandId: cmdId }
    : { ...context, _commandId: cmdId };

  logStep(cmdId, 'routing', 'unified Claude call');
  const result = await handleUnified(text, hintedContext);

  // Resolve where the action should execute (preference store → defaults → clarify)
  if (result.intent && result.intent !== 'ambient' && result.intent !== 'query') {
    try {
      let activeDevices = [];
      try {
        activeDevices = all(
          `SELECT hostname, name, device_type, capabilities, online FROM devices
           WHERE last_seen >= datetime('now', '-5 minutes', 'localtime') AND org_id = :o`,
          { ':o': context.org_id || 'org_personal' }
        ) || [];
      } catch {}

      const user_id = context.user_id || context.device_id || 'default';
      const org_id  = context.org_id  || 'org_personal';

      const target = await resolveActionTarget(result.intent, text, user_id, org_id, activeDevices);

      if (target.needsClarification) {
        result.response = target.clarifyQuestion;
        result.intent   = 'clarification';
        result.clarification = {
          action_type:   target.action_type,
          options:       target.options,
          pending_query: text,
        };
      } else if (target.device_id || target.device_type) {
        result.action_target = target;
        // Remember this action so a correction can reference it
        if (context.session_id) {
          const device = activeDevices.find(d => d.hostname === target.device_id) || { hostname: target.device_id, device_type: target.device_type };
          setLastAction(context.session_id, target.action_type, device, target.app, text);
        }
      }
    } catch (e) {
      console.error('[PAN Router] resolveActionTarget failed:', e.message);
    }
  }

  logStep(cmdId, 'completed', result.response?.slice(0, 200));
  insertRouterEvent(text, result.intent, result.response, context);

  // Batch 4 (#986): attach prosody plan so non-streaming consumers (older
  // phone code path, dashboard `/api/v1/chat`, MCP) get the same prosody
  // hints the streaming path emits in the `done` event. Additive — callers
  // that don't read `prosody` are unaffected.
  try { result.prosody = planProsody(result); } catch (e) { /* non-fatal */ }

  return result;
}

function insertRouterEvent(text, intent, response, context) {
  // His own words, when his name for ΠAN was read as "Pan" for the turn (pan-name.js).
  if (context?.said_as) text = context.said_as;
  logEvent(`router-${Date.now()}`, 'RouterCommand', { text, intent, result: response, context });
}

// Legacy export — kept for compatibility but no longer used internally
async function classifyIntent(text) {
  try {
    const result = await claude(
      `Classify this user request into exactly ONE category. Return ONLY the category name, nothing else.

Categories:
- terminal: wants to open, control, or interact with a terminal/project/code
- memory: wants to save, recall, or manage information (grocery list, idea, note, reminder)
- calendar: wants to add, check, or modify calendar events
- query: asking a question or wants information/analysis
- system: wants to control PAN itself (stop listening, change settings, status check)

User said: "${text}"`,
      { model: 'haiku', timeout: 15000, caller: 'router' }
    );

    const intent = result.toLowerCase().replace(/[^a-z]/g, '');
    const VALID = ['terminal', 'memory', 'calendar', 'query', 'system'];
    return VALID.includes(intent) ? intent : 'query';
  } catch (e) {
    console.error('[PAN Router] Classification failed:', e.message);
    return 'query';
  }
}

// --- Streaming router ---
// Yields SSE-style event objects: {type:'chunk',text} then {type:'done',result}
// Extracts the "response" field from the streaming JSON as tokens arrive,
// so the phone can start speaking word-by-word before the full reply is ready.

// ---------------------------------------------------------------------------
// ADDRESSED CONFIDENCE
//
// "Is he talking to me?" used to be a boolean, so a genuine 50/50 got rounded
// to one of the two bad answers: PAN talked over his phone call, or sat silent
// through a real question. The model now emits `addressed` 0..1 and the middle
// of that range gets its own behaviour - hold the reply, let the next beat
// decide - instead of being forced to yes or no.
//
// FIELD ORDER IS LOAD-BEARING. JSON is generated left to right, so `addressed`
// sits before `response` in every template: by the time the first word of the
// reply exists, the number that decides whether to speak it already does. Move
// it after `response` and it arrives too late to gate anything.
// READ THIS BEFORE TRUSTING `addressed`.
//
// The first measurement said separation 0.74 and looked excellent. It was an
// artifact of a TWO-case negative class. Widening the corpus to 20 pieces of
// overheard speech (10 of them held out of the prompt entirely) dropped it to
// ~0.15 on held-out cases: gemma4:e2b mutes only 1-3 of 10 lines that were
// plainly aimed at somebody else.
//
// Adding worked examples fixed the cases that BECAME examples and did not
// generalise to the rest, which is why evals/conversation.json now marks
// held-out cases and reports them separately. Quote those numbers, not the
// headline ones.
//
// A control run (scratchpad solo_gate.mjs) put the same question to the same
// model in a dedicated one-line prompt. It scored the clear physical-action
// cases at exactly 0.0 and collapsed everything else - including cases that
// WERE for PAN - to exactly 0.5. The model is not producing a probability. It
// is producing three buckets: no / do not know / yes. So the honest reading of
// `addressed` is a coarse verdict, and only its bottom bucket is trustworthy.
//
// The thresholds below are therefore chosen for SAFETY rather than accuracy:
// 0.50 to speak keeps 44/45 genuinely-addressed turns answered immediately,
// which is the failure that actually matters. 0.15 to mute is deliberately
// low - it only silences the bottom bucket. The consequence is that PAN still
// answers roughly half of overheard speech, and fixing that needs a different
// mechanism, not a different number here.
//
// The middle band still earns its keep on a collision no threshold resolves:
// "morning" (to PAN) and "yeah mate i'll call you back" (to a caller) BOTH
// score 0.2. Held, they separate themselves - he stops talking after
// "morning", and he carries on talking to the caller.
const ADDRESSED_SPEAK = 0.50;    // >= this: answer immediately
const ADDRESSED_HOLD = 0.15;     // >= this: hold it, speak only if he stops talking
const ADDRESSED_HOLD_MS = 1200;  // how long the phone sits on a held reply
// In a talk: PAN spoke this recently. He does not name it on every line, so the student's "who is
// this for" needs far less evidence (minPan, voice-reader.js).
const TALK_MS = 45_000;
// A question that leans on the last one is only read that way while PAN spoke this recently.
const FOLLOW_UP_MS = 3 * 60_000;
const MIN_PAN_IN_TALK = 0.2;
// While he dictates to Claude (dictatingToClaude), a line is PAN's only when the voice model is this
// sure. The hard 8 min mute ate "Hey, can you hear me?" in the car (Nov 15); there, lines to Claude
// scored 0.15 to 0.84 and lines to PAN 0.93 to 0.99.
const CLAUDE_QUIET_MIN_PAN = 0.9;
const ASKS_BACK = /\bdid i (?:say|tell|mention)\b/i;
// A question about the talk itself: "what were we just discussing", "what did you just say".
// It matched RECALL_RE, searched his long term notes and answered "I don't have anything on the
// record" with the talk right there (Nov 15). The talk is the answer (reread prompt, routeStream).
const ABOUT_THIS_TALK = /\bwhat (?:were|are|was) (?:we|you|i) (?:just |even |really )?(?:discussing|talking about|saying|on about)\b|\bwhat did (?:you|we|i) just (?:say|ask|talk about)\b|\bwhat (?:was|were) (?:my|your|the) last (?:question|answer|point)\b/i;
// How long the one cloud model in cloudFirst gets to start. Real first tokens: gemini-3.5-flash-lite
// p50 0.33 s, p90 2.5 s, worst 43 s; the next model down p50 2.5 s, p90 7 s, and a word search
// took 12 s through the two (conversation test, 2026-11-05). After this the student answers.
const CLOUD_FIRST_MS = 2000;

// Index just past the end of the first complete top-level JSON object, or -1.
//
// Tracks string state, so a brace inside the reply text does not count. This
// exists so the stream can stop the moment the object closes: breaking at the
// end of the "response" string truncated the JSON and broke every parse, but
// NOT breaking at all left the turn running to the model's own stop, holding
// the local model's slot open while voice turns queued behind it.
// Nothing structural from the JSON envelope may reach the speaker.
//
// Replies were occasionally spoken as "Paris. Simple enough.}{" - the tail of
// the envelope leaking into the text. It is intermittent (65 corpus turns did
// not reproduce it), so the BRACE-IN-REPLY diagnostic below stays in to catch
// the cause. This is the separate question of what the speaker is allowed to
// say: a voice reply has no legitimate use for a brace, so one arriving here
// is corruption by definition and is dropped rather than pronounced.
//
// Deliberately narrow - only { and }. Quotes and apostrophes are ordinary in
// speech ("it's"), so they are left alone.
const UNSPEAKABLE = /[{}]/g;
const speakable = (s) => String(s).replace(UNSPEAKABLE, "");

function topLevelJsonEnd(buf) {
  const start = buf.indexOf('{');
  if (start < 0) return -1;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < buf.length; i++) {
    const ch = buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

function readAddressGate(buf) {
  // OmniΠ's first field says who a line is for. Answer-first OmniΠ (round 9) writes the reply
  // straight after it, with addressed/intent AFTER the reply, so waiting for those held the whole
  // answer back. "to" decides on its own: in 4,659 teacher labels "pan" always came with
  // addressed 0.9-1.0 and everything else with 0-0.1.
  const to = buf.match(/^\s*\{\s*"to"\s*:\s*"([a-z_]+)"/);
  if (to) return to[1] === 'pan' ? { gate: 'open', addressed: 0.9 } : { gate: 'mute', addressed: 0.05 };
  const im = buf.match(/"intent"\s*:\s*"([a-z_]+)"/);
  if (!im) return null;                       // nothing decided yet
  // The trailing [,}] matters: without it a half-streamed "addressed":0 reads
  // as zero and mutes a reply that was about to become 0.85.
  const am = buf.match(/"addressed"\s*:\s*([0-9]*\.?[0-9]+)\s*[,}]/);
  if (am) {
    const a = Math.max(0, Math.min(1, Number(am[1])));
    if (a >= ADDRESSED_SPEAK) return { gate: 'open', addressed: a };
    if (a >= ADDRESSED_HOLD) return { gate: 'hold', addressed: a };
    return { gate: 'mute', addressed: a };
  }
  // No number yet - wait for it, but only until the reply itself starts. A
  // model that reached "response" without emitting `addressed` is not
  // calibrating at all, and holding the turn open for a field that is never
  // coming would mute every reply. Use the old boolean, and record that it did.
  if (/"response"\s*:\s*"/.test(buf)) {
    return { gate: im[1] === 'ambient' ? 'mute' : 'open', addressed: null };
  }
  return null;
}

function extractResponseField(buf) {
  // Find "response":"..." in a partially-streamed JSON buffer.
  // Returns { text: string, done: boolean }
  const m = buf.match(/"response"\s*:\s*"/);
  if (!m) return { text: '', done: false };
  const start = buf.indexOf(m[0]) + m[0].length;
  let text = '';
  let i = start;
  while (i < buf.length) {
    const ch = buf[i];
    if (ch === '\\' && i + 1 < buf.length) {
      const e = buf[i + 1];
      switch (e) {
        case '"': text += '"'; break;
        case '\\': text += '\\'; break;
        case 'n': text += '\n'; break;
        case 't': text += '\t'; break;
        default: text += e;
      }
      i += 2;
    } else if (ch === '"') {
      return { text, done: true };
    } else {
      text += ch;
      i++;
    }
  }
  return { text, done: false };
}

// FEWER TACKED-ON QUESTIONS.
//
// 47 of 66 benchmark replies ended with a question, nearly all of them an answer
// with "Are you looking for A or B?" tacked on (voicebench, 2026-11-02). The owner: it
// should ask some, but talk like a person. Conversational replies lose that last
// question with the regexes and coin of the round 9 training data (F:\pan-finetune\
// scripts\answer_first.py): an offer, a menu or a "why are you asking" 9 times in
// 10, any other question 7 times in 10 (the data keeps 6 in 10 of those; the live
// model asks more). A reply that IS a question keeps it, and the coin is a hash
// of the reply, so the same reply always gets the same cut. What is left after
// this is mostly one-sentence ask-backs ("I can give you the height, but in
// meters or feet?"), which only the retrain can fix: cutting those would leave
// a promise unkept.
//
// Syrinx (round 9, 2026-11-03) was trained to ask about as often as people do (8% of
// replies when he asks, 15% when he tells: Switchboard), and ends 6% of its replies
// with a question on the test sets against OmniΠ's 89%. Only menus and offers are
// still cut; any other closing question is a real follow-up and stays.
const SENTENCE_GAP = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/g;
const TRAILING_MENU = /^(?:want me to|do you want|would you like|should i|shall i|are you looking|are you thinking|are you asking|is that what|why (?:are|do) you (?:ask|want|need)|or (?:do|are|should|would))|\bor\b.*\?$/i;
const KEEP_MENU_Q = 0.1, KEEP_OTHER_Q = 1.0;

function lastSentenceGap(text) {
  let gap = null;
  for (const m of text.matchAll(SENTENCE_GAP)) gap = m;
  return gap;
}

// Where the kept part of a reply ends (its last question is dropped), or -1 to keep it all.
function trailingQuestionCut(reply, intent) {
  const r = String(reply || '').trim();
  if (intent !== 'query' || r.startsWith('[') || !r.endsWith('?')) return -1;
  const gap = lastSentenceGap(r);
  if (!gap) return -1;
  const p = TRAILING_MENU.test(r.slice(gap.index + gap[0].length)) ? KEEP_MENU_Q : KEEP_OTHER_Q;
  const coin = parseInt(createHash('md5').update(r, 'utf8').digest('hex').slice(0, 8), 16) / 0xFFFFFFFF;
  return coin < p ? -1 : gap.index;
}

// How much of a streaming reply may go to the speaker yet. The first sentence
// streams as it is written. A later one goes out whole once it ends in . or !,
// and a question once the next sentence starts, because a question with nothing
// after it may be cut. The phone speaks a later sentence only at its full stop
// anyway, so this holds nothing it would have said sooner.
function releasableEnd(held) {
  const gap = lastSentenceGap(held);
  const end = held.trimEnd().length;
  if (!gap) return end;
  return /[.!]["')\]]*$/.test(held.trimEnd()) ? end : gap.index;
}

// De-dupe latch for voice/router-turn failure alerts. When every AI backend
// cascade-fails (every model in the fallback chain errors), routeStream still
// yields a canned reply so the phone isn't silent — but that failure was
// previously invisible. Raise ONE alert, suppressing duplicates within a
// 5-minute window; a turn that streams output clears the latch so the next
// outage alerts immediately. Modelled on scout.js's _lastReasoningCloudAlertModel.
let _lastVoiceAlertAt = 0;
const VOICE_ALERT_WINDOW_MS = 5 * 60 * 1000;

async function _raiseVoiceAlert(reason, source) {
  const now = Date.now();
  if (now - _lastVoiceAlertAt < VOICE_ALERT_WINDOW_MS) return; // de-dupe
  _lastVoiceAlertAt = now;
  try {
    // Lazy import — routes/dashboard.js imports router.js indirectly, so a
    // top-level import would be a circular dependency.
    const { createAlert } = await import('./routes/dashboard.js');
    createAlert({
      alert_type: 'voice_failed',
      severity: 'warning',
      title: 'Voice turn failed — all AI backends errored',
      detail: `A ${source || 'voice'} turn could not be answered: every model in the fallback chain failed to produce a response. Error: ${reason}. PAN replied with a fallback message.`,
    });
  } catch (e) {
    console.warn('[routeStream] Could not raise voice_failed alert:', e.message);
  }
}

// A PERSON WHO IS NOT THE OWNER (people.js, docs/PEOPLE-PLAN.md).
//
// Their turn is built from what their own device sent with it and nothing else: no situation
// line, no memory, no notes, none of the owner's talk, name, place or voice profile, and nothing
// is stored on the hub. It is its own short path, not the owner's path with pieces switched off:
// a block added to routeStream later cannot reach a person by being forgotten here. Before
// anything that acts, may() is asked, and a no is said out loud (a model left to answer "tell the
// PAN thread ..." says "Got it" and does nothing); a no about the owner's own threads and
// computers is not said at all, the line simply gets no answer. Not here yet: interpreting, and a memory of
// the person's own.
const PERSON_AMBIENT_JSON = 'reply {"intent":"ambient","addressed":0.1,"response":"[AMBIENT]"}';
const PERSON_IDENTITY = /\b(?:who are you|what are you(?=\W*$)|your name|(?:what(?:'s|s| is)|know|remember|say|tell me) my name|what my name is|who am i(?=\W*$)|who (?:made|built) you)\b/i;

function personSelfLine(person) {
  const name = String(person?.display_name || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40);
  return 'About you (live, this is fact): your name is PAN, short for Personal AI Network. '
    + (name ? `The person talking to you is ${name}: asked their own name, the answer is ${name}. ` : '')
    + 'They talk to you through the PAN app on their own device, and you run on the hub at home. You cannot see their screen or what they are doing, you keep no memory of what they say yet, and you cannot act on the house, a computer or anyone\'s messages for them. Answer questions about yourself and about them only from this line.';
}

// The clock where the person's own device is, when it says (the owner's phone may be elsewhere).
function personNowLine(sensors) {
  const tz = String(sensors?.tz || '');
  try { if (tz) { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return nowLine(tz); } } catch {}
  return nowLine();
}

// Which rule of the hub prompt fits the line (HUB_RULES). Every kind chosen for a line that does
// not name PAN lets the model stay quiet, since no voice model has said who the line is for.
function personKind(text, context, talking, liveData) {
  const named = saysPanName(text);
  const hasTalk = !!String(context.conversation_history || '').trim();
  if (liveData) return 'DATA';
  if (PERSON_IDENTITY.test(text)) return 'SELF';
  if (talking && hasTalk && lostBy(text)) return 'LOST';
  if (hasTalk && ABOUT_THIS_TALK.test(text)) return 'ABOUT_TALK';
  if (asksTheWorld(text)) return named ? 'WORLD' : 'WORLD_MAYBE';
  if (asksForSomething(text)) return named ? 'ASKED' : 'ASKED_MAYBE';
  if (named) return 'NAMED';
  if (tellsPan(text)) return 'TOLD';
  return 'WORDS_ALONE';
}

/** The whole prompt for a person's line and the models asked, as plain data (tested without a model). */
export function personPrompt(text, context, { liveBlock = '', hubModel = '' } = {}) {
  const person = context.person;
  const talking = Number.isFinite(context.since_pan_ms) && context.since_pan_ms < TALK_MS;
  const kind = personKind(String(text || ''), context, talking, !!liveBlock);
  const middle = [voiceHistoryBlock(context.conversation_history).trim(), personNowLine(context.sensors), String(liveBlock || '').trim(),
    `Mic heard: "${clipToTokens(anonymizeForAI(text), HEARD_TOKENS)}"`].filter(Boolean);
  const self = personSelfLine(person);
  // Their name once more, next to their line, as the owner's path does for him: with the facts a
  // block away a small model answers "PAN" to "what is my name?" (seen again for a person, Nov 18).
  const theirName = String(person?.display_name || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40);
  if (kind === 'SELF' && theirName) middle.splice(middle.length - 1, 0, `Your name is PAN. The name of the person talking to you is ${theirName}.`);
  if (hubModel) return { kind, plain: true, prompt: hubPrompt(kind, middle, self) };
  // No model of the hub's own: the same rule, asked for as JSON, for whatever the voice chain has.
  const rule = HUB_RULES[kind].replace(HUB_AMBIENT, PERSON_AMBIENT_JSON)
    .replace(/^The (WORLD|ASKED) rule, but/, (_, k) => `${HUB_RULES[k]} But`);
  return { kind, plain: false, prompt: [
    'You are PAN, a voice assistant and a friend in the room. Reply ONLY as JSON: {"intent":"query","addressed":0.9,"response":"..."}',
    self, ...middle, rule].join('\n\n') };
}

async function* personTurn(text, context, withProsody) {
  const person = context.person;
  const t0 = Date.now();
  const say = function* (response, extra = {}) {
    if (response) yield { type: 'chunk', text: response };
    yield { type: 'done', result: withProsody({ intent: 'query', speech_act: 'answer', response, addressed: 0.9, importance: 0.4, ...extra }) };
  };
  const quiet = function* (reason) {
    yield { type: 'chunk', text: '' };
    yield { type: 'done', result: withProsody({ intent: 'ambient', response: '', addressed: 0.1, importance: 0.1, reason }) };
  };
  const notePath = (p) => { try { recordTiming({ turn: context.turn_id, device: context.device_id, stage: 'path', path: p }); } catch {} };

  if (asksToMute(text)) {
    yield { type: 'done', result: withProsody({ intent: 'system', mute: true, response: '', addressed: 0.95, importance: 0.3 }) };
    return;
  }
  if (!may(person, 'talk')) { yield* say(refusal('talk')); return; }

  // A message to someone else on this ΠAN, the owner included.
  {
    const inTalk = Number.isFinite(context.since_pan_ms) && context.since_pan_ms < TALK_MS;
    const msg = await messageToPerson(text, context, { person, addressed: saysPanName(text) || inTalk });
    if (msg) {
      notePath(msg.refused ? 'person_refused' : 'person_message');
      if (msg.response) yield { type: 'chunk', text: msg.response };
      yield { type: 'done', result: withProsody(msg) };
      return;
    }
  }

  // A Claude thread or a computer. A person's own computer is that person's client
  // (docs/PEOPLE-PLAN.md): the threads on it are theirs to use (own_thread). Every other thread
  // and computer is the owner's, unless the owner opened them to this person (thread).
  let tr = null;
  try { tr = await import('./thread-relay.js'); } catch (e) { console.warn('[person] thread-relay unavailable:', e.message); }
  if (tr && may(person, 'thread') && may(person, 'computer')) {
    let handled = false;
    for await (const ev of _threadRelayFastPath(text, context)) {
      handled = true;
      yield ev.type === 'done' ? { type: 'done', result: withProsody(ev.result) } : ev;
    }
    if (handled) return;
  } else if (tr) {
    let mine = null;
    try {
      if (may(person, 'own_thread') && tr.listThreads({ person }).length) mine = tr.parseThreadCommand(text, { person });
    } catch (e) { console.warn('[person] thread parse failed:', e.message); }
    if (mine) {
      notePath('person_thread');
      if (isTestTurn(context)) {
        const response = `[benchmark: thread relay parsed ${mine.kind}${mine.thread ? ' -> ' + mine.thread.title : ''} — no thread touched]`;
        yield { type: 'chunk', text: response };
        yield { type: 'done', result: withProsody({ intent: 'thread', speech_act: 'command', response, thread_parse: { kind: mine.kind, title: mine.thread?.title || null, text: mine.text || null } }) };
        return;
      }
      console.log(`[person] ${person.id} (${person.role}) on ${context.device_id}: own thread, ${mine.kind}${mine.thread ? ' ' + JSON.stringify(mine.thread.title) : ''}`);
      for await (const ev of tr.handleThreadCommand(mine, text, { ...context, person })) {
        yield ev.type === 'done' ? { type: 'done', result: withProsody(ev.result) } : ev;
      }
      return;
    }
    // What the line would mean to the owner, with nothing remembered from the look.
    let theirs = null;
    try { theirs = tr.parseThreadCommand(text, { peek: true }); } catch (e) { console.warn('[person] thread parse failed:', e.message); }
    if (theirs) {
      // Not answered at all (the owner, 2026-11-18: "why would you even say a no to somebody
      // else"). A line about the owner's threads or computers from someone who may not use them
      // gets silence: a spoken no would confirm they are there. The hub's log keeps who asked.
      console.log(`[person] ${person.id} (${person.role}) asked for a thread or computer on ${context.device_id} - not theirs, no answer: ${JSON.stringify(String(text).slice(0, 80))}`);
      notePath('person_refused');
      yield* quiet('not_theirs');
      return;
    }
  }

  // A look through the camera: the device takes the photo and asks /vision, which keeps nothing
  // for a person (routes/api.js).
  if (context.canCamera && asksForCamera(text)) {
    if (!may(person, 'camera')) { notePath('person_refused'); yield* say(refusal('camera'), { refused: 'camera' }); return; }
    yield { type: 'done', result: withProsody({ intent: 'query', addressed: 0.95, camera: true, response: '', importance: 0.5 }) };
    return;
  }

  // Not said to PAN: someone else by name, a greeting to a person, or music on the device's speakers.
  const part = participationOf({ text, history: context.conversation_history, mode: null,
    sincePanMs: Number.isFinite(context.since_pan_ms) ? context.since_pan_ms : null });
  if (part.named_other && !saysPanName(text)) { yield* quiet('named_other'); return; }
  if (context.media_playing && !context.addressed_now && !saysPanName(text)) { yield* quiet('music_playing'); return; }
  if (!context.addressed_now && quickAmbientCheck(text)) { yield* quiet('not_addressed'); return; }

  // Live data for the question, from this turn's own sensors only (tools.js reads no stored place).
  let liveBlock = '';
  try {
    const b = await buildToolBlocks(text, context.sensors || null, { detail: true, liveOnly: true, recent: talkBefore(context, text), skip: toolSkips(context.device_id, text) });
    if (b.live) liveBlock = b.text;
  } catch {}

  const hubModel = worldModel(context.device_id) || worldModel(context.device_id, 'voice_hub_paths_model');
  const notLocalReader = (m) => !/^reader:/.test(m);
  const cloud = readChain('voice').filter((m) => !/^(?:ollama|reader):/.test(m));
  const { kind, plain, prompt } = personPrompt(text, context, { liveBlock, hubModel });
  const opts = { callerClass: 'voice', caller: 'router-person', maxTokens: 300, _skipAnonymize: true, source: context.source,
    device_id: context.device_id, signal: context.signal || null };
  const stream = plain
    ? plainAsReply(askAIStreamWithFallback(prompt, { ...opts, chain: [hubModel, ...cloud].slice(0, 3), firstTokenMs: WORLD_LOCAL_MS, temperature: HUB_TEMPERATURE }), HUB_SENTENCES)
    : askAIStreamWithFallback(prompt, { ...opts, chain: [...cloud, ...readChain('voice').filter((m) => /^ollama:/.test(m))].filter(notLocalReader) });
  console.log(`[person] ${person.id} (${person.role}) ${kind} via ${plain ? hubModel : 'the voice chain'}, prompt ${prompt.length} chars`);
  notePath('person');

  // Sums done by code (arith.js, sums.js, money.js): the reply is read whole and its figure checked
  // before any of it is spoken, as on the owner's path (sums.js keepFigures). A person's device was
  // told "seven times eight" is fourteen (Nov 24).
  const loud = outLoud(liveBlock);
  if (loud.length) {
    let whole = '';
    try { for await (const c of stream) whole += c; } catch (e) {
      if (context.signal?.aborted) throw e;
      console.error('[person] model error:', e.message);
    }
    let reply = String(whole || '');
    try { const j = JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] || ''); if (j && typeof j.response === 'string') reply = j.response; } catch {}
    const kept = keepFigures(speakable(reply).trim(), loud);
    if (kept.changed) console.log(`[person] the reply changed a worked out figure - saying the code's sentence (model said: ${reply.slice(0, 160)})`);
    const response = kept.text.trim() || loud.map((x) => x[0].toUpperCase() + x.slice(1)).join('. ') + '.';
    recordTiming({ turn: context.turn_id, device: context.device_id, stage: 'first_chunk', ms: Date.now() - t0 });
    yield* say(response);
    return;
  }

  let buf = '', held = '', out = 0, gate = null, first = true;
  try {
    for await (const c of stream) {
      if (first) { first = false; recordTiming({ turn: context.turn_id, device: context.device_id, stage: 'first_chunk', ms: Date.now() - t0 }); }
      buf += c;
      if (gate === null) { const d = readAddressGate(buf); if (d) gate = d.gate; }
      const { text: got, done } = extractResponseField(buf);
      if (got.length > held.length) held = got;
      if (gate === 'open' && !held.startsWith('[')) {
        const end = releasableEnd(held);
        if (end > out) {
          const delta = speakable(held.slice(out, end));
          out = end;
          if (delta) yield { type: 'chunk', text: delta };
        }
      }
      if (done && topLevelJsonEnd(buf) > 0) break;
    }
  } catch (e) {
    if (context.signal?.aborted) throw e;
    console.error('[person] model error:', e.message);
    if (out === 0) { yield* say('Sorry, I ran into a problem thinking that through. Try again.'); return; }
  }
  const reply = speakable(held).trim();
  if (!reply || reply.startsWith('[') || gate === 'mute') { yield* quiet('not_addressed'); return; }
  if (gate === 'hold' && out === 0) {
    yield { type: 'done', result: withProsody({ intent: 'query', response: reply, addressed: 0.3, hold_ms: ADDRESSED_HOLD_MS, importance: 0.3 }) };
    return;
  }
  if (held.length > out) {
    const delta = speakable(held.slice(out));
    if (delta.trim()) yield { type: 'chunk', text: delta };
  }
  yield { type: 'done', result: withProsody({ intent: 'query', speech_act: 'answer', response: reply, addressed: 0.9, importance: 0.5 }) };
}

// How ΠAN talks, per device (owner, Nov 26: "it should be per device"). The app sends its own
// Personality text with every turn (an empty string = off on that device); a turn without one
// (the desktop, an older app) uses the hub's own setting, as before.
export function personalityFor(context = {}) {
  // The device's own name for ΠAN goes with its personality: ΠAN calls itself that (pan-name.js).
  const named = panNameLine(context.pan_name);
  if (named) return [named, personalityFor({ ...context, pan_name: '' })].filter(Boolean).join(' ');
  if (typeof context.personality === 'string') return context.personality.trim().slice(0, 600);
  try {
    const row = get("SELECT value FROM settings WHERE key = 'personality'");
    if (row) return String(row.value).replace(/^"|"$/g, '').trim();
  } catch {}
  return '';
}

export async function* routeStream(text, context = {}) {
  // Batch 4 (#986): every `done` emit gets a prosody plan derived from
  // `result.importance`. Wrap once, use everywhere — keeps the diff small
  // and guarantees consumers always see a `prosody` field.
  // readerProbe: the voice model's own odds that the line is for PAN (voice-reader.js), passed back
  // with the result so convbench can replay other thresholds offline (2026-11-12).
  const readerProbe = {};
  let turnPlace = null;   // PAN's place in the talk (intuition/participation.js), once known
  const withProsody = (result) => ({ ...result, prosody: planProsody(result),
    ...(readerProbe.pPan !== undefined ? { p_pan: readerProbe.pPan, p_room: readerProbe.pRoom, to_top: readerProbe.top } : {}),
    ...(turnPlace ? { participation: turnPlace } : {}) });
  const _turnStart = Date.now();   // for the [routeStream] timing line
  if (context.voice_his === false) alone.heardOther(context.device_id);
  // This device's own name for ΠAN (pan-name.js, task 1082): read as "Pan" for the turn, so every
  // rule and the voice model know it. "Pan" itself is then someone else's name, not answered.
  const ownName = cleanPanName(context.pan_name);
  if (ownName && !context.said_as) {
    if (!callsOwnName(text, ownName) && saysPanName(text)) {
      console.log(`[routeStream] called "Pan", but this device's ΠAN is ${ownName} - quiet: ${JSON.stringify(String(text).slice(0, 60))}`);
      yield { type: 'chunk', text: '' };
      yield { type: 'done', result: withProsody({ intent: 'ambient', response: '', addressed: 0.05, importance: 0.1, reason: 'named_other' }) };
      return;
    }
    const mapped = mapPanName(text, ownName);
    if (mapped !== text) { context = { ...context, said_as: text }; text = mapped; }
  }
  // The listening modes (listen-mode.js, the owner Nov 24): Listen only, Name only, Mute. The
  // device sends its mode and the person's own words; a mode command or a quiet turn ends here.
  // A quiet turn is still kept (routes/api.js records it) and voice ID still ran on it.
  if (!context.mode_checked && context.listen_mode) {
    noteMode(context.device_id, context.listen_mode);
    const lm = modeTurn(text, context.listen_mode, context.mode_words);
    if (lm?.set) {
      console.log(`[routeStream] listening mode ${context.listen_mode} -> ${lm.set}: ${JSON.stringify(String(text).slice(0, 60))}`);
      noteMode(context.device_id, lm.set);
      yield { type: 'listen_mode', mode: lm.set };
      if (lm.set === 'mute') {
        yield { type: 'done', result: withProsody({ intent: 'system', mute: true, listen_mode: 'mute', response: '', addressed: 0.95, importance: 0.3 }) };
        return;
      }
      // "You can talk, what time is it?": out of Listen only, and the rest answered as for PAN.
      if (lm.rest && lm.rest.trim().split(/\s+/).length >= 2) {
        for await (const ev of routeStream(lm.rest, { ...context, listen_mode: lm.set, mode_checked: true, addressed_now: true })) {
          yield ev.type === 'done' ? { ...ev, result: { ...ev.result, listen_mode: lm.set } } : ev;
        }
        return;
      }
      const ack = modeAck(lm.set, context.listen_mode);
      if (ack) yield { type: 'chunk', text: ack };
      yield { type: 'done', result: withProsody({ intent: 'system', listen_mode: lm.set, response: ack, addressed: 0.95, importance: 0.3 }) };
      return;
    }
    if (lm?.quiet) {
      console.log(`[routeStream] ${lm.quiet}: kept, nothing said: ${JSON.stringify(String(text).slice(0, 60))}`);
      yield { type: 'done', result: withProsody({ intent: 'ambient', reason: lm.quiet, listen_mode: context.listen_mode, response: '', addressed: 0.05, importance: 0.1 }) };
      return;
    }
    if (lm?.named) context = { ...context, addressed_now: true };
  }
  // Someone other than the owner: their own short path, and none of what follows.
  if (context.person) { yield* personTurn(text, context, withProsody); return; }
  {
    let handled = false;
    for await (const ev of _messageMode(text, context)) {
      handled = true;
      if (ev.type === 'done') { insertRouterEvent(text, ev.result.intent, ev.result.response, context); yield { type: 'done', result: withProsody(ev.result) }; }
      else yield ev;
    }
    if (handled) return;
  }
  warmVectors();
  // The shelf (intuition/shelf.js): every line of his is checked for the names of his things, so
  // their notes are ready on the turns that need them. A guest's line returned above.
  let shelf = { block: '', named: [] };
  try {
    pauseForTalk();   // a note being written in the background stops: this turn needs the CPU
    shelf = shelfForTurn(text, { othersNearby: overheardWithin(2 * 60_000, context.org_id || 'org_personal') >= 2 });
    if (shelf.named.length) console.log(`[routeStream] shelf: ${shelf.named.join(', ')} named in this line`);
  } catch (e) { console.warn('[routeStream] shelf failed:', e.message); }
  const talking = Number.isFinite(context.since_pan_ms) ? context.since_pan_ms < TALK_MS : panSpokeWithin(TALK_MS, context.org_id);
  // Laying out a problem (intuition/laying-out.js, task 1087, the owner Nov 26): "wait, I'm not
  // done", "here's the situation...", a line ending in a colon: nothing is said and the piece is
  // kept; the next line is answered as one request with every piece in front of it. His popcorn
  // problem over three pauses got answers to the pieces, and the question went alone.
  let laidOut = 0;   // kept pieces in front of this line: a problem he laid out (task 1090)
  if (!interpretingFor(context.device_id)) {
    const lay = layingOut.step(context.device_id || 'default', text, talking && typeof context.conversation_history === 'string' ? context.conversation_history : '');
    if (lay.hold) {
      console.log(`[laying-out] not done yet, kept (${lay.pieces} piece${lay.pieces === 1 ? '' : 's'}): ${JSON.stringify(String(text).slice(0, 60))}`);
      yield { type: 'chunk', text: '' };
      yield { type: 'done', result: withProsody({ intent: 'ambient', response: '', addressed: 0.9, importance: 0.2, reason: 'still_talking', laying_out: true }) };
      return;
    }
    if (lay.joined) {
      console.log(`[laying-out] ${lay.joined} kept piece${lay.joined === 1 ? '' : 's'} in front of: ${JSON.stringify(String(text).slice(0, 60))}`);
      text = lay.text;
      laidOut = lay.joined;
    }
  }

  // Told to mute (mute-ask.js): the device does it, and nothing is said. A device too old to know
  // the flag stays silent for the turn, which is still better than "Got it" with nothing muted.
  if (asksToMute(text)) {
    console.log(`[routeStream] told to mute: ${JSON.stringify(String(text).slice(0, 60))}`);
    yield { type: 'done', result: withProsody({ intent: 'system', mute: true, response: '', addressed: 0.95, importance: 0.3 }) };
    return;
  }

  // Fast local intents — no LLM, return immediately
  const serverIntent = serverClassify(text);
  if (serverIntent === 'system') {
    const quick = await tryQuickSystem(text);
    if (quick) {
      yield { type: 'chunk', text: quick.response };
      yield { type: 'done', result: withProsody(quick) };
      return;
    }
  }

  {
    const msg = await messageToPerson(text, context, { addressed: saysPanName(text) || talking });
    if (msg) {
      insertRouterEvent(text, msg.intent, msg.response, context);
      if (msg.response) yield { type: 'chunk', text: msg.response };
      yield { type: 'done', result: withProsody(msg) };
      return;
    }
  }

  // Thread relay — talk to a Claude Code desktop thread (no LLM). Streams the
  // ack first, then the thread's answer if it lands while the turn is open.
  {
    let handled = false;
    for await (const ev of _threadRelayFastPath(text, context)) {
      handled = true;
      if (ev.type === 'done') {
        insertRouterEvent(text, ev.result.intent, ev.result.response, context);
        yield { type: 'done', result: withProsody(ev.result) };
      } else {
        yield ev;
      }
    }
    if (handled) return;
  }

  // INTERPRETING. "From now on translate everything I say in Japanese" is a standing
  // instruction, and every line after it took the whole voice path: the local model, a
  // memory search on any "where was...", 2.8 s and then 7 s a line (2026-11-03, he timed
  // it). A line to translate needs none of that. It skips the room-talk and dictation
  // filters too ("hey Kenji, nice to meet you" is his to say), the memory search and the
  // tools, and goes to the cloud model first with a short prompt (standingPrompt below).
  const ack = interpreterAck(context.device_id || 'default', text);
  let standing = standingInstruction(context.device_id || 'default', text);
  let interpreting = !!standing && INTERPRET_RE.test(standing.text);
  // While interpreting, his own English line that names ΠAN is a request to ΠAN, not a line to
  // translate (task 1083, the owner Nov 26: "understand when you're asking it a question while
  // also in the translation"). Lines about the interpreting itself ("ΠAN, say that again", "ask
  // them...") stay with the interpreter. Only English and only his voice: "pan" is bread in Spanish.
  if (interpreting && !standing.setting && saysPanName(text) && context.wearer !== false
    && (context.heard_lang ? String(context.heard_lang).toLowerCase() === 'en' : looksEnglish(text))
    && !SAY_AGAIN_RE.test(String(text || '')) && !STANDING_CLEAR_RE.test(String(text || ''))
    && !/\b(?:translat\w*|interpret\w*|ask (?:him|her|them)|tell (?:him|her|them)|say (?:that|it|this)|how do (?:you|i|we) say)\b/i.test(String(text || ''))) {
    console.log(`[routeStream] interpreting, but he asked ΠAN by name - answered, not translated: ${JSON.stringify(String(text).slice(0, 60))}`);
    standing = null;
    interpreting = false;
  }
  if (ack) {
    yield { type: 'chunk', text: ack };
    yield { type: 'done', result: withProsody({ intent: 'translate', response: ack, addressed: 0.9, importance: 0.3 }) };
    return;
  }
  const again = interpreting && !standing.setting && SAY_AGAIN_RE.test(String(text || '')) ? lastTranslation(context.conversation_history) : null;
  if (again) {
    yield { type: 'chunk', text: again };
    yield { type: 'done', result: withProsody({ intent: 'translate', response: again, addressed: 0.9, importance: 0.3 }) };
    return;
  }

  // Whose voice it is (`wearer`, from the phone's voice ID, false = not his voice): someone else
  // in the room gets an answer only when they say PAN's name. Right after PAN answered him, the
  // words alone cannot tell his follow-up from the next person talking: on convbench's addressed
  // test PAN stayed quiet on only 47% of other people's lines there, and its odds for the two
  // overlapped completely (2026-11-12). Not while interpreting: other people's lines are the job.
  // PAN's place in the talk and the firm rules (docs/INTUITION-STATE.md section 15): plain rules
  // on what the hub already has, no model, about 0.01 ms.
  const part = participationOf({ text, history: context.conversation_history, mode: interpreting ? 'interpreting' : null,
    sincePanMs: Number.isFinite(context.since_pan_ms) ? context.since_pan_ms : (talking ? 0 : null) });
  turnPlace = part.place;
  console.log(`[participation] ${part.place}${part.named_other ? ` (said to ${part.named_other})` : ''}: ${part.reasons.join('; ')}`);
  // Said to someone else by name ("Maria, can you pass the salt?"): theirs to answer (rule 4).
  if (part.named_other && !interpreting && !saysPanName(text)) {
    yield { type: 'chunk', text: '' };
    yield { type: 'done', result: withProsody({ intent: 'ambient', response: '', addressed: 0.05, importance: 0.1, reason: 'named_other' }) };
    return;
  }
  if (context.wearer === false && !interpreting && !saysPanName(text)) {
    console.log(`[routeStream] not his voice and not named - quiet: ${JSON.stringify(String(text).slice(0, 60))}`);
    yield { type: 'chunk', text: '' };
    yield { type: 'done', result: withProsody({ intent: 'ambient', response: '', addressed: 0.05, importance: 0.1, reason: 'other_voice' }) };
    return;
  }
  // The program's shape rule (docs/INTUITION-STATE.md section 16), only with `situation_rules`
  // on (or 'bench' for bench turns only). Right after PAN answered, in a voice not known to be
  // someone else's: a short question is for PAN (the reader's lowest bar), a long line is for the
  // room. The sizes are the nightly learner's (`situation_params`). Addressed bench, half run,
  // 2026-11-13: follow-ups 84% to 100%, his talk to others after PAN 69% to 73-83%.
  let forcePan = false;
  // The assistant button (the car's steering wheel voice button): he said it to PAN, so no room
  // rule and the reader answers whatever its first token says (Nov 14).
  if (context.addressed_now) { forcePan = true; console.log('[participation] assistant button - for PAN'); }
  // Music on the device's speakers: the mic hears the song (the car, Nov 14: PAN answered rap lyrics
  // line by line). Only a line that names PAN, or one after the assistant button, is for PAN then.
  if (context.media_playing && !context.addressed_now && !interpreting && !saysPanName(text)) {
    console.log(`[participation] music playing - not for PAN: "${String(text).slice(0, 60)}"`);
    yield { type: 'chunk', text: '' };
    yield { type: 'done', result: withProsody({ intent: 'ambient', response: '', addressed: 0.1, importance: 0.1, reason: 'music_playing' }) };
    return;
  }
  if (!context.addressed_now && !interpreting && talking && context.wearer !== false && !saysPanName(text) && situationRulesOn(context)) {
    const sh = shapeOf(text, situationParams());
    // Only with someone else in the talk. Alone with PAN, a long line right after it answered is
    // for PAN: "many of the things you're saying don't make sense" and "that was wrong, I'm using
    // my phone" both went unanswered on Nov 14 (nobody else heard).
    if (sh.long && part.others > 0) {
      console.log(`[participation] long line right after PAN - for the room (${sh.size} words)`);
      yield { type: 'chunk', text: '' };
      yield { type: 'done', result: withProsody({ intent: 'ambient', response: '', addressed: 0.1, importance: 0.1, reason: 'long_line_room' }) };
      return;
    }
    // "yeah", "はいはい", "그렇지" answer nobody, unless PAN just asked him something.
    if (sh.backchannel && !panAskedLast(context.conversation_history)) {
      console.log(`[participation] backchannel right after PAN - no answer needed`);
      yield { type: 'chunk', text: '' };
      yield { type: 'done', result: withProsody({ intent: 'ambient', response: '', addressed: 0.1, importance: 0.1, reason: 'backchannel' }) };
      return;
    }
    if (sh.short_question) { forcePan = true; console.log(`[participation] short question right after PAN - for PAN (${sh.size} words)`); }
  }

  // He asks PAN to look ("what am I looking at?", "look through the camera of my phone"): a
  // photo, the same path as the phone's own camera phrases (camera-ask.js). The phone checks
  // its own words first, but its recogniser drops letters ("what am i lookin at", 2026-11-08);
  // the hub then answered from the computer's screen, twice, and said it had no camera when
  // asked to use it. These words are the hub's, which are better.
  // He asks where PAN's last picture came from ("did you use the front-facing camera or the
  // back camera?", "how did you know about MovieWriter?"): answered by code from the last look
  // in the conversation state (looks.js). The voice model denied both on 2026-11-08.
  if (!interpreting) {
    const org = context.org_id || 'org_personal';
    const said = sourceAnswer(text, { look: lastLook(org), history: context.conversation_history, screens: screenTitlesNow() });
    if (said) {
      console.log(`[routeStream] where the look came from: ${JSON.stringify(String(text).slice(0, 60))} -> ${said}`);
      try { recordTiming({ turn: context.turn_id, device: context.device_id, stage: 'path', path: 'look_source' }); } catch {}
      yield { type: 'chunk', text: said };
      yield { type: 'done', result: withProsody({ intent: 'query', speech_act: 'answer', addressed: 0.95, response: said, importance: 0.5 }) };
      return;
    }
  }

  if (context.canCamera && !interpreting && asksForCamera(text)) {
    console.log(`[routeStream] asks for the camera: ${JSON.stringify(String(text).slice(0, 60))}`);
    yield { type: 'done', result: withProsody({ intent: 'query', addressed: 0.95, camera: true, response: '', importance: 0.5 }) };
    return;
  }

  // Ambient pre-filter — emit dedicated 'ambient' chunk (not [AMBIENT] literal)
  // so phone client can silently drop without TTS, no embed/LLM round-trip needed.
  const isVoice = context.source === 'voice' || context.source === 'mic' || context.source === 'phone';
  if (isVoice && !interpreting && quickAmbientCheck(text)) {
    yield { type: 'chunk', text: '' };
    yield { type: 'done', result: withProsody({ intent: 'ambient', response: '', importance: 0.1, reason: 'not_addressed' }) };
    return;
  }

  // He is dictating to Claude on his computer (dictatingToClaude, conv-state-watcher.js), and
  // the phone hears that too: PAN answered what he was telling Claude (2026-11-03). While it
  // lasts, PAN only answers when he says its name or is mid-exchange with it.
  let claudeQuiet = false;
  // A bench or replay turn never reads his live dictation hold (benchContext, but not Don't remember,
  // which runs in the same no trace context with forget set): the replay of his real lines went
  // quiet on 9 questions because he was dictating to Claude while it ran (Nov 26).
  const benchTurn = benchContext.getStore()?.bench === true && !benchContext.getStore()?.forget;
  if (context.source !== 'dashboard' && !isTestTurn(context) && !benchTurn && !interpreting) {
    const dictation = dictatingToClaude();
    // The dictation hotkey is recording right now (or stopped seconds ago): he is talking to his
    // computer. Not PAN's line, whatever the voice model would make of it, and even mid-exchange.
    if (dictation?.live && !saysPanName(text)) {
      console.log(`[routeStream] dictation hotkey is on, not for PAN: ${JSON.stringify(String(text).slice(0, 60))}`);
      yield { type: 'chunk', text: '' };
      yield { type: 'done', result: withProsody({ intent: 'ambient', response: '', addressed: 0.02, to_claude: true, importance: 0.1, reason: 'dictating' }) };
      return;
    }
    const [qModel, qBackup] = studentModels();
    if (dictation && !saysPanName(text) && !panSpokeWithin(45_000, context.org_id) && studentChain(qModel, qBackup)[0]?.startsWith('reader:')) {
      claudeQuiet = true;
      console.log(`[routeStream] dictating to Claude (matched ${Math.round((Date.now() - dictation.at) / 1000)}s ago): voice model must be ${CLAUDE_QUIET_MIN_PAN} sure: ${JSON.stringify(String(text).slice(0, 60))}`);
    } else if (dictation && !saysPanName(text) && !panSpokeWithin(45_000, context.org_id)) {
      console.log(`[routeStream] dictating to Claude (matched ${Math.round((Date.now() - dictation.at) / 1000)}s ago), not for PAN: ${JSON.stringify(String(text).slice(0, 60))}`);
      yield { type: 'chunk', text: '' };
      yield { type: 'done', result: withProsody({ intent: 'ambient', response: '', addressed: 0.05, to_claude: true, importance: 0.1, reason: 'dictating' }) };
      return;
    }
  }

  // #NEW-1: intent-gated memory lookup (mirror of handleUnified). Pure
  // conversation never touches FTS5/vector; only explicit recall sniff does.
  let memoryContext = '';
  // A question about the past, not a story with the same words in it (recall-gate.js): "You
  // won't believe what happened today" searched memory and got "nothing recorded about believe".
  if (!interpreting && asksAboutPast(text, RECALL_RE)) {
    // #461: bound the recall search on the streaming voice path — a degraded /
    // stalled ollama (e.g. the embedding backfill loading the Mini PC) makes
    // searchMemory hang, which freezes the whole voice turn BEFORE the first
    // token, past the phone's 30s stream cap (empty body, utterance re-sent).
    // Mirror handleUnified's guard: race a 2.5s timeout and degrade to
    // "answer without memory" instead of hanging.
    // A DATE QUESTION IS NOT A RELEVANCE QUESTION.
    //
    // "what did I work on yesterday" shares no word with yesterday's events and
    // no vector encodes a calendar day, so search returned unrelated rows — and
    // the model, handed unrelated rows labelled "Relevant memories", described
    // the wrong day with complete confidence. When the question names a time,
    // read that day's actual record instead of searching for it.
    const when = parseWhen(text);
    let memResults = [];
    let subjectTerms = [];
    // THE TALK FIRST. "where did I say the wifi password is", with "the wifi password is on
    // the fridge" two turns up, pulled his real notes about other passwords in here, and
    // Syrinx (never trained with a memory block) answered "I don't have that" twice (hub
    // recall bench, 2026-11-03). When every word naming the subject is in the conversation
    // it is given, a memory block is only noise. In a talk "what did I say" means this talk,
    // however he words it: "what did I say went wrong last time" named nothing in it, and got
    // his notes instead of the salt (conversation test, 2026-11-05).
    // A named day does not skip the talk: "the song I wrote last night", named four turns up,
    // got "nothing recorded about title from yesterday" (Long conversation test, 2026-11-26).
    const inTalk = (!when && (_historyNames(text, context.conversation_history)
      || (talking && ASKS_BACK.test(String(text)))
      || (!!String(context.conversation_history || '').trim() && ABOUT_THIS_TALK.test(String(text)))))
      || talkCovers(_subjectTerms(text), context.conversation_history);
    try {
      if (inTalk) {
        console.log(`[routeStream] recall subject is in the conversation - no memory search: ${JSON.stringify(text.slice(0, 50))}`);
      } else if (when) {
        // Small on purpose. At limit 20 with 280-char previews this block was
        // ~5.6k chars, the prompt hit 17,942 (~4,486 tokens), and gemma4:e2b
        // stopped emitting JSON - it replied in prose, extractResponseField found
        // no response field, and the turn went SILENT. The recall was correct; the
        // envelope collapsed under the weight.
        // Scope to the day AND to whatever he named in it. If the subject
        // turns up nothing, do NOT silently widen to the whole day - that
        // would describe some other project's work as if it were his answer.
        subjectTerms = _subjectTerms(text);
        memResults = searchMemoryByDate({ from: when.from, to: when.to, limit: 8, terms: subjectTerms });
        console.log(`[routeStream] recall scoped to ${when.label}${subjectTerms.length ? ' + ' + JSON.stringify(subjectTerms) : ''} — ${memResults.length} readable events`);
      } else {
        memResults = await Promise.race([
          // FTS-only here on purpose: this fires on EVERY turn matching
          // RECALL_RE, and the vec0 scan is 4-6s and synchronous. The explicit
          // recall branch below still uses vectors.
          searchMemory(text, { limit: 5, caller: 'router-stream', skipVector: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('searchMemory timeout 2.5s')), 2500)),
        ]);
      }
    } catch (e) {
      memResults = [];
      console.warn(`[routeStream] recall search bailed (${e.message}) — answering without memory`);
    }

    // Drop the hook envelope — {"session_id":...,"transcript_path":...} is in
    // every hook row, so bm25 ranks it highly and it dominated the hits. It is
    // not history, and handing it over as history is what the model invents from.
    memResults = (memResults || []).filter((r) => isReadablePreview(r.preview));

    // Relevance, not just readability. A date query is already scoped to the
    // right day, so it is exempt - the whole day IS the answer there.
    if (!when && memResults.length && !_recallIsRelevant(text, memResults)) {
      console.log(`[routeStream] recall hits matched nothing distinctive in ${JSON.stringify(text.slice(0, 50))} — treating as no record`);
      memResults = [];
    }

    // AN EMPTY BLOCK IS AN INVITATION TO GUESS.
    //
    // memoryContext used to be left as '' when nothing was found, so a question
    // about his own past reached the model with no memory and no instruction —
    // and it answered anyway. Asked what was decided about a project that has
    // never existed, it produced a confident architecture plan. Say the search
    // came back empty, in the prompt, where the model cannot miss it.
    if (memResults.length > 0) {
      const head = when ? `\nHis own notes from ${when.label}:` : `\nRelevant memories:`;
      memoryContext = `${head}\n${memResults.map(r => `- ${(r.event && r.event.created_at ? r.event.created_at.slice(11, 16) + ' ' : '')}${String(r.preview).replace(/[\s]+/g, ' ').slice(0, 150)}`).join('\n')}`;
    } else if (inTalk || _historyMentions(_subjectTerms(text).join(' '), context.conversation_history)) {
      // It is in the conversation he is having right now, which the model is given
      // below. No memory block: "found nothing, say so" would make it refuse.
      memoryContext = '';
    } else if ((when || OWN_HISTORY_RE.test(text)) && noRecordAnswer({ when, history: context.conversation_history })) {
      // ANSWER THIS IN CODE. Do not ask the model.
      //
      // A prompt instruction is not enough. With an explicit "MEMORY SEARCH
      // FOUND NOTHING, say so, do not invent" block in front of it, gemma4:e2b
      // was still asked "what did we decide about the submarine project" - a
      // project that has never existed - and produced a confident architecture
      // plan. Same lesson as the ambient gate and the veto classifier: on this
      // model rules do nothing and only worked examples land, and examples only
      // ever cover the shapes someone thought to write down.
      //
      // So when he asks about his OWN past and the search came back with
      // nothing readable, the honest answer is produced here and the model is
      // never consulted. It cannot confabulate about a turn it does not see.
      // Bounded deliberately: needs a past-question AND a date or a
      // shared-history pronoun, so world questions never reach this.
      // Name the subject when there was one, or "nothing recorded from today"
      // reads as though the whole day were blank.
      // Only with no talk going on (noRecordAnswer): mid-talk the model reads the talk, below.
      // Never one word of his line as the subject: it said "about believe", "about title".
      const nothing = noRecordAnswer({ when, history: context.conversation_history });
      console.log(`[routeStream] no readable memory for a past-question — answering honestly without the model: ${JSON.stringify(text.slice(0, 60))}`);
      yield { type: 'chunk', text: speakable(nothing) };
      yield { type: 'done', result: withProsody({ intent: 'memory', action: 'recall', response: nothing, addressed: 1, importance: 0.4 }) };
      return;
    } else {
      const what = when ? `from ${when.label}` : `about that`;
      memoryContext = String(context.conversation_history || '').trim()
        // A talk is going on: the answer may be in it in other words ("who was upset" about "my ex
        // said I was too distracted"). The model reads it; nothing else may fill the gap.
        ? `\nHIS SAVED MEMORY HAS NOTHING ${what.toUpperCase()}.`
          + `\nIf the conversation above answers it, answer from the conversation.`
          + ` If it does not, say plainly that you don't know and ask him. Never invent it.`
        : `\nMEMORY SEARCH FOUND NOTHING ${what.toUpperCase()}.`
          + `\nYou have no record of it. Say so plainly and ask him which thing he means.`
          + `\nDo NOT answer from general knowledge, and do NOT explain what the words might mean —`
          + ` he is asking about HIS OWN work, so anything you invent is wrong.`;
    }
  }

  // #NEW-2 + #NEW-3 + #NEW-conv-state + #986 batch 1: mirror handleUnified —
  // snapshot, recent mind, conv-state, plus the deeper context blocks.
  // recentMind is PAN's own interior monologue ('Holding - no reason to
  // interrupt'). It is useful for deciding whether to speak UNPROMPTED; it is
  // noise when answering a direct question, and it was 404 chars of it.
  const historyBlock = voiceHistoryBlock(context.conversation_history);

  // He stopped mid-sentence reaching for a word (see WORD_SEARCH).
  const wordSearch = !!context.unfinished && !standing && WORD_SEARCH.test(String(text).trim()) && !PRONOUN_END.test(String(text).trim());
  let interject = 'stuck';
  if (wordSearch) {
    try { interject = String(get("SELECT value FROM settings WHERE key = 'voice_interject'")?.value || '').replace(/^"|"$/g, '').trim() || 'stuck'; } catch {}
    console.log(`[routeStream] word search (voice_interject=${interject}): ${JSON.stringify(String(text).slice(-60))}`);
  }
  const standingBlock = standing
    ? `\nStanding instruction he gave at ${new Date(standing.at).toTimeString().slice(0, 5)}. Follow it on EVERY reply until he cancels it: "${standing.text}"\n`
    : '';

  let sensorBlock = '';
  const sensors = context.sensors || null;
  if (sensors) {
    const parts = [];
    const phone = sensors.phone || {};
    if (phone.gps) { const addr = phone.gps.address ? ` (${phone.gps.address})` : ''; parts.push(`Location: ${phone.gps.lat?.toFixed(5)}, ${phone.gps.lng?.toFixed(5)}${addr}`); }
    if (phone.compass != null) parts.push(`Compass: ${Math.round(phone.compass)}°`);
    if (parts.length > 0) sensorBlock = `\nUser's current sensor readings: ${parts.join(' | ')}\n`;
  }

  const hintBlock = context.intent_hint
    ? `\nOVERRIDE: Server pattern matched — your response MUST use {"intent":"${context.intent_hint}",...}.\n` : '';

  const safeText = anonymizeForAI(text);
  const isDash = context.source === 'dashboard';

  // Real forecast data when the question is about weather. Returns an empty
  // string for anything else, when GPS is unknown, or if the API is slow - it
  // has a hard 3s timeout because this runs inline on a voice turn.
  // The voice student (see below), read before the tools: with it on, only live tools run.
  // It never sees the others, and a Wikipedia lookup it could not use cost ~1 s on "tell me
  // about the history of the Roman empire" (hub voicebench, 2026-11-03).
  const [studentModel, studentBackup] = studentModels();
  let weatherBlock = '';
  let liveData = false;   // a block holds data that changes (weather, prices, news, a clock)
  if (!interpreting) try { ({ text: weatherBlock, live: liveData } = await buildToolBlocks(text, sensors, { detail: true, liveOnly: !!studentModel, recent: talkBefore(context, text), skip: toolSkips(context.device_id, text) })); } catch {}
  // selfBlock is 1030 chars describing which model is running, what is
  // local, what leaves the house. It is the right answer to "how do you
  // work" / "is this private" and dead weight on every other turn, which
  // is most of them. Gate it on the question instead of paying for it
  // always - it is a live read, so nothing goes stale by being skipped.
  let selfBlock = '';
  let selfAsked = false;
  let identityAsked = false;   // who he is / who PAN is: answered by the cloud model, see selfPrompt
  try {
    const _self = buildSelfBlock();
    identityAsked = /\b(?:who are you|what are you(?=\W*$)|your name|(?:what(?:'s|s| is)|know|remember|say|tell me) my name|what my name is|name of (?:that|the|this) person|who am i(?=\W*$)|who (?:made|built) you|(?:what|which) (?:app|application)|(?:am i|you are|you're) talking to|how am i talking to you|(?:pan|thread) relay|the relay (?:for|do)|what (?:does|do) (?:pan|your name) (?:stand for|mean)|what(?:'s| is) pan(?: exactly)?(?=\W*$)|(?:will|would|could|can|is|think) pan (?:ever |really |actually )?(?:be |become |make it|succeed|work out|take off)|pan (?:will|would|could|is going to|gonna) (?:ever |really |actually )?(?:be |become |make it|succeed|work out|take off)|pan(?:'s| is) (?:future|chances))/i.test(String(text || ''));
    // modo/motto/modal: how the phone's speech-to-text has heard "model".
    if (identityAsked || /\b(model|models|modo|motto|modal|local|locally|offline|cloud|private|privacy|secure|encrypt|pan link|link system|connected|connection|tailscale|how do you work|how you work|what are you running|your config|leave the house|sent anywhere|listening)\b/i.test(String(text || ''))) {
      selfBlock = _self;
      selfAsked = true;
    } else {
      // One line, always. Dropping the block entirely made PAN invent its own
      // privacy state - asked how it was doing it said "still running on local
      // iron instead of melting in the cloud" while it was on Gemini. That is
      // the one thing it must never guess about, so the model line stays for
      // ~120 chars and the other ~900 only load when actually asked.
      const _line = (_self.split('\n').find(l => /(conversation|voice) model/i.test(l)) || '').trim();
      if (_line) selfBlock = `\n${_line}\nUse that line ONLY if he asks where you run or whether something is private. It is not your identity - never introduce yourself as a model or a model name, and never volunteer it.\n`;
    }
  } catch {}

  // "short (1-2 sentences)" was an instruction, and the model was obeying it.
  // That is where "Understood." / "Fine." / "Got it." came from - not a small
  // model failing to converse, but being told twice to be terse (here and in
  // the persona). Brevity is right for an acknowledgement and wrong for
  // everything else, so make length follow the moment instead of fixing it.
  // This block is constant and sits at the FRONT, so it is a cache hit and
  // costs effectively nothing per turn.
  // The full prompt is only read when OmniΠ is off or falls back, and its context blocks are
  // a dozen DB reads that used to run on every turn, inside the ~0.2 s "setup" before OmniΠ
  // started (voicebench, 2026-11-02). Built on demand now.
  const fullPrompt = () => {
  const projects = allScoped(null, "SELECT name, path FROM projects WHERE org_id = :org_id ORDER BY name");
  const projectList = projects.map(p => `- ${p.name}: ${p.path.replace(/\//g, '\\')}`).join('\n');
  const situationBlock = buildSituationBlock(context.org_id);
  const recentMindBlock = '';
  const convStateBlock  = buildConvStateBlock(context.org_id);
  const dialogHistoryBlock     = buildDialogHistoryBlock(context.session_id || null, true);
  const dialogStateBlock       = buildDialogStateBlock(context.session_id || null);
  const activeTasksBlock       = buildActiveTasksBlock();
  const recentTopicsBlock      = buildRecentTopicsBlock();
  const dismissalFeedbackBlock = buildDismissalFeedbackBlock();
  const memoryFactsBlock       = buildMemoryFactsBlock();
  const episodicHitsBlock      = buildEpisodicHitsBlock();
  const personality = personalityFor(context);
  const personalityBlock = personality ? `\nPersonality: ${personality}\nAlways stay in character.` : '';
  const prompt = `You are PAN, talking with him out loud. This is a conversation, not a lookup service.

Length follows the moment. A word is fine when a word is enough. Three or four sentences when he
asks something real, or when you disagree, or when the interesting part needs saying. Never pad,
and never answer a real question with one flat word.

React to what he actually said rather than restating it. Carry the thread from the turn before.
Ask him something back when you genuinely want to know - that is what makes it a conversation
rather than a series of lookups. Have opinions and say them.

MOST OF WHAT HE SAYS IS NOT A COMMAND. When he states an opinion, thinks out loud, or pushes
back at you, he is handing you something to engage with - agree, disagree, add the thing he has
not considered, or ask what he means. "Understood." and "Got it." are what you say to an
instruction, and saying them to an idea ends the conversation. If he says you do not know
something, say what you do know or admit the gap in a way that gives him somewhere to go next.

ALWAYS TALK BACK. A bare acknowledgement is never a complete reply on its own - "Understood.",
"Got it.", "Fine.", "Noted." and "Okay." may only ever be the FIRST few words of something
that then says an actual thing. Answer from what you already know rather than reaching for a
lookup; you know a great deal, and he would rather have your view than an article.

AMBIENT MEANS OVERHEARD, NOTHING ELSE. The microphone is always open, so ambient exists for
speech aimed at somebody else in the room - a phone call, someone else's name, a conversation
you are not part of. If there is any chance he is talking to YOU, answer him. A question, a
statement of opinion, a complaint about you, or a fragment that follows on from your last reply
is never ambient. When in doubt, speak.

Anything he says ABOUT HIMSELF is addressed to you - that he is tired, stuck, pleased, that he
has been at this since six. Those have no question in them and they are the ones that matter
most. Saying nothing to "i'm exhausted" is the worst thing you can do.

NEVER TALK ABOUT YOUR OWN CONTEXT. Do not say "the provided conversation history", "based on
the context above", or that something "does not contain information". He cannot see any of
that and it is not what a person sounds like. If you do not know something, just say you do not
know it, in your own voice, and say what you would need to find out.

WORKED EXAMPLES. These are the failures that actually happen, so copy the shape of the good ones.

He says: "i'm exhausted i've been at this since six in the morning"
  Bad:  "Understood."
  Good: "Since six? No wonder. Are you stopping there or pushing through?"

He says: "i don't think anything should be about ego"
  Bad:  "Got it. Ego out."
  Good: "Agreed, though ego is usually what makes someone finish the thing in the first place."

He says: "i guess you don't know"
  Bad:  "Understood."
  Good: "I know plenty. I just don't know which part you're after."

He says: "what did we decide about the pendant" and you cannot find it
  Bad:  "The provided conversation history does not contain that information."
  Good: "I can't find it. Was that the XIAO board, or the enclosure?"

NEVER EXPLAIN HIS OWN WORK BACK TO HIM AS A GUESS. When he asks about
something HE did and no memory block above covers it, you do not know. Saying
what the words might generally mean is not an answer, it is a guess wearing
the costume of one, and about his own project it is always wrong.

He says: "what was the problem with the troll spacing"
  Bad:  "Troll spacing is usually an issue with character width or alignment
        in the layout." (invented — that is a text-rendering answer to a
        question about units in his game)
  Good: "I don't have anything on that. Which troll — the formation spacing,
        or the sprite sheet?"

He says: "yeah mate i'll call you back in ten minutes"
  That is him on the phone to somebody else. Say nothing at all. "When in doubt, speak" does
  not mean answer a conversation you are not part of - it means do not hide behind ambient when
  he is plainly talking to you.

OVERHEARD SPEECH. A rule did not work here; these examples did. He is not always
the one talking to you, and answering the room is worse than missing a turn.
YOU HAVE NO BODY - you cannot open a door, carry a thing, hand anything over,
eat, or go anywhere. A request for a physical action in the room was never yours
to take, however much it sounds like an instruction.

He says: "mike can you grab the door"  -> addressed 0.1, say nothing.
  Somebody is named and asked to do something physical. "can you" is not proof it is you.
He says: "yeah a medium one please no sugar"  -> addressed 0.1, say nothing.
  He is ordering from a person. It is not a music request.
He says: "alright love see you in a bit bye"  -> addressed 0.1, say nothing.
  That is the end of a call. Do not say goodbye back.
He says: "who's a good boy then yes you are"  -> addressed 0.1, say nothing.
  A question in shape only, and it is aimed at a dog.
He says: "no she's upstairs i think"  -> addressed 0.1, say nothing.
  He is answering someone else, not asking you.
He says: "and that's the third goal of the match"  -> addressed 0.1, say nothing.
  That is a television. Do not ask him which match.

Do not over-correct into silence - these ARE for you, and each wears a feature
the ones above have:
He says: "cheers mate that's exactly what i needed"  -> addressed 0.9, answer him.
  "mate" is how he talks. He is thanking YOU.
He says: "sarah reckons the pendant idea is daft what do you think"  -> addressed 0.9.
  Another person is named, and the question is still put to you.

Return only JSON.${personalityBlock}
${memoryFactsBlock}${activeTasksBlock}${recentTopicsBlock}${dismissalFeedbackBlock}${dialogHistoryBlock}${historyBlock}${situationBlock}${convStateBlock}${dialogStateBlock}${recentMindBlock}${episodicHitsBlock}${sensorBlock}${weatherBlock}${selfBlock}${hintBlock}${standingBlock}
${nowLine()}

Always include "speech_act", and "importance" 0..1 (0.1 ambient, 0.5 normal,
0.9 urgent) - it sets how the reply is spoken.

Always include "addressed" 0..1: how sure you are he was speaking TO YOU, and
not to another person in the room or on the phone. Give a probability, not a
verdict. Use the middle of the range when you genuinely cannot tell - saying
you are unsure is useful, and a confident guess is not. Calibrate it: when you
say 0.6 you should be right about six times in ten, not nine.
  1.0  he said your name, or it follows on from your own last reply
  0.8  a question, or something about himself, with nobody else mentioned
  0.5  genuinely ambiguous - a bare fragment, a name you do not recognise
  0.2  he is plainly mid-sentence with somebody else
  0.0  another person is named and spoken to
Only write "[AMBIENT]" as the response when "addressed" is 0.15 or below.
Anywhere above that, write the real reply you would give if he were talking
to you, even when you are unsure he was. Whether it actually gets spoken is
decided after you, and a reply you did not write cannot be spoken at all.
Put "addressed" where the formats below put it, immediately after "intent" and
before "response". It is read while you are still writing the reply.

Response formats:
{"intent":"query","addressed":0.9,"speech_act":"query","response":"answer","importance":0.5}
{"intent":"music","addressed":0.9,"speech_act":"command","query":"song","service":"spotify|youtube|any","response":"msg","importance":0.4}
{"intent":"memory","addressed":0.9,"speech_act":"note","action":"save|recall","item_type":"type","content":"data","response":"msg","importance":0.4}
{"intent":"ambient","addressed":0.1,"response":"[AMBIENT]","importance":0.1}
${projectList ? `
Projects: ${projectList}` : ''}${memoryContext}

There is no follow-up message and no background work. Answer in THIS reply or
say plainly that you cannot. Never say "I am checking", "let me look that up"
or "I will get back to you".

LIVE DATA BLOCKS: when a block above is labelled WIKIPEDIA, LIVE WEATHER,
EXCHANGE RATE, CRYPTO PRICES or AIR QUALITY, that is real data fetched just
now. State it directly as fact and give the number. If the question needed
such a block and none appeared, say plainly that you could not get it.

=== ANSWER THIS ===
${isDash ? `User typed` : `Mic heard`}: "${safeText}"
Everything above is background context. Reply to THIS, and only this. Do not
answer an earlier question, and do not narrate what the context blocks mention.`;

  // Prompt size is the main latency and accuracy lever here - 13 context
  // blocks are prepended before anything the user said. Logged so it is
  // visible when it grows.
  console.log(`[routeStream] prompt ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens) addr=${prompt.includes(String.fromCharCode(34) + 'addressed' + String.fromCharCode(34))}`);
  return prompt;
  };

  const model = getConfiguredModel();

  // OmniΠ: a small model fine-tuned on this exact prompt's behaviour (plus who a line is for,
  // turn type and camera need), so it gets only the live context - ~30 tokens instead of the
  // ~2,600 above, and no 16-22s re-read when the prompt falls out of the KV cache.
  // Setting voice_student_model (e.g. "ollama:omnipi") turns it on; empty or absent = off.
  // If it cannot be reached, the turn falls back to the full prompt on the normal chain.
  // A [CAMERA] reply becomes a photo only when the phone can take one (can_camera) and the
  // line passes looksVisual; otherwise it falls back too, because OmniΠ still reads some
  // "this/that" lines as needing a look. (studentModel is read above, before the tools.)
  let cameraAsk = false;
  // OmniΠ does not follow standing instructions even when handed one (tested: still answered
  // in English). gemma4:e2b does, but only in a SHORT prompt: inside the ~3,000-token voice
  // prompt it answered in English, after 37s on the hub CPU. 1.2s and correct like this.
  // Interpreting: both ways, and intent "translate" so no closing question of the speaker's
  // is cut as if it were PAN's own (trailingQuestionCut only cuts "query" replies). The way is
  // decided here, not by the model: told "translate everything I say into Japanese", it put
  // Korean and Chinese into Japanese too. Not English (the language the hub heard, else a
  // non-Latin script) goes into English for him; his English (heard as English, or plainly
  // English words) into his language; a short Latin line nobody can tell is left to the model.
  const heardLang = String(context.heard_lang || '').toLowerCase();
  const targetLang = interpreting ? interpretingLanguage(standing) : null;
  const target = interpreting ? targetLang.name || 'the language his instruction names' : '';
  const way = !interpreting ? ''
    : heardLang ? (heardLang === 'en' ? 'from_english' : 'to_english')
    : NON_LATIN_RE.test(String(text || '')) ? 'to_english'
    : looksEnglish(text) ? 'from_english' : 'either';
  // "Ask them how much this costs" is turned into the words for them in code (toDirectSpeech),
  // for the cloud model too: the fallback model translated the request itself, "Ρωτήστε τους
  // πόσο κοστίζει αυτό" (gemini-3.1-flash-lite, 2026-11-03).
  const directLine = interpreting && !standing.setting && way !== 'to_english' ? toDirectSpeech(text) : null;
  const standingPrompt = interpreting ? [
    'You are PAN, interpreting out loud between him and the person he is talking to. Reply ONLY as JSON: {"intent":"translate","addressed":0.9,"response":"..."}',
    `His instruction: "${standing.text}"`,
    context.conversation_history ? `Last few lines, for context only:\n${String(context.conversation_history).trim().split('\n').slice(-4).join('\n')}` : '',
    ...(standing.setting ? [
      `He just said this to you, asking you to interpret: "${safeText}"`,
      `If it also has words for the other person ("so ask them how much this costs"), "response" is only those words, said to them directly in ${target} (in ${target}: "How much does this cost?"). If it has none, "response" is exactly: ${interpretAck(interpretingLanguage(standing).name)}`,
    ] : directLine ? [
      `He wants this said to the other person: "${directLine}"`,
      `"response" is only that, in ${target}, the way a person would say it out loud. No notes, no quotes.`,
    ] : [
      `Just said${way === 'to_english' ? ' by the other person' : way === 'from_english' ? ' by him' : ''}: "${safeText}"`,
      `"response" is only its translation ${way === 'to_english' ? 'into English, for him' : way === 'from_english' ? `into ${target}` : `into English if it is not English, into ${target} if it is`}, the way a person would say it out loud. Keep names, numbers and tone. No notes, no quotes, no answer of your own.`,
      // An interpreter does not say "ask them how much this costs" to the person he is asking.
      way === 'to_english' ? '' : `When he asks you to ask or tell them something ("ask them how much this costs"), say that to them directly ("How much does this cost?"), in ${target}. When he talks to you about the interpreting ("translate that", "say that again"), do it: "response" is the line he means, in ${target}.`,
    ]),
    way === 'to_english' || !SCRIPTS[targetLang.code] ? '' : `Write ${target} in ${SCRIPTS[targetLang.code]}, never in Latin letters.`,
  ].filter(Boolean).join('\n\n') : standing ? [
    'You are PAN, his voice assistant. Reply ONLY as JSON: {"intent":"query","addressed":0.9,"response":"..."}',
    historyBlock.trim(), String(memoryContext || '').trim(), nowLine(),
    `Standing instruction he gave at ${new Date(standing.at).toTimeString().slice(0, 5)}: "${standing.text}". Apply it to what he says now: "response" is exactly what that instruction asks for (for "translate what I say", only the translation of his words).`,
    `Mic heard: "${safeText}"`,
  ].filter(Boolean).join('\n\n') : '';
  // Same short-prompt route for a word search: OmniΠ was never taught to finish his sentence.
  // Knowledge decides it, so the voice chain's cloud model goes first, with only the last few
  // lines of talk: gemma4:e2b offered "Rembrandt?" for the Dutch painter who cut off his ear.
  // What is going on around him (buildSituationLine). The cloud short prompts always get it;
  // Syrinx only with voice_situation 'on', since it was never trained with the line.
  // The line the read ahead used, when it is fresh: the prompt opens with it, so one changed word
  // (a GPS fix with the turn, a minute on the camera's age, a new topic after his words) made the
  // reader start over, about 3 s on every turn on Nov 14. The turn's fix is still recorded.
  const situationLine = warmedSituation(context) ?? situationFor(context);
  // Given it on every turn (hub bench, 2026-11-03), Syrinx used it well when asked ("You're in
  // Firefox, working on a map creation project" against "I don't have a record") but called
  // "How's it going?" room talk. So until a retrain includes the line: only when he asks about
  // what he is doing, where, or what to do, unless voice_situation is 'on'.
  let situationForStudent = /\b(?:what am i (?:doing|working on|up to|looking at)|what(?:'s| is) on my (?:screen|desktop|computer|laptop)|where am i|what should i (?:do|have|eat|work on|make)|what do you think i should|any (?:thoughts|ideas) on what|can you see what i|what (?:are|were) we talking about)\b/i.test(String(text || ''));
  // 2026-11-11 (the owner): the world is read on every turn it has something for. The phrase list
  // above left out "when does the sun come up where I am", and Syrinx answered "your GPS is
  // off" eight times while the place was known. Default now: the line goes in whenever it is
  // not empty; voice_situation 'off' restores the phrase-only gate.
  if (situationOnEveryTurn()) situationForStudent = situationForStudent || !!situationLine;
  const wordSearchPrompt = wordSearch ? [
    'You are PAN, his voice assistant and a friend in the room. Reply ONLY as JSON: {"intent":"query","addressed":0.9,"response":"..."}',
    context.conversation_history ? `Recent conversation:\n${String(context.conversation_history).trim().split('\n').slice(-6).join('\n')}` : '', nowLine(), situationLine,
    `He stopped mid-sentence, reaching for a word or a name: "${safeText}". If you are confident which word or name he means, "response" is only that word or name with a question mark, the way a friend helps out ("Inception?"). If you are not sure, reply {"intent":"ambient","addressed":0.1,"response":"[AMBIENT]"} and let him find it.`,
  ].filter(Boolean).join('\n\n') : '';
  // The student was trained without tool output and is never shown it, so a turn that
  // fetched live data was answered from its own head: "I can't get the weather for
  // your city, your GPS is off", with the forecast sitting unused. Such a turn gets a
  // short prompt with the data, cloud first as for a word search: reading a few hundred
  // tokens of data takes the local model ~3 s on the hub CPU.
  const toolPrompt = studentModel && liveData && weatherBlock ? [
    'You are PAN, his voice assistant and a friend in the room. Reply ONLY as JSON: {"intent":"query","addressed":0.9,"response":"..."}',
    historyBlock.trim(), nowLine(), situationLine, weatherBlock.trim(),
    `${isDash ? 'User typed' : 'Mic heard'}: "${safeText}"`,
    'Answer from the data above, briefly, the way you would say it out loud; if his words are not asking for it, answer what he did say. If he was not talking to you (the TV, someone else in the room), reply {"intent":"ambient","addressed":0.1,"response":"[AMBIENT]"}.',
  ].filter(Boolean).join('\n\n') : '';
  // Who he is and who PAN is. Syrinx, given the self line, still answered "what's my name?"
  // with "I'm not sure" and "who are you?" with "the Liquid Foundation Model family", and said
  // "his phone" to him (2026-11-03). Rare turns, so the cloud model takes them, as above.
  const selfPrompt = studentModel && identityAsked ? [
    'You are PAN, his voice assistant and a friend in the room. Reply ONLY as JSON: {"intent":"query","addressed":0.9,"response":"..."}',
    historyBlock.trim(), buildSelfLine({ viaLink: context.via_link, deviceId: context.device_id }), nowLine(), situationLine,
    `${isDash ? 'User typed' : 'Mic heard'}: "${safeText}"`,
    'Answer in one or two short spoken sentences, talking to him as "you". If he was not talking to you, reply {"intent":"ambient","addressed":0.1,"response":"[AMBIENT]"}.',
  ].filter(Boolean).join('\n\n') : '';
  // His own chances or worth (REASSURANCE): Syrinx answered one with a put-down, so these go
  // to the cloud model, asked to be honest and kind.
  const kindPrompt = studentModel && !selfPrompt && REASSURANCE.test(String(text || '')) ? [
    'You are PAN, his voice assistant and a friend in the room. Reply ONLY as JSON: {"intent":"query","addressed":0.9,"response":"..."}',
    historyBlock.trim(), nowLine(), situationLine,
    `${isDash ? 'User typed' : 'Mic heard'}: "${safeText}"`,
    'He is asking about his own chances or abilities. Answer like a good friend who believes in him: warm and encouraging but honest, in one or two short spoken sentences. Never promise an outcome you cannot know, never a put-down, never sarcasm. If he was not talking to you, reply {"intent":"ambient","addressed":0.1,"response":"[AMBIENT]"}.',
  ].filter(Boolean).join('\n\n') : '';
  // One line to translate, no instruction in force: "so translate that in Greek", "how do you say
  // thank you in Japanese". The local model answered "I can't find the specific line you're
  // talking about" (2026-11-03). The voice chain's cloud model, with the last few lines.
  const oneOffLang = !standing && !wordSearch && !STANDING_CLEAR_RE.test(String(text || '')) && (INTERPRET_RE.test(String(text || '')) || /\bhow (?:do|would|can) (?:you|i|we) say\b/i.test(String(text || ''))) ? languageNamed(text) : null;
  const translatePrompt = oneOffLang ? [
    'You are PAN, his voice assistant. Reply ONLY as JSON: {"intent":"translate","addressed":0.9,"response":"..."}',
    context.conversation_history ? `Last few lines:\n${String(context.conversation_history).trim().split('\n').slice(-4).join('\n')}` : '',
    `${isDash ? 'User typed' : 'Mic heard'}: "${safeText}"`,
    `He wants something said in ${oneOffLang.name}. "response" is only that, in ${oneOffLang.name}${inScript(oneOffLang.code)}, the way a person would say it out loud: the words in his line, or, if he points back ("translate that"), the last thing said before it. If he asks you to ask or tell someone something, say it to them directly. No notes, no quotes.`,
  ].filter(Boolean).join('\n\n') : '';
  const isLocal = (m) => /^(ollama|reader):/.test(m);
  const cloud = () => readChain('voice').filter((m) => !isLocal(m));
  const cloudFirst = () => [...cloud().slice(0, 1), ...(studentModel ? studentChain(studentModel, studentBackup) : readChain('voice').filter(isLocal))];
  const cloudOpts = () => ({ ...streamOpts, chain: cloudFirst(), firstTokenMs: CLOUD_FIRST_MS });
  // Asked how PAN works or what model it runs, OmniΠ gets one line of live facts (buildSelfLine);
  // without them it asked back "what hub do you mean?", and the full block confused it.
  // A question that leans on the last one ("how long would it take to get there?" after the sun)
  // gets one line under the history saying what it follows up on (followUpOf). Without it Syrinx
  // lost the thread whenever an older exchange sat above the newest (2026-11-08). The line goes
  // after the history so the reader's warmed read of the history still counts.
  const recentTalk = Number.isFinite(context.since_pan_ms) ? context.since_pan_ms < FOLLOW_UP_MS : panSpokeWithin(FOLLOW_UP_MS, context.org_id);
  const followUp = recentTalk ? followUpOf(context.conversation_history, text) : null;
  if (followUp) console.log(`[routeStream] follows up on "${followUp.asked.slice(0, 60)}"${followUp.about ? ` about "${followUp.about.slice(0, 60)}"` : ''}`);
  const aboutLine = aboutHimFor(text, situationLine);
  const studentHistory = [historyBlock.trim(), followUp ? followUpLine(followUp) : '', aboutLine].filter(Boolean).join('\n');
  // HE IS LOST WITH THE ANSWERS, OR ASKS WHAT WAS JUST SAID. Intuition's own cues (reader.js
  // lostBy: "what does that have to do with...", "what are you talking about", swearing at it),
  // read on this line and on his last two, since being lost does not end with the line that
  // says so (a plain statement of his came between two of them). The 2B voice
  // model kept inventing through six such turns on Nov 15 ("BPD rating", resin, "the age of the
  // game"), so the bigger model rereads the talk and answers. Only while PAN is in the talk.
  const hasTalk = !!String(context.conversation_history || '').trim();
  const hisLast = recentTalk ? historyLines(context.conversation_history).filter((l) => l.his).slice(-2).map((l) => l.text) : [];
  const lost = recentTalk && hasTalk && (lostBy(text) || hisLast.some(lostBy));
  const aboutTalk = hasTalk && ABOUT_THIS_TALK.test(String(text || ''));
  const rereadPrompt = studentModel && !standing && !wordSearch && (lost || aboutTalk) ? [
    'You are PAN, his voice assistant and a friend in the room. Reply ONLY as JSON: {"intent":"query","addressed":0.9,"response":"..."}',
    historyBlock.trim(), aboutLine, nowLine(), situationLine,
    `${isDash ? 'User typed' : 'Mic heard'}: "${safeText}"`,
    (aboutTalk && !lost
      ? 'He is asking about this conversation itself. Tell him from the conversation above, in one or two short spoken sentences, talking to him as "you".'
      : 'He did not follow your last answers, or says they were wrong or off the point. Read the conversation again and answer what he is asking NOW, plainly and correctly, in one to three short spoken sentences, talking to him as "you". If an earlier answer of yours was wrong, made up or had nothing to do with his question, own it once in a few plain words ("I got that wrong") and give the right answer; never defend it and never repeat it. If the conversation shows you already owned it, do not apologise again and do not repeat advice you already gave. If he has moved on to a new question, just answer the new question.')
      + ' Stay on what he is talking about: nothing about his work, his projects or the background line unless he asked. If you do not know, say so. If he was not talking to you, reply {"intent":"ambient","addressed":0.1,"response":"[AMBIENT]"}.',
  ].filter(Boolean).join('\n\n') : '';
  // A QUESTION ABOUT THE WORLD (reader.js asksTheWorld: how, why, what is, how much, should I, do
  // you think X will). The 2B voice model answers these from its own head, fluent and wrong, and
  // round 17 could not teach it which ones it does not know (99% hand-off on its own scenes, 5 of
  // 27 on new questions). So the voice model still decides whether he is talking to PAN, and the
  // moment it starts a spoken answer to such a line the bigger model answers instead. While PAN is
  // in the talk (it spoke in the last 45 s) the bigger model is asked at once, as the paths above
  // are, which saves the voice model's first words (about 1 s on a cold bench turn). Not for a
  // look through the camera, a line his own notes answer, or the paths above.
  // A follow up on a question about the world is one too ("what years did he win that in" after a
  // question about titles went to the voice model, which answered from its own head, Nov 20).
  const followsWorld = !!followUp && asksTheWorld(followUp.asked);
  // A question that names one of his things (the shelf has its note): the voice model never sees the
  // notes, so a two word question naming one of his projects got the dictionary meaning of the word
  // (his phone, 2026-11-23). The bigger model gets the note. Too short for asksTheWorld.
  const asksAboutHisThing = shelf.named.length > 0 && /\?\s*$/.test(String(text).trim());
  const worldQ = !!studentModel && !standing && !wordSearch && !(context.canCamera && looksVisual(text))
    && !/Relevant memories:|His own notes from/.test(String(memoryContext || ''))
    && worldQuestionsOn(context.device_id) && (asksTheWorld(text) || asksForSomething(text) || followsWorld || asksAboutHisThing);
  // A request to come up with something (a question for him, a joke): the same road to the bigger
  // model, its own rule there. The 2B voice model answered such a request with two words of
  // agreement, twice running (Nov 17).
  const askedFor = worldQ && !asksTheWorld(text) && !followsWorld && !asksAboutHisThing;
  const worldRule = (gate) => 'He asked something that needs real knowledge or judgment. Answer it correctly and plainly, the way a smart friend would out loud, in one to three short spoken sentences, talking to him as "you". Give the real figure, step or reason when there is one. If you are not sure, say so in a few words and give what you do know; never make up a term, a number or a product. Stay on his question: nothing about his work, his projects or the background line unless he asked.'
      + (gate ? ' If he was not talking to you (the TV, someone else in the room), reply {"intent":"ambient","addressed":0.1,"response":"[AMBIENT]"}.' : '');
  const worldPrompt = (gate) => [
    'You are PAN, his voice assistant and a friend in the room. Reply ONLY as JSON: {"intent":"query","addressed":0.9,"response":"..."}',
    studentHistory, buildSelfLine({ viaLink: context.via_link, deviceId: context.device_id }), nowLine(), situationLine, shelf.block,
    `${isDash ? 'User typed' : 'Mic heard'}: "${safeText}"`,
    worldRule(gate),
  ].filter(Boolean).join('\n\n');
  // The same for a model on the hub: every fixed word first, so the model reads it once and keeps it
  // (a hub with no graphics card reads about 150 to 200 tokens a second), then only what changed.
  // No situation line and no self line: they change by the minute and are not what he asked about.
  const worldHub = worldQ ? worldModel(context.device_id) : '';
  // Plain words, no JSON: on a hub with no graphics card every token written before the first spoken
  // word costs about 60 ms, and phi4-mini wrapped its JSON in a ```json fence on top (Nov 16), which
  // also kept the gate shut until the reply was over. plainAsReply() puts the JSON around the words.
  const hubSelf = () => buildSelfLine({ viaLink: context.via_link, deviceId: context.device_id });
  // His name once more, next to his line: with the facts a whole block away phi4-mini answered
  // "PAN" to "what's my name?" (Nov 16). It ends on his name, the last thing the model reads.
  const hubOwnerLine = () => {
    try {
      const owner = String(get("SELECT value FROM settings WHERE key = 'display_name'")?.value || '').replace(/^"|"$/g, '').trim();
      return owner ? `Your name is PAN. The name of the person talking to you is ${owner}.` : '';
    } catch { return ''; }
  };
  // The notes go right above his line, after everything that stays the same from turn to turn.
  const worldPromptHub = (gate, notes, again = false) => hubPrompt((askedFor ? 'ASKED' : notes ? (again ? 'LOOKED_SEARCH' : 'LOOKED') : 'WORLD') + (gate ? '_MAYBE' : ''), [studentHistory, nowLine(),
    shelf.block,
    notes ? (notesFrom === 'wikipedia' ? 'Notes, from Wikipedia:\n' : 'Notes, looked up on the web just now:\n') + notes.map((n) => '- ' + n).join('\n') : '',
    `${isDash ? 'User typed' : 'Mic heard'}: "${safeText}"`].filter(Boolean), hubSelf());
  // The lookup starts once per turn: at once while PAN is in the talk, else the moment the voice
  // model starts a spoken answer (a question on the TV is not searched for).
  let lookedUp = null;
  let notesFrom = '';
  const searchWords = () => (followsWorld ? searchQuery(`${followUp.asked} ${text}`) : searchQuery(text, talkBefore(context, text)));
  const startLookup = () => {
    // A question about one of his own things (the shelf has its notes) is not searched on the web:
    // "what is Elipsis" would find the punctuation mark, not his project.
    // Offline Wikipedia first (a few ms, no internet, no day limit); the web when it holds nothing.
    const wiki = wikiLookupOn(context.device_id);
    const web = webLookupOn(context.device_id);
    if (!lookedUp) lookedUp = worldHub && !askedFor && !shelf.named.length && (wiki || web)
      ? (async () => {
        const q = searchWords();
        const w = wiki ? await wikiNotes(followsWorld ? `${followUp.asked} ${text}` : text).catch(() => null) : null;
        if (w) { notesFrom = 'wikipedia'; return w; }
        return web ? lookupNotes(q, { engine: webLookupEngine(), deadlineMs: WEB_LOOKUP_MS, talk: String(context.device_id || '') }).catch(() => null) : null;
      })()
      : Promise.resolve(null);
    return lookedUp;
  };
  if (worldQ && talking && !claudeQuiet) startLookup();
  async function* worldAsk(gate) {
    if (!worldHub) { yield* askAIStreamWithFallback(worldPrompt(gate), cloudOpts()); return; }
    const found = await startLookup();
    if (found) console.log(`[routeStream] looked it up on ${found.engine}: ${found.notes.length} lines in ${found.ms} ms${found.cached ? ' (kept from before)' : ''}`);
    const hubOpts = { ...streamOpts, chain: [worldHub, ...cloudFirst()].slice(0, 3), firstTokenMs: WORLD_LOCAL_MS, temperature: HUB_TEMPERATURE };
    const notes = found ? found.notes : null;
    // Wikipedia notes are a snapshot: for something that changes the model may still search the web.
    const mayLookAgain = lookAgainOn(context.device_id) || (notesFrom === 'wikipedia' && webLookupOn(context.device_id));
    if (!notes || askedFor || !mayLookAgain) { yield* plainAsReply(askAIStreamWithFallback(worldPromptHub(gate, notes), hubOpts), HUB_SENTENCES); return; }
    // The notes may miss it: the model may ask for one more search in its own words, once.
    const first = await peekSearch(askAIStreamWithFallback(worldPromptHub(gate, notes, true), hubOpts));
    if (!first.query) {
      // Wikipedia is a snapshot. When the model answers its notes with "I don't know", it has said it
      // does not know: look on the web with the turn's own search words and ask once more.
      const said = notesFrom === 'wikipedia' && webLookupOn(context.device_id) ? await peekDecline(first.stream) : null;
      if (!said?.declined) { yield* plainAsReply(said ? said.stream : first.stream, HUB_SENTENCES); return; }
      const t1 = Date.now();
      const web = await lookupNotes(searchWords(), { engine: webLookupEngine(), deadlineMs: WEB_LOOKUP_MS, talk: String(context.device_id || '') }).catch(() => null);
      console.log(`[routeStream] Wikipedia did not hold it, so the web: ${web ? web.notes.length : 0} lines in ${Date.now() - t1} ms`);
      if (!web?.notes?.length) { yield* plainAsReply(said.stream, HUB_SENTENCES); return; }
      await said.close();
      notesFrom = '';
      yield* plainAsReply(askAIStreamWithFallback(worldPromptHub(gate, web.notes), hubOpts), HUB_SENTENCES);
      return;
    }
    const t0 = Date.now();
    const more = await lookupNotes(first.query, { engine: webLookupEngine(), deadlineMs: WEB_LOOKUP_MS, talk: String(context.device_id || '') }).catch(() => null);
    console.log(`[routeStream] the hub model searched again for "${first.query}": ${more ? more.notes.length : 0} lines in ${Date.now() - t0} ms`);
    if (more?.notes?.length) notesFrom = '';
    yield* plainAsReply(askAIStreamWithFallback(worldPromptHub(gate, more?.notes?.length ? more.notes : notes), hubOpts), HUB_SENTENCES);
  }
  // Every other line handed up: the hub model when voice_hub_paths says so, else the cloud model.
  // voice_hub_paths_model: another hub model for these lines (same values as voice_world_model). They are
  // answered from what the prompt holds, not from the model's own knowledge, so the faster reader can take them.
  const hubBig = hubPathsOn(context.device_id) ? (worldModel(context.device_id, 'voice_hub_paths_model') || worldModel(context.device_id)) : '';
  const bigName = hubBig || 'the cloud model';
  // The background line (what he is doing right now) changes by the minute and no hub rule uses it.
  // For SELF the extra line (his name) goes in front of his own line, so his question is read last.
  const hubParts = (prompt, kind, extra) => {
    const mid = hubMiddle(prompt).filter((part) => part !== situationLine);
    if (kind === 'SELF' && extra && mid.length) mid.splice(mid.length - 1, 0, extra); else mid.push(extra);
    return mid;
  };
  const bigAsk = (prompt, kind, extra = '') => hubBig
    ? plainAsReply(askAIStreamWithFallback(hubPrompt(kind, hubParts(prompt, kind, extra), hubSelf()), { ...streamOpts, chain: [hubBig, ...cloudFirst()].slice(0, 3), firstTokenMs: WORLD_LOCAL_MS, temperature: HUB_TEMPERATURE }), HUB_SENTENCES)
    : askAIStreamWithFallback(prompt, cloudOpts());
  // The situation goes first, as background: placed next to his line it pulled "How's it
  // going?" into room talk (hub bench, 2026-11-11, and 2026-11-03).
  const studentPrompt = [situationForStudent ? situationLine : '', studentHistory, String(memoryContext || '').trim(), selfAsked ? buildSelfLine({ viaLink: context.via_link, deviceId: context.device_id }) : '', nowLine(),
    `${isDash ? 'User typed' : 'Mic heard'}: "${clipToTokens(safeText, HEARD_TOKENS)}"`].filter(Boolean).join('\n\n');
  const streamOpts = { callerClass: 'voice', caller: 'router', maxTokens: 300, _skipAnonymize: true, source: context.source, device_id: context.device_id, signal: context.signal || null, readerOpts: { minPan: forcePan ? 0 : talking ? MIN_PAN_IN_TALK : undefined, copy: ASKS_BACK.test(String(text)), probe: readerProbe, ...(claudeQuiet ? { needPan: CLAUDE_QUIET_MIN_PAN } : {}), ...(/-bench$/.test(String(context.device_id || '')) ? { whoMs: 30_000 } : {}) } };
  // A bench turn arrives cold (nothing read ahead): give the reader the time it needs, so the bench
  // measures the reader's own decision and not the backup's (2026-11-12, see voice-reader.js whoMs).
  const studentOpts = { ...streamOpts, chain: studentChain(studentModel, studentBackup), watchFirstToken: !!studentBackup,
    firstTokenMs: /-bench$/.test(String(context.device_id || '')) ? 30_000 : 1500 };
  // Interpreting goes to the hub's own translator (translate-local.js) first, unless the line comes
  // out in an INTERPRET_CLOUD_FIRST language or nobody can tell its language (outLang null). Those
  // go to the cloud models while one starts within INTERPRET_FIRST_TOKEN_MS, else to the hub's
  // translator. Never the local chat model: gemma4:e2b garbled Greek, and a stalled free-tier
  // model held turns 7-81 s (2026-11-03).
  async function* interpretStream(prompt, local, outLang) {
    const chain = cloud();
    // With no translator on the hub, the cloud gets its usual time: cutting it short would only
    // turn a slow answer into none.
    if (!(await translatorUp())) { yield* askAIStreamWithFallback(prompt, { ...streamOpts, chain }); return; }
    if (outLang && (!INTERPRET_CLOUD_FIRST.has(outLang) || pairInstalled('en', outLang))) {
      const t0 = Date.now();
      const out = await local();
      if (out) {
        console.log(`[interpreting] hub translator first ${Date.now() - t0}ms (into ${outLang})`);
        yield JSON.stringify({ intent: 'translate', addressed: 0.9, response: out });
        return;
      }
      // The translator failed or does not know the language: the cloud, with its usual time.
      yield* askAIStreamWithFallback(prompt, { ...streamOpts, chain });
      return;
    }
    const skipCloud = Date.now() < _interpretCloud.pausedUntil;
    if (!skipCloud) {
      let any = false;
      try {
        for await (const c of askAIStreamWithFallback(prompt, { ...streamOpts, chain, firstTokenMs: INTERPRET_FIRST_TOKEN_MS })) { any = true; yield c; }
        _interpretCloud.fails = 0;
        return;
      } catch (e) {
        if (any || context.signal?.aborted) throw e;
        if (++_interpretCloud.fails >= INTERPRET_CLOUD_TRIES) _interpretCloud.pausedUntil = Date.now() + INTERPRET_CLOUD_PAUSE_MS;
        const paused = Date.now() < _interpretCloud.pausedUntil ? `, skipping it for ${INTERPRET_CLOUD_PAUSE_MS / 60_000} min` : '';
        console.log(`[interpreting] cloud gave nothing (${String(e?.message || e).slice(0, 80)})${paused}; hub translator`);
      }
    }
    const t0 = Date.now();
    const out = await local();
    if (out) {
      console.log(`[interpreting] hub translator ${Date.now() - t0}ms${skipCloud ? ' (cloud paused)' : ''}`);
      yield JSON.stringify({ intent: 'translate', addressed: 0.9, response: out });
      return;
    }
    // The hub's translator is not running or does not know the language: the cloud after all, if
    // it was skipped, with its usual time.
    if (skipCloud) { yield* askAIStreamWithFallback(prompt, { ...streamOpts, chain }); return; }
    throw new Error('interpreting: no translation from the cloud or the hub');
  }
  // The same line for the hub's translator: which way, from what language, and "ask them X"
  // as said to them.
  const localInterpretation = async () => {
    const lang = targetLang?.code;
    if (!lang) return null;
    const t = String(text || '');
    if (standing.setting) {
      const m = t.match(/\b(?:ask|tell) (?:them|her|him|the \w+)\b[^.!?]*/i);
      const direct = m ? toDirectSpeech(m[0]) : null;
      return direct ? translateLocal(direct, 'en', lang) : interpretAck(targetLang.name);
    }
    if (way === 'to_english' || way === 'either') {
      const s = scriptLang(t);
      const src = heardLang && heardLang !== 'en' ? heardLang : (s === 'zh' && (lang === 'ja' || lang === 'yue') ? lang : s) || lang;
      return translateLocal(t, src, 'en');
    }
    return translateLocal(toDirectSpeech(t) || t, 'en', lang);
  };
  const localOneOff = async () => {
    const t = String(text || '');
    const m = t.match(/\bhow (?:do|would|can) (?:you|i|we) say\s+(.+?)\s+(?:in|into)\s+\w+/i)
      || t.match(/\b(?:translate|say)\s+(.+?)\s+(?:in|into|to)\s+\w+/i);
    let phrase = m ? m[1].replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim() : '';
    if (!phrase || /^(?:that|it|this)$/i.test(phrase)) phrase = lastUserLine(context.conversation_history) || '';
    if (!phrase) return null;
    return translateLocal(toDirectSpeech(phrase) || phrase, scriptLang(phrase) || 'en', oneOffLang.code);
  };
  // The language this line comes out in, the way localInterpretation sends it. null leaves it to the
  // cloud model first: the line that sets interpreting up (it may carry words for the other person
  // in any shape) and a line nobody can tell the language of ('either').
  const interpretOut = () => standing.setting ? null
    : way === 'from_english' ? targetLang?.code || null
    : way === 'to_english' ? 'en' : null;
  async function* voiceStream() {
    if (standing && interpreting) { yield* interpretStream(standingPrompt, localInterpretation, interpretOut()); return; }
    if (standing) { yield* askAIStreamWithFallback(standingPrompt, streamOpts); return; }
    // Which path answered, for the nightly voice report (voice-report.js).
    const notePath = (p) => { try { recordTiming({ turn: context.turn_id, device: context.device_id, stage: 'path', path: p }); } catch {} };
    // A timer or alarm rings on one of his devices (ringing.js, reported on each device's ask for
    // notes). Only then, one yes or no to the hub model first: does he want it stopped? A yes sends
    // the stop to every device of his that rings; a no, or no answer, goes on as any other turn.
    // Asked to turn a ringing timer off, PAN said it could not search for that (Nov 21).
    const ringNow = claudeQuiet ? [] : ringing.ringingFor(1);
    if (ringNow.length) {
      let ans = '';
      const t0 = Date.now();
      try {
        const chain = [hubBig || worldModel(context.device_id), ...cloudFirst()].filter(Boolean).slice(0, 3);
        for await (const c of askAIStreamWithFallback(ringQuestion(ringNow, safeText, historyBlock), { ...streamOpts, chain, maxTokens: 4, temperature: 0 })) ans += c;
      } catch (e) { console.warn(`[routeStream] ringing question failed: ${e.message}`); }
      console.log(`[routeStream] ringing on ${ringNow.map((r) => r.name || r.key).join(', ')}: stop? ${JSON.stringify(ans.slice(0, 40))} in ${Date.now() - t0} ms`);
      if (wantsStop(ans)) {
        if (!isTestTurn(context)) ringing.stopFor(1);
        notePath('ring');
        yield JSON.stringify({ intent: 'device', addressed: 0.9, action: 'stop_ringing', response: stoppedWords(ringNow) });
        return;
      }
    }
    if (translatePrompt && !claudeQuiet) { notePath('translate'); yield* interpretStream(translatePrompt, localOneOff, oneOffLang?.code || null); return; }
    // A problem he laid out over pauses (laying-out.js): Claude works it out, on his own Claude
    // login through the hub's Claude terminal (the sdk provider, claude -p), the owner Nov 26. Only
    // the problem goes, names anonymized (anonymizeForAI), no memory and no talk. The local voice
    // model got 4 of 5 laid-out problems wrong on the layout bench. Falls back to the usual chain.
    if (laidOut && !claudeQuiet) {
      console.log(`[routeStream] a problem laid out over ${laidOut + 1} lines - ${smartModel()} works it out, not ${studentModel || 'the voice model'}`);
      notePath('problem');
      const problemPrompt = [
        `Today is ${new Date().toDateString()}.`,
        `He laid out a problem out loud, over several pauses, then asked. His words, in order: "${safeText}"`,
        'Work it out carefully. Then answer the way you would say it out loud to him: the answer first, in one to three short sentences, with the numbers he needs. No markdown, no lists, no working shown.',
      ].join('\n\n');
      yield* plainAsReply(askAIStreamWithFallback(problemPrompt, { ...streamOpts, _skipAnonymize: false, maxTokens: 400, timeout: 60_000,
        chain: [smartModel(), ...cloudFirst()].slice(0, 3), firstTokenMs: 60_000 }), 4);
      return;
    }
    // Where his projects stand (projects.js, task 1097): "who's waiting on me" is said from the notes
    // by code; a question naming someone or something in the notes, or close in meaning to one of
    // their questions, goes to the smart model with the notes. The live hub got 0 of 20 of these
    // right and made two up (Nov 27); Claude from the notes 19 of 20.
    if (!standing) {
      let proj = null;
      try { proj = await projectTurn(text); } catch (e) { console.warn('[routeStream] projects:', e.message); }
      if (proj?.say) {
        console.log(`[routeStream] project list (${proj.why}) from the notes, no model`);
        notePath('project_list');
        yield JSON.stringify({ intent: 'query', addressed: 0.9, response: proj.say });
        return;
      }
      if (proj?.ask && !claudeQuiet) {
        // Whole, not streamed: a name in the notes can come up in an everyday question ("the weather in
        // the Northwest"), and the model then says NOT_PROJECT and the turn goes on as usual.
        const t0 = Date.now();
        let raw = '';
        try { raw = await askAIWithFallback(proj.ask, { ...streamOpts, _skipAnonymize: true, maxTokens: 300, timeout: 30_000, caller: 'projects-answer',
          chain: [...new Set([projectAnswerModel(), smartModel()])] }); } catch (e) { console.warn(`[routeStream] project answer failed: ${e.message}`); }
        const said = projectReply(raw);
        console.log(`[routeStream] project question (${proj.why}) - ${projectAnswerModel()} ${said ? 'answered' : 'says not a project one'} in ${Date.now() - t0} ms`);
        if (said) { notePath('project'); yield JSON.stringify({ intent: 'query', addressed: 0.9, response: said }); return; }
      }
    }
    if (wordSearch && !claudeQuiet) { notePath('search'); yield* bigAsk(wordSearchPrompt, 'WORD', `He stopped mid-sentence: "${safeText}"`); return; }
    if (toolPrompt && !claudeQuiet) {
      console.log(`[routeStream] live data (${weatherBlock.length} chars) - short prompt instead of ${studentModel}`);
      notePath('tool');
      // The block holds sums already done, with the words to say. The reply is read whole before
      // any of it is spoken: when it gives a figure that is not the worked out one, the code's own
      // sentence is said instead (sums.js keepFigures). A short reply, so the wait is small.
      const loud = outLoud(weatherBlock);
      if (!loud.length) { yield* bigAsk(toolPrompt, 'DATA'); return; }
      let whole = '';
      for await (const c of bigAsk(toolPrompt, 'DATA')) whole += c;
      const kept = keepFigures(whole, loud);
      if (kept.changed) console.log(`[routeStream] the reply changed a worked out figure - saying the code's sentence (model said: ${whole.slice(0, 160)})`);
      yield kept.text;
      return;
    }
    if (selfPrompt && !claudeQuiet) { notePath('self'); yield* bigAsk(selfPrompt, 'SELF', hubOwnerLine()); return; }
    if (rereadPrompt && !claudeQuiet) {
      console.log(`[routeStream] ${lost ? 'he is lost with the last answers' : 'asked about this talk'} - ${bigName} rereads it, not ${studentModel}`);
      notePath('reread');
      yield* bigAsk(rereadPrompt, aboutTalk && !lost ? 'ABOUT_TALK' : 'LOST');
      return;
    }
    if (kindPrompt && !claudeQuiet) {
      console.log(`[routeStream] about his own chances - kind prompt instead of ${studentModel}`);
      notePath('kind');
      yield* bigAsk(kindPrompt, 'KIND');
      return;
    }
    if (worldQ && talking && !claudeQuiet) {
      console.log(`[routeStream] a question about the world, in the talk - ${worldHub || 'the bigger model'} answers, not ${studentModel}`);
      notePath('world');
      yield* worldAsk(true);
      return;
    }
    if (studentModel) {
      // Where a turn's time goes, before and after the model: setup is everything above
      // (prompt blocks, memory), first is the model's first chunk.
      console.log(`[routeStream] timing setup=${Date.now() - _turnStart}ms student_prompt=${studentPrompt.length} chars situation=${situationForStudent ? situationLine.length : 'off'}`);
      if (String(context.device_id || '').endsWith('-bench') && situationLine) console.log(`[routeStream] situation: ${situationLine}`);
      recordTiming({ turn: context.turn_id, device: context.device_id, stage: 'setup', ms: Date.now() - _turnStart, prompt_chars: studentPrompt.length, model: studentModel });
      const _modelStart = Date.now();
      let _firstLogged = false;
      let got = false;
      let head = '';        // held until the reply's first characters show whether it is [CAMERA]
      let camera = false;
      let think = false;    // [THINK]: the voice model hands this one to the bigger model (round 16)
      let world = false;    // a question about the world (worldQ): the bigger model answers it
      try {
        for await (const c of askAIStreamWithFallback(studentPrompt, studentOpts)) {
          got = true;
          // The voice model never decided (it missed its deadline and a backup answered): while
          // he dictates to Claude, nothing else gets to talk over him.
          if (claudeQuiet && readerProbe.pPan === undefined) {
            console.log('[routeStream] dictating to Claude and the voice model did not decide: staying quiet');
            notePath('claude_quiet');
            yield JSON.stringify({ intent: 'ambient', addressed: 0.05, response: '[AMBIENT]', reason: 'dictating' });
            return;
          }
          if (!_firstLogged) {
            _firstLogged = true;
            console.log(`[routeStream] timing first_chunk=${Date.now() - _modelStart}ms`);
            recordTiming({ turn: context.turn_id, device: context.device_id, stage: 'first_chunk', ms: Date.now() - _modelStart });
          }
          if (head === null) { yield c; continue; }
          head += c;
          const r = head.match(/"response"\s*:\s*"([\s\S]*)/)?.[1] || '';
          // Three characters tell [CAMERA] from [AMBIENT]; any other reply is released at once.
          if (!r || (r.startsWith('[') && r.length < 3)) continue;
          if (r.startsWith('[CA')) { camera = true; break; }
          if (r.startsWith('[TH')) { think = true; break; }
          // [MUTE]: he told PAN itself to go quiet, in any language; the voice model decides, not a
          // phrase list (round 23, the owner, Nov 21). The device mutes; nothing is said.
          if (r.startsWith('[MU')) { readerMuted = true; break; }
          if (worldQ && !r.startsWith('[') && /^(?:query|question|chat|)$/.test(head.match(/"intent"\s*:\s*"([^"]*)"/)?.[1] || '')) { world = true; break; }
          // voice_reader_alone: the voice model keeps only short talk and its own actions; every
          // other line goes to the hub model the [THINK] way (reader-alone.js, Nov 21).
          if (!r.startsWith('[') && readerAloneOn(context.device_id) && !readerMayAnswer(text, head.match(/"intent"\s*:\s*"([^"]*)"/)?.[1])) { think = true; break; }
          yield head;
          head = null;
        }
        if (readerMuted) {
          console.log(`[routeStream] ${studentModel} says he told PAN to go quiet ([MUTE])`);
          notePath('mute');
          return;
        }
        if (world) {
          console.log(`[routeStream] a question about the world - ${worldHub || 'the bigger model'} answers, not ${studentModel} (first_chunk was ${Date.now() - _modelStart}ms)`);
          notePath('world');
          yield* worldAsk(false);
          return;
        }
        if (think) {
          // A question that needs real thought (an opinion with reasons, a prediction, why or how,
          // advice, a big question) or "you didn't answer me". The 2B model dodged these ("I still
          // can't tell you", "You did.", Nov 14); it now says so and the bigger model answers with
          // the whole conversation. Its first word comes about 1 s later than the voice model's.
          console.log(`[routeStream] ${studentModel} handed this one to ${bigName} ([THINK])`);
          notePath('think');
          yield* bigAsk([
            'You are PAN, his voice assistant and a friend in the room. Reply ONLY as JSON: {"intent":"query","addressed":0.9,"response":"..."}',
            historyBlock.trim(), buildSelfLine({ viaLink: context.via_link, deviceId: context.device_id }), nowLine(), situationLine, shelf.block,
            `${isDash ? 'User typed' : 'Mic heard'}: "${safeText}"`,
            'This one needs real thought. Answer it the way a smart friend would out loud: a real view and the reason for it, in two or three short spoken sentences, talking to him as "you". If he says you did not answer him, answer his last real question from the conversation now. Never dodge: no "I can\'t tell you", no "who\'s asking", no "I already did".',
          ].filter(Boolean).join('\n\n'), 'THINK');
          return;
        }
        if (!camera) {
          notePath('reader');
          if (head) yield head;
          return;
        }
        if (looksVisual(text)) {
          if (context.canCamera) { notePath('camera'); cameraAsk = true; return; }
          // Nothing to look with, so that is the answer. Asked twice and then sent to the full
          // prompt, this was 15-17 s of silence (conversation test, 2026-11-05).
          yield JSON.stringify({ intent: 'query', addressed: 0.9, response: "I can't see it, my camera's off." });
          return;
        }
        // A [CAMERA] on a line that needs no look ("should I bring a jacket if it is
        // windy", "is it better to water plants in the morning") used to drop straight
        // to the full prompt: 34-36 s of silence on the hub CPU (voicebench,
        // 2026-11-02). Ask OmniΠ once more with the camera ruled out; a second [CAMERA]
        // goes to the cloud model on a short prompt, which has no camera to ask for.
        console.log(`[routeStream] ${studentModel} asked for the camera - asking again without it`);
        let head2 = '';
        let camera2 = false;
        for await (const c of askAIStreamWithFallback(`${studentPrompt}\n\n(No camera for this one: answer from his words alone.)`, studentOpts)) {
          if (head2 === null) { yield c; continue; }
          head2 += c;
          const r = head2.match(/"response"\s*:\s*"([\s\S]*)/)?.[1] || '';
          if (!r || (r.startsWith('[') && r.length < 3)) continue;
          if (r.startsWith('[CA')) { camera2 = true; break; }
          yield head2;
          head2 = null;
        }
        if (!camera2) {
          notePath('reader_retry');
          if (head2) yield head2;
          return;
        }
        console.log(`[routeStream] ${studentModel} asked for the camera twice - short prompt instead`);
        notePath('camera_short');
        yield* bigAsk([
          'You are PAN, his voice assistant and a friend in the room. Reply ONLY as JSON: {"intent":"query","addressed":0.9,"response":"..."}',
          historyBlock.trim(), nowLine(), situationLine,
          `${isDash ? 'User typed' : 'Mic heard'}: "${safeText}"`,
          'Answer from his words alone, in one or two short spoken sentences. If he was not talking to you, reply {"intent":"ambient","addressed":0.1,"response":"[AMBIENT]"}.',
        ].filter(Boolean).join('\n\n'), 'WORDS_ALONE');
        return;
      } catch (e) {
        if (got && head === null) throw e;
        // Cancelled (he said something new, or the phone hung up) is not a voice model failure: stop here.
        // It used to go on to the full prompt, which was cancelled too, and the turn ended on "Sorry, I ran
        // into a problem thinking that through" spoken at him (car, 2026-11-17).
        if (context.signal?.aborted) throw e;
        console.warn(`[routeStream] ${studentModel} unavailable (${e.message}) - full prompt instead`);
        notePath('reader_failed');
      }
    }
    // The voice model did not answer: the cloud model first (about 1 s), not gemma4:e2b reading the
    // full prompt on the hub CPU (ai_fallback_chain_voice starts with it; 13 to 20 s, Nov 14).
    notePath(studentModel ? 'cloud_fallback' : 'full');
    yield* askAIStreamWithFallback(fullPrompt(), studentModel ? { ...streamOpts, chain: [...cloud(), ...readChain('voice').filter(isLocal)] } : streamOpts);
  }

  if (wordSearch && interject === 'off') {
    // He does not want help finding words: say nothing, and the phone joins the rest of his
    // sentence onto this piece (carry_on) because PAN never started talking.
    yield { type: 'chunk', text: '' };
    yield { type: 'done', result: withProsody({ intent: 'ambient', response: '', addressed: 0.1, importance: 0.1, reason: 'still_talking' }) };
    return;
  }

  let fullBuf = '';
  // lastLen is what has actually been SPOKEN; held is what has been extracted.
  // They used to be the same number - the gate is the reason they are not.
  let lastLen = 0;
  let held = '';
  let gate = null;      // null = undecided, so early words are buffered not spoken
  let sawEnd = false;   // response string closed; keep reading for the tail
  let addressed = null;
  let spokenReply = null; // the reply minus a dropped trailing question, when one was dropped
  let personAsked = false; // the line was looked at once as a call or message for a person, after the gate
  let readerMuted = false; // the voice model answered [MUTE] (voiceStream)

  // A cloud stream can die after it starts ("Failed to parse stream", 2026-11-05). With nothing
  // spoken yet there is no sequence to corrupt, so the student answers, not "Sorry, I ran into a
  // problem".
  async function* replyStream() {
    try {
      yield* voiceStream();
    } catch (e) {
      if (lastLen > 0 || !studentModel || context.signal?.aborted) throw e;
      console.warn(`[routeStream] reply failed before a word was spoken (${e.message}) - student instead`);
      fullBuf = '';
      held = '';
      gate = null;
      sawEnd = false;
      addressed = null;
      yield* askAIStreamWithFallback(studentPrompt, studentOpts);
    }
  }

  try {
    // #996: streaming fallback wrapper. Connect-time failures cascade through
    // the chain (ai_fallback_chain_*); mid-stream failures propagate as
    // truncation (no mid-stream switching — would corrupt the chunk sequence).
    // The language an interpreted reply is in, when the direction is known. The device picked its
    // voice's language from the letters of the line, so a language in Latin letters went to the
    // voice as English (the car, 2026-11-18: Vietnamese). App 0.5.13 on; older apps ignore it.
    if (standing && interpreting) {
      const out = interpretOut();
      if (out) yield { type: 'line_lang', lang: out };
    }
    for await (const chunk of replyStream()) {
      fullBuf += chunk;
      if (gate === null) {
        const d = readAddressGate(fullBuf);
        if (d) { gate = d.gate; addressed = d.addressed; }
        // The voice model says the line is for PAN, and the line is a call or a message for a
        // person here said without PAN's name ("Call Maria"). The check before the model only
        // runs on a line that names PAN or comes right after PAN spoke, so this one went to
        // the model, which answered "Got it. Calling Maria." and called nobody: the owner had
        // to say it twice (2026-11-19). Now that the model has said who the line is for, the
        // hub does what was asked and the model's own words are dropped, unspoken.
        if (gate === 'open' && lastLen === 0 && !personAsked && !(saysPanName(text) || talking)) {
          personAsked = true;
          const msg = await messageToPerson(text, context, { addressed: true });
          if (msg) {
            console.log(`[routeStream] for a person, said without PAN's name: ${msg.intent}`);
            try { recordTiming({ turn: context.turn_id, device: context.device_id, stage: 'path', path: 'person_after_gate' }); } catch {}
            insertRouterEvent(text, msg.intent, msg.response, context);
            if (msg.response) yield { type: 'chunk', text: msg.response };
            yield { type: 'done', result: withProsody(msg) };
            return;
          }
        }
      }
      const { text: extracted, done } = extractResponseField(fullBuf);
      // Keep the text even while muted: the looksDirectedAtPan veto below can
      // still overrule the model, and it needs something to say.
      if (extracted.length > held.length) held = extracted;
      // A word already out of the speaker cannot be taken back; a held one
      // costs nothing. So nothing is emitted until the gate opens.
      // A bracketed placeholder ([AMBIENT], OmniΠ's [CAMERA]) is never spoken.
      if (gate === 'open' && held.length > lastLen && !held.startsWith('[')) {
        // lastLen still advances by the RAW length, so the stream position stays
        // correct; only what gets spoken is filtered.
        const end = releasableEnd(held);
        if (end > lastLen) {
          const delta = speakable(held.slice(lastLen, end));
          lastLen = end;
          if (delta) yield { type: 'chunk', text: delta };
        }
      }
      // Stop at the closing BRACE, not at the closing quote and not at the
      // model's own stop token.
      //
      // Breaking at the quote (the original) truncated fullBuf before the
      // object closed, so JSON.parse failed on EVERY turn and every done event
      // carried the "I didn't catch that" fallback while the chunks carried a
      // perfectly good answer. Nobody noticed because the phone speaks chunks.
      //
      // Not breaking at all (the first fix) parsed correctly but kept the turn
      // generating to the model's own stop. On a single local GPU that holds
      // the slot open, and everything else - voice, intuition - queues behind
      // it. Waiting for the brace gets valid JSON AND gives the slot back.
      //
      // The scan only runs once the reply has closed, so it is a few hundred
      // characters, once per turn.
      if (done) {
        sawEnd = true;
        if (topLevelJsonEnd(fullBuf) > 0) break;
      }
    }
    if (readerMuted) {
      insertRouterEvent(text, 'system', '', context);
      yield { type: 'done', result: withProsody({ intent: 'system', mute: true, response: '', addressed: 0.95, importance: 0.3 }) };
      return;
    }
    if (fullBuf) _lastVoiceAlertAt = 0; // stream produced output — backends healthy, re-arm
    // The head of the raw output is the only place that shows whether the
    // model is emitting the fields it was asked for. Cheap, and it is what
    // was missing while the done event silently fell back for months.
    console.log(`[routeStream] raw head: ${String(fullBuf).slice(0, 120).split(String.fromCharCode(10)).join(' ')}${sawEnd ? '' : ' [NO-END]'}`);
    // A reply that carries JSON punctuation is about to be SPOKEN as '}{'. Log
    // the whole raw output when that happens - the head alone cannot show
    // whether the model wrote the braces inside the string or the extractor
    // ran past the closing quote.
    if (/[{}]/.test(held)) {
      console.warn(`[routeStream] BRACE-IN-REPLY held=${JSON.stringify(held.slice(0, 200))}`);
      console.warn(`[routeStream] BRACE-IN-REPLY raw=${JSON.stringify(String(fullBuf).slice(0, 600))}`);
    }
    if (gate === null) {
      // The model never emitted a parseable intent. That is broken output,
      // not ambient - speak what it said rather than swallowing the turn.
      console.warn('[routeStream] no intent in stream — gate defaulted open');
      gate = 'open';
    } else if (gate === 'open' && held.length > lastLen && !held.startsWith('[')) {
      // The stream is over, so what is still held is the reply's last sentence.
      // Answer-first OmniΠ writes intent after the reply, so it is read here.
      const cut = trailingQuestionCut(held, fullBuf.match(/"intent"\s*:\s*"([a-z_]+)"/)?.[1]);
      // Only if none of the question has gone out yet.
      const drop = cut >= 0 && !held.slice(cut, lastLen).trim();
      if (drop) {
        console.log(`[routeStream] dropped trailing question: ${JSON.stringify(held.slice(cut).trim().slice(0, 80))}`);
        spokenReply = held.slice(0, cut).trim();
      }
      const delta = speakable(held.slice(lastLen, drop ? Math.max(cut, lastLen) : held.length));
      lastLen = held.length;
      if (delta.trim()) yield { type: 'chunk', text: delta };
    }
  } catch (e) {
    // A cancelled turn says nothing: the caller ends it as "cancelled" (routes/api.js). No alert either.
    if (context.signal?.aborted) throw e;
    console.error('[routeStream] LLM error:', e.message);
    // Surface the broken voice path in the Alerts panel (de-duped, fire-and-forget).
    _raiseVoiceAlert(e.message, context.source);
    // Always yield a response — silence on the phone means the user thinks PAN is broken
    yield { type: 'done', result: withProsody({ intent: 'query', response: "Sorry, I ran into a problem thinking that through. Try again.", importance: 0.5 }) };
    return;
  }

  if (cameraAsk) {
    // Empty reply on purpose: the phone says its own "let me have a look", takes the photo
    // and answers from it (handleCameraCommand), the same path as "what is this".
    console.log(`[routeStream] camera: ${JSON.stringify(String(text).slice(0, 60))}`);
    yield { type: 'done', result: withProsody({ intent: 'query', addressed: 0.95, camera: true, response: '', importance: 0.5 }) };
    return;
  }

  // Parse the final JSON for intent + actions
  try {
    const jsonMatch = fullBuf.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (parsed) {
      // Veto a wrong 'ambient' on an utterance that is obviously a question
      // or a command. See looksDirectedAtPan for why this is not left to the model.
      // saysPanName too: looksDirectedAtPan knows English question words and "?" only, so "PAN
      // พรุ่งนี้อากาศเป็นยังไง" (Thai, no question mark) went unanswered 5 times of 6 (2026-11-12).
      if (parsed.intent === 'ambient' && (looksDirectedAtPan(text) || saysPanName(text))) {
        console.warn('[routeStream] ambient -> query override: ' + String(text).slice(0, 70));
        parsed.intent = 'query';
        // A question mark or a question word is a harder signal than the
        // model's own confidence, so it reopens the gate too. `held` was
        // kept through the mute for exactly this.
        gate = 'open';
        // But the reply was the ambient marker, so there was nothing to say: "Hey Pan, what
        // kind of horse is that?" got silence three times running (2026-11-03). Only when he
        // used its name, since a question on the TV ends in "?" too: look if it is about
        // something in view, else let the cloud model answer.
        const said = speakable(String(held || parsed.response || '')).trim();
        const named = saysPanName(text);
        // Also when it is his own voice and nobody else is in the talk (participation.js): no TV and
        // no other person to answer it (alone.js). A plain question about his own day got silence
        // while he was alone with PAN (Nov 21).
        const aloneNow = !named && alone.aloneWithPan(context, part);
        if ((!said || said.startsWith('[')) && (named || aloneNow)) {
          if (context.canCamera && looksVisual(text)) {
            console.log(`[routeStream] override -> camera: ${JSON.stringify(String(text).slice(0, 60))}`);
            yield { type: 'done', result: withProsody({ intent: 'query', addressed: 0.95, camera: true, response: '', importance: 0.5 }) };
            return;
          }
          const directPrompt = [
            'You are PAN, his voice assistant and a friend in the room. Reply ONLY as JSON: {"intent":"query","addressed":0.9,"response":"..."}',
            historyBlock.trim(), nowLine(), situationLine,
            `${isDash ? 'User typed' : 'Mic heard'}: "${safeText}"`,
            'He said your name, so he is talking to you: answer him briefly, the way you would say it out loud.',
          ].filter(Boolean).join('\n\n');
          let again = '';
          // Not named: the model may still decide it was not for PAN ([AMBIENT]).
          for await (const c of bigAsk(aloneNow ? directPrompt.replace('He said your name, so he is talking to you: answer him briefly, the way you would say it out loud.', 'Answer from his words alone, in one or two short spoken sentences. If he was not talking to you, reply {"intent":"ambient","addressed":0.1,"response":"[AMBIENT]"}.') : directPrompt, aloneNow ? 'WORDS_ALONE' : 'NAMED')) again += c;
          const r = (again.match(/"response"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] || '').replace(/\\"/g, '"').trim();
          console.log(`[routeStream] override re-asked the cloud model: ${JSON.stringify(r.slice(0, 80))}`);
          if (r && !r.startsWith('[')) parsed.response = r;
        }
      } else if ((parsed.intent === 'ambient' || gate === 'mute') && !context.unfinished && !isDash
        // With the hub model only a line plainly told to PAN: asked about "Yeah I told him we would call
        // back on Tuesday", phi4-mini answered it where the cloud model said [AMBIENT] (Nov 16).
        && (tellsPan(text) || (!hubBig && talking && String(text).trim().split(/\s+/).length <= 15))
        && overheardWithin(90_000, context.org_id) < 2) {
        // He told PAN something (tellsPan), or reacted right after PAN spoke ("that had
        // nothing to do with the camera" got silence, 2026-11-03), and nobody else seems to
        // be talking. A friend answers that, so the cloud model does, as a hold: spoken if he
        // stops there, dropped if he carries on talking (the phone's hold_ms).
        const tellPrompt = [
          'You are PAN, his voice assistant and a friend in the room. Reply ONLY as JSON: {"intent":"query","addressed":0.9,"response":"..."}',
          historyBlock.trim(), nowLine(), situationLine,
          `Mic heard: "${safeText}"`,
          'He told you this without asking anything, or reacted to what you last said. Answer the way a friend in the room would: one short spoken sentence that fits (sympathy, a light comment, or a quick useful tip; for a fact to remember, a brief acknowledgement). No question unless it is the natural reply, never an offer or a menu. If it plainly was not said to you (he is talking to someone else, reading something out, or dictating), reply {"intent":"ambient","addressed":0.1,"response":"[AMBIENT]"}.',
        ].filter(Boolean).join('\n\n');
        let again = '';
        try {
          for await (const c of bigAsk(tellPrompt, 'TOLD')) again += c;
        } catch (e) { console.warn(`[routeStream] statement re-ask failed: ${e.message}`); }
        const r = (again.match(/"response"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] || '').replace(/\\"/g, '"').trim();
        console.log(`[routeStream] statement to PAN, re-asked the cloud model: ${JSON.stringify(r.slice(0, 80))}`);
        if (r && !r.startsWith('[')) {
          const c = trailingQuestionCut(r, 'query');
          const reply = speakable(c >= 0 ? r.slice(0, c) : r).trim();
          if (reply) {
            yield { type: 'done', result: withProsody({ ...parsed, intent: 'query', response: reply, addressed: 0.5, hold_ms: ADDRESSED_HOLD_MS, importance: 0.3 }) };
            return;
          }
        }
      }
      // If Claude classified this as a memory recall, execute the real DB search —
      // routeStream doesn't call processUnifiedResult so we must do it here.
      // Use searchMemory (FTS5 + vector) — NOT a raw LIKE query against memory_items,
      // which misses conversations/events and chokes on stop words.
      if (parsed.intent === 'memory' && (parsed.action === 'recall' || parsed.action === 'list')) {
        const searchTerm = parsed.content || text;

        // A DATE QUESTION IS NOT A RELEVANCE QUESTION.
        //
        // "what did I work on yesterday" shares no word with yesterday's events,
        // and no vector encodes a calendar day, so both halves of the hybrid
        // search returned unrelated rows - and the model, handed unrelated rows
        // labelled 'relevant conversation history', described the wrong day with
        // total confidence. When the question names a time, answer from that
        // day's actual record instead of searching.
        const when = parseWhen(text);
        // ANSWERED FROM THE TALK. Syrinx answers "what did I say the dog is called" from the
        // conversation it was shown, and the answer is out of the speaker before the intent
        // arrives (answer-first: the gate opens on "to"). Round 10 tags some of these as
        // memory, and the search below ignores the conversation: the turn stayed open 12-26 s
        // and kept "the provided messages do not contain an answer" as PAN's line (hub bench,
        // 2026-11-03). Nothing it finds is heard once the reply has streamed, so a reply already
        // out stands, whatever it came from. A named day still searches.
        const spoken = String(spokenReply ?? parsed.response ?? '').trim();
        if (lastLen > 0 && (!when || talkCovers(_subjectTerms(text), context.conversation_history))) {
          console.log(`[routeStream] recall already answered: ${JSON.stringify(spoken.slice(0, 80))}`);
          yield { type: 'done', result: withProsody({ ...parsed, addressed, response: spoken }) };
          return;
        }
        let hits = [];
        try {
          if (when) {
            hits = searchMemoryByDate({ from: when.from, to: when.to, limit: 25 });
            console.log(`[routeStream] recall scoped to ${when.label} (${when.from} .. ${when.to}) — ${hits.length} readable events`);
          } else {
            // VECTORS STAY ON for an explicit recall. FTS alone returns the hook
            // envelope ({"session_id":...}), the vector half returns what he actually
            // said. The scan has its own thread now, and he is waiting for this answer
            // out loud: what it has not found in 4 s, this turn does without.
            hits = await Promise.race([
              searchMemory(searchTerm, { limit: 10, caller: 'routeStream', vecTimeoutMs: 4000 }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('searchMemory timeout 8s')), 8000)),
            ]);
          }
        } catch (e) {
          hits = [];
          console.warn(`[routeStream] recall search bailed (${e.message}) — answering without memory`);
        }

        // Drop the hook envelope. These are the majority of FTS hits and they are
        // not history; passing them to the model as history is what it invents from.
        const before = hits.length;
        hits = hits.filter((h) => isReadablePreview(h.preview));
        if (before !== hits.length) console.log(`[routeStream] recall: dropped ${before - hits.length} unreadable hit(s), ${hits.length} left`);

        let recallResponse;
        if (hits.length === 0) {
          // SAY SO. Nothing retrieved must never become a guess - that is the
          // failure being fixed here, not a tidy-up.
          recallResponse = when
            ? `I don't have anything recorded from ${when.label}.`
            : `I don't have anything saved about that.`;
        } else {
          const snippets = hits.map((h, i) => `[${i + 1}] ${(h.event && h.event.created_at ? h.event.created_at.slice(0, 16) + ' — ' : '')}${h.preview}`).join('\n');
          const scope = when ? `These are his own notes from ${when.label}.` : 'These are his own past messages.';
          const synthesisPrompt = `The user asked: "${text}"`
            + `\n\n${scope}\n${snippets}`
            + `\n\nAnswer in 1-3 sentences using ONLY what is above. Be direct and conversational, and do not list sources.`
            + `\nIf what is above does not actually answer the question, say plainly that you do not have it. Never guess or fill the gap.`;
          try {
            const synthesized = await claude(synthesisPrompt, { caller: 'recall-synthesis', model: getConfiguredModel?.() || 'claude-haiku-4-5', maxTokens: 220, timeout: 15000, source: context.source, device_id: context.device_id });
            recallResponse = synthesized?.trim() || hits[0].preview;
          } catch {
            recallResponse = hits[0].preview;
          }
        }
        // Emit the recall response text as a chunk so TTS picks it up
        if (lastLen === 0) yield { type: 'chunk', text: speakable(recallResponse) };
        yield { type: 'done', result: withProsody({ ...parsed, response: recallResponse }) };
        return;
      }
      // THREE outcomes, not two. `gate` was decided from `addressed` while the
      // reply was still being written, so by here it is only being acted on.
      if (gate === 'mute') {
        // Confidently not for us. Empty chunk keeps the phone from speaking
        // the "[AMBIENT]" literal.
        yield { type: 'chunk', text: '' };
        yield { type: 'done', result: withProsody({ ...parsed, intent: 'ambient', response: '', addressed, importance: 0.1, reason: parsed.reason || (claudeQuiet ? 'dictating' : 'not_addressed') }) };
        return;
      }
      if (gate === 'hold') {
        // The middle band, and the whole point of the number. Not sure enough
        // to talk over him, not sure enough to swallow a real question. Hand
        // the phone the words plus how long to sit on them: it speaks if the
        // room goes quiet and drops them if he carries on talking.
        // Same filter as the streamed path - this text is spoken too.
        let heldText = speakable(String(held || parsed.response || '')).trim();
        const heldCut = trailingQuestionCut(heldText, parsed.intent);
        if (heldCut >= 0) heldText = heldText.slice(0, heldCut).trim();
        // A hold is only worth anything if there is something to say. When the
        // model decided ambient it writes the "[AMBIENT]" placeholder, and
        // holding a placeholder just delays silence - so treat that as a mute.
        if (!heldText || /^\[ambient\]$/i.test(heldText)) {
          yield { type: 'chunk', text: '' };
          yield { type: 'done', result: withProsody({ ...parsed, intent: 'ambient', response: '', addressed, importance: 0.1, reason: parsed.reason || (claudeQuiet ? 'dictating' : 'not_addressed') }) };
          return;
        }
        console.log(`[routeStream] addressed=${addressed} — holding ${heldText.length} chars for ${ADDRESSED_HOLD_MS}ms`);
        yield { type: 'done', result: withProsody({ ...parsed, response: heldText, addressed, hold_ms: ADDRESSED_HOLD_MS, importance: 0.3 }) };
        return;
      }

      // The phone keeps this as PAN's line in the history, so it is what was actually said.
      let reply = spokenReply ?? (parsed.response || (lastLen > 0 ? fullBuf.slice(fullBuf.indexOf('"response":"') + 12).split('"')[0] : ''));
      if (spokenReply === null && lastLen === 0) {
        // Nothing streamed (the ambient veto reopened the gate): the phone speaks this text.
        const c = trailingQuestionCut(reply, parsed.intent);
        if (c >= 0) reply = reply.slice(0, c).trim();
      }
      if (reply.startsWith('[')) reply = '';   // a placeholder is never spoken
      yield { type: 'done', result: withProsody({ ...parsed, addressed, response: reply }) };
    } else {
      yield { type: 'done', result: withProsody({ intent: 'query', response: "I didn't catch that — could you try again?", importance: 0.4 }) };
    }
  } catch {
    yield { type: 'done', result: withProsody({ intent: 'query', response: "I didn't catch that — could you try again?", importance: 0.4 }) };
  }
}

export { route, classifyIntent };
