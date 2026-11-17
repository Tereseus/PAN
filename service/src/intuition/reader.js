// Intuition's reading of him: mood, urgency, wellbeing, awake, need, complexity. No model.
//
// Until 2026-11-03 these came from a cloud model (classifyAxes in index.js): 433 calls that
// day, which used up the free Gemini quota the interpreter needed, and a reading that changed
// whenever the model felt like it. This is rules over what he actually said and when: his
// words, how fast they come, how long he has been up, and his own clock (time.js). Every
// value carries its evidence and a confidence, and it is held (below) instead of being
// re-read from scratch every tick, so the panel does not flip every minute.
//
// Pure: no imports, no database. index.js gathers the inputs. Adding a cue is adding a line
// to a table below; test it against the scenes in docs/INTUITION-STATE.md.
//
// NOT a medical device. These are PAN's assumptions about him, nothing more.

const MIN = 60_000;
const HOUR = 60 * MIN;

// How long a reading holds once nothing new supports it (INTUITION-STATE.md 3.1).
const MOOD_FADE_MS = 20 * MIN;
const WELLBEING_FADE_MS = 60 * MIN;
// A line counts in full for the first two minutes, then its weight halves every six, so the
// last few minutes decide.
const LINE_FULL_MS = 2 * MIN;
const LINE_HALF_LIFE_MS = 6 * MIN;
const LINES_WINDOW_MS = 20 * MIN;

// ── Cues ────────────────────────────────────────────────────────────────────
// [pattern, weight]. Patterns run on lowercased text with straight apostrophes. Phrases that
// look negative but are not ("not bad", "no problem") are rewritten to "alright" first.
const BENIGN = [
  [/\bnot (?:too |that |so |half )?bad\b/g, ' alright '],
  [/\bno (?:problem|worries)\b/g, ' alright '],
  [/\bnothing (?:is )?wrong\b/g, ' alright '],
  [/\b(?:doesn'?t|does not) matter\b/g, ' alright '],
];

const CUES = {
  // Something is not working and it bothers him.
  frustrated: [
    [/\bwhy (?:does|did|is|are|do|would|will)(?:n'?t| not)? (?:it|this|that|they|you|he|she)\b[^.?!]{0,40}\b(?:fail|break|broke|crash|stop|work|keep|do that|so bad|wrong)/, 0.7],
    [/\b(?:waste|wasting|wasted) (?:of )?my time\b/, 0.8],
    [/\b(?:i told you|how many times|i already (?:said|told))\b/, 0.7],
    [/\bfor fuck'?s sake\b|\bffs\b/, 0.6],
    // Swearing by itself is how some people talk, not a mood: "what the fuck happened to it, I just
    // saw it" is surprise, and the owner's reading sat on Frustrated all day because of lines like
    // it (2026-11-17). 'register' cues count only on a line that also has a real cue of 0.4 or more.
    [/\bwhat the (?:fuck|hell)\b|\bwtf\b/, 0.6, 'register'],
    [/\bfuck(?:ing)? (?:this|that|it)\b|\bthis (?:shit|crap)\b|\bso much (?:shit|crap)\b/, 0.6, 'register'],
    [/\b(?:annoying|annoyed|pissed|frustrat\w*|fed up|sick of|tired of (?:this|it|that))\b/, 0.6],
    [/\b(?:still|again)\b[^.?!]{0,25}\b(?:not|broken|failing|fails|wrong|doesn'?t|isn'?t|won'?t|same)\b/, 0.5],
    [/\b(?:not|isn'?t|aren'?t|doesn'?t|don'?t|won'?t|stopped) work(?:ing|s)?\b|\bdoes not work\b/, 0.4],
    [/\b(?:fail(?:s|ed|ing)?|broken|broke|crash(?:es|ed|ing)?|garbage|useless|terrible|horrible|awful|sucks?|so bad|so stupid)\b/, 0.35],
    [/\byou (?:just|always|keep|never|didn'?t even)\b/, 0.4],
    [/\b(?:never|don'?t ever) (?:do|add|put|use|say) (?:it|that|this|anything)\b/, 0.3],
    [/\bcome on\b|\bseriously\b|\bugh+\b|\bare you kidding\b/, 0.4],
  ],
  // He wants it faster.
  impatient: [
    [/\b(?:hurry|asap|right now|immediately|faster|quicker)\b/, 0.5],
    [/\b(?:how long|taking (?:so|too) long|taking forever|still waiting|any (?:time|day) now)\b/, 0.6],
    [/\b(?:just do it|get on with it|move on|already\?)\b/, 0.5],
  ],
  // Something worked or he loves the idea.
  energized: [
    [/\b(?:awesome|amazing|incredible|fantastic|brilliant|excellent|beautiful|wonderful)\b/, 0.5],
    [/\b(?:hell|fuck|heck) (?:yes|yeah)\b|\blet'?s (?:go|do (?:it|this))\b|\bnailed it\b/, 0.6],
    [/\blove (?:it|this|that)\b|\bso cool\b|\bholy (?:shit|crap|cow)\b|\bwow+\b/, 0.5],
    [/\b(?:it|that|this) works\b|\bworks now\b|\bfinally (?:works|working)\b|\bperfect\b|\bsweet\b/, 0.45],
    [/\bfucking (?:awesome|amazing|great|good|perfect|cool|incredible)\b/, 0.4],
  ],
  // Thinking along, ideas, planning together.
  engaged: [
    [/\blet'?s\b|\bwe (?:should|could|can|need to|have to)\b/, 0.3],
    [/\b(?:how about|what if|why don'?t we|why not)\b/, 0.35],
    [/\bi (?:think|guess|mean|want|would say)\b/, 0.2],
    [/\b(?:makes sense|sounds good|good idea|that'?s (?:good|great|right|it)|how does that sound)\b/, 0.3],
    [/\b(?:plan|idea|design|build|figure out|try)\b/, 0.15],
  ],
  // Steady, agreeable.
  calm: [
    [/\b(?:ok(?:ay)?|fine|sure|alright|all right|cool|got it|fair enough|whatever works)\b/, 0.3],
    [/\b(?:thanks|thank you|cheers|appreciate it)\b/, 0.35],
  ],
  tired: [
    [/\bi'?m (?:so |really |pretty )?(?:tired|exhausted|sleepy|beat|wiped|knackered|drained|done for (?:the|to)day)\b/, 0.8],
    [/\b(?:need (?:to )?sleep|going to (?:bed|sleep)|go to (?:bed|sleep)|heading to bed|good ?night|can'?t keep my eyes open|long day)\b/, 0.6],
  ],
  stressed: [
    [/\bi'?m (?:so |really |a bit |kind of )?(?:stressed|overwhelmed|anxious|worried|scared|nervous|panicking|freaking out)\b/, 0.8],
    [/\b(?:stressing|stressed out|too much (?:on|going on)|can'?t cope|losing my mind)\b/, 0.6],
  ],
  upset: [
    [/\bi'?m (?:so |really )?(?:sad|upset|depressed|lonely|heartbroken|miserable)\b|\bi feel (?:sad|lonely|empty|hopeless)\b/, 0.8],
    [/\b(?:crying|i want to cry|bad news|someone died|passed away)\b/, 0.6],
  ],
};

// First person and now: "I can't breathe", not "what if someone can't breathe".
const EMERGENCY = [
  /\b(?:i need help|help me|somebody help|someone help)\b/,
  /\bcall (?:an? )?(?:ambulance|911|112|the police|the fire)\b/,
  /\bi (?:can'?t|cannot) breathe\b/,
  /\b(?:chest pain|heart attack|having a (?:stroke|seizure|heart attack))\b/,
  /\bi'?m (?:hurt|bleeding|injured|being (?:attacked|followed))\b/,
  /\bi (?:fell|got hit|was hit|crashed)\b/,
  /\bi'?ve been (?:attacked|robbed|hit|stabbed|in an accident)\b/,
  /\b(?:someone|somebody) (?:is )?(?:attacking|following|chasing) me\b/,
];
const HYPOTHETICAL = /\b(?:what if|how do (?:i|you)|if (?:someone|somebody|you|i|he|she)|when (?:someone|somebody)|in the (?:movie|game|show|book|story|test)|for example|pretend|imagine|the word|says?|said|lyrics?|line from)\b/;

const UNWELL = [
  [/\bi'?m (?:sick|ill|unwell|hungover|burnt out|burned out|not (?:ok|okay|well|good|feeling (?:well|good)))\b/, 'he said he is not well'],
  [/\bi (?:have|got) (?:a )?(?:headache|migraine|fever|the flu|a cold|covid)\b/, 'he mentioned feeling ill'],
  [/\bi feel (?:sick|terrible|awful|like shit|like crap|dizzy|faint|weak)\b/, 'he said he feels bad'],
  [/\bi (?:haven'?t|have not|didn'?t) (?:eaten|slept)\b|\bcan'?t sleep\b|\bthrowing up\b/, 'he mentioned not eating or sleeping'],
  [/\bi need a break\b|\bi'?m (?:exhausted|so tired)\b/, 'he said he is worn out'],
];

const URGENT = /\b(?:urgent|emergency|asap|right now|immediately|hurry|quick(?:ly)?)\b/;
// He does not follow what was just said to him, or says it was off the point. The second half is
// from his own talks of Nov 15 ("What does X have to do with Y?", "That has
// nothing to do with what I was talking about", an angry "what are you talking about", "why did
// you say X?"): six turns in a row like that, and the voice model kept inventing.
const CONFUSED = /\b(?:i don'?t (?:understand|get it|follow)|what do you mean|makes? no sense|doesn'?t make (?:any |much )?sense|i'?m (?:lost|confused)|what (?:are|were) you (?:even )?(?:talking|on) about|what (?:does|do|did|has|have|would) (?!(?:i|we)\b)[^.?!]{1,60}\b(?:have|has|got) to do with|(?:has|have|had|got|having) nothing to do with|why (?:do|did|would) you say|(?:that'?s|that is|it'?s|this is) not what i (?:said|asked|meant|was (?:asking|saying|talking about)))\b/;
const TECH = /\b[a-z]+\.(?:js|ts|py|kt|json|md|html|css|bat|ps1|sql|yaml|yml)\b|\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z][A-Za-z]+\b|\b(?:api|db|sql|json|regex|server|deploy|commit|config|endpoint|function|script|query|cache|thread|process|port|token|model|build|bug|apk|ssh|repo|branch)\b/g;

// ── Text helpers ────────────────────────────────────────────────────────────

// What he wrote himself. Claude prompts carry pasted logs, code and tagged notices; an error
// log full of "failed" is not his mood.
export function humanPart(text) {
  let t = String(text || '').replace(/[\u2018\u2019]/g, "'");
  t = t.replace(/<([a-z][\w-]{0,40})[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/```[\s\S]*?(?:```|$)/g, ' ');
  const kept = [];
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const letters = (line.match(/[a-z]/gi) || []).length;
    if (letters < line.length * 0.6) continue;                                   // symbols, numbers, paths
    if (/[{};]|=>|^\s*(?:at |[$>#]|\[\w+\])|\b\d\d:\d\d:\d\d\b|^\w*(?:error|exception|warn)\w*:/i.test(line)) continue;
    kept.push(line);
    if (kept.join(' ').length > 600) break;
  }
  return kept.join(' ').slice(0, 600);
}

function norm(text) {
  let t = ' ' + String(text || '').toLowerCase().replace(/[\u2018\u2019]/g, "'") + ' ';
  for (const [re, to] of BENIGN) t = t.replace(re, to);
  return t;
}

function words(text) { return String(text || '').toLowerCase().match(/[a-z']+/g) || []; }

function contentSet(text) {
  return new Set(words(text).filter((w) => w.length > 3));
}

function similar(a, b) {
  const A = contentSet(a), B = contentSet(b);
  if (A.size < 3 || B.size < 3) return false;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.6;
}

function cueScores(text) {
  const t = norm(text);
  const out = {};
  const hits = [];
  for (const [label, list] of Object.entries(CUES)) {
    let s = 0, top = 0;
    const register = [];
    for (const [re, w, kind] of list) {
      const m = t.match(re);
      if (!m) continue;
      const hit = { label, cue: m[0].trim().slice(0, 40) };
      if (kind === 'register') { register.push([w, hit]); continue; }
      s += w; top = Math.max(top, w); hits.push(hit);
    }
    // Swearing adds to a line that already says something is wrong; alone it says nothing.
    if (top >= 0.4) for (const [w, hit] of register) { s += w; hits.push(hit); }
    if (s) out[label] = Math.min(1, s);
  }
  // Shouting and stacked marks push whatever he is feeling a bit further.
  const raw = String(text || '');
  const caps = (raw.match(/\b[A-Z]{3,}\b/g) || []).filter((w) => !/^(?:API|PAN|USB|GPU|CPU|JSON|SQL|HTTP|OK|TV|AI|ET|EET|UTC|SSH|APK|NLLB|LLM|STT|TTS)$/.test(w)).length;
  const boost = (caps >= 2 ? 0.15 : 0) + (/[!?]{2,}/.test(raw) ? 0.15 : 0);
  if (boost) for (const k of ['frustrated', 'impatient', 'energized']) if (out[k]) out[k] = Math.min(1, out[k] + boost);
  return { scores: out, hits };
}

function firstPersonEmergency(text) {
  const t = norm(text);
  if (HYPOTHETICAL.test(t)) return null;
  for (const re of EMERGENCY) { const m = t.match(re); if (m) return m[0].trim(); }
  return null;
}

function unwell(text) {
  const t = norm(text);
  if (HYPOTHETICAL.test(t)) return null;
  for (const [re, why] of UNWELL) if (re.test(t)) return why;
  return null;
}

/** The tone of one line: calm, joking, heated or upset (INTUITION-STATE.md 3.4). */
export function toneOf(text) {
  const raw = String(text || '');
  if (/\b(?:haha+|hehe+|lol|lmao|rofl|just kidding|jk)\b|😂|🤣|😄/i.test(raw)) return 'joking';
  const { scores } = cueScores(raw);
  if ((scores.upset || 0) >= 0.5 || (scores.stressed || 0) >= 0.5) return 'upset';
  if ((scores.frustrated || 0) >= 0.55 || (scores.impatient || 0) >= 0.5) return 'heated';
  return 'calm';
}

/**
 * Whether this line says he is lost with the answer he just got, or angry at it: the same cues
 * the mood and need readings use. The voice path asks this of his line as it arrives (router.js,
 * routeStream), since the held reading only catches up a turn later.
 */
export function lostBy(text) {
  return CONFUSED.test(norm(text)) || (cueScores(String(text || '')).scores.frustrated || 0) >= 0.55;
}

// ── A question about the world ──────────────────────────────────────────────
// Whether his line asks something that needs knowledge or judgment (how, why, what is, how much,
// is it bad to, should I, do you think X will, who would buy it), as opposed to small talk, a
// reaction, a request to do something, or a question the turn's own facts answer (the clock, the
// weather, a sum, his screens, his own notes). The 2B voice model answers the first kind from its
// own head, fluently and wrong (a made-up dietary figure, a wrong legal
// age, an invented rating for a household device; Nov 15 and the round 17 probe), and two
// training rounds could not teach it to tell which ones it does not know. The reading is by form,
// not by subject: a miss in either direction costs speed, never a wrong path (the bigger model can
// also tell the time).
const Q_FILLER = /^(?:(?:so|and|but|okay|ok|all right|alright|well|then|like|um+|uh+|er+|hey|yeah|yes|no|wait|now|right|hmm+|oh|pan|i mean|you know|tell me|i wonder|i was wondering|do you know|can you tell me|could you tell me|can you explain|could you explain|explain)\b[\s,]*)+/;
const Q_START = /^(?:how|why|what|when|where|who|which|whose|whats|what's|hows|how's|whos|who's)\b|^(?:is|are|was|were|does|did|can|could|should|would|will|has|isn't|aren't|doesn't|didn't|won't|wouldn't|shouldn't|can't)\s+[a-z']+\b|^do(?:n't)?\s+(?:you (?:think|reckon|believe|know (?:how|why|what|when|where|who|if|whether))|people|they|we|i|most|all|some|[a-z]+s)\b|^have\s+(?:you|they|people|we|i)\b|^(?:how come|what if|what about)\b/;
// Things the voice model is tested on, or that other parts of the turn answer.
const Q_LIGHT = new RegExp([
  String.raw`\bwhat(?:'s| is|s)? (?:the )?(?:time|date|day)\b|\bwhat (?:time|day|month|year) is it\b|\bis it (?:still )?(?:morning|night|late|early|dark|light)\b`,
  String.raw`\b(?:weather|forecast|rain(?:ing|y)?|snow(?:ing)?|sunrise|sunset|sun (?:come|comes|go|goes|set|sets|rise|rises)|temperature|degrees|jacket|umbrella|(?:cold|hot|warm|dark|light|windy) (?:out|outside))\b`,
  String.raw`\bwhere (?:am i|are we|were we)\b|\bwhat (?:am|was) i (?:doing|working on|looking at|up to|saying)\b|\bon my (?:screen|desktop|laptop|computer|phone|monitor)s?\b`,
  String.raw`^how(?:'s|'| is| are|s)? (?:is )?(?:it going|you\b(?: (?:doing|feeling|holding up|today|tonight|this (?:morning|evening)))*|things|everything|your (?:day|night))(?:\s+[a-z']+){0,2}\s*$|^how(?:'s|'| is|s)? (?:is )?it going\b|\bwhat(?:'s| is|s) (?:up|new|going on|happening)\b|\bhow (?:was|is) your\b`,
  String.raw`\b(?:can|could|do|did|will|would|are|were) you (?:hear|there|listening|awake|still|okay|ok|ready|with me|working|getting|recording|get that|catch)\b|\bis (?:this|it|that) (?:thing )?(?:on|working|recording)\b`,
  String.raw`^(?:can|could|will|would|won't) you\b|^(?:can|could|should|shall|may) (?:i|we) (?:get|have|see|hear|ask|say|tell|try|go|start|stop)\b`,
  String.raw`\bdo you (?:like|love|hate|enjoy|want|prefer|have a|remember|know (?:me|who i|my|what i)|mind|feel|get (?:it|me|that)|understand|see what)\b|\bwhat(?:'s| is| are)? your (?:favou?rite|name)\b|\bwhat do you (?:like|want|prefer|feel)\b|\b(?:are|were) you (?:a|an|real|alive|human|happy|sad|bored|tired|sure|serious|kidding|joking)\b`,
  String.raw`\b\d+(?:\.\d+)?\s*(?:plus|minus|times|x|\*|\+|-|divided|over|percent|squared)\b|\b(?:plus|minus|times|divided by|percent of|squared|square root of)\b`,
  String.raw`\b(?:did|have|had|was|were) (?:i|we)\b|\bwhat (?:did|have|was|were) (?:i|we|you)\b|\b(?:remember|remind me|last (?:time|night|week|month)|yesterday|earlier|this morning|a (?:minute|second|moment) ago)\b|\bmy (?:notes?|list|calendar|schedule|appointments?|e?mails?|messages?|tasks?|threads?|sessions?)\b`,
  String.raw`\bwhat (?:do|did) you (?:mean|say)\b|^(?:what|how) about (?:it|that|this|you|me|now)\s*$|^(?:what|how|why) (?:now|so|then|else|next)\s*$|\b(?:what|who) (?:is|was|are) (?:that|this|it|he|she|they)\s*$|\bwhy (?:not|is that|was that|though)\s*$|\b(?:really|seriously|right|you sure|you think so|is that (?:right|true|so)|are you sure)\s*$`,
].join('|'));

/** His line is a whole question about the world (see above). */
export function asksTheWorld(text) {
  const raw = String(text || '').toLowerCase().replace(/[‘’]/g, "'");
  // The question is the last clause that opens like one; "All right, let me think of another
  // question here. Do you think X will..." asks in its second sentence.
  const clauses = raw.split(/(?<=[.!?])\s+|;\s+/).map((c) => ({ asked: /\?\s*$/.test(c), c: c.replace(/[^a-z0-9'*+.\- ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(Q_FILLER, '').trim() })).filter((x) => x.c);
  for (let i = clauses.length - 1; i >= 0; i--) {
    let c = clauses[i].c.replace(/[.\s]+$/, '');
    // "At what point do you think...", and a sentence restarted on the way to its question
    // ("Maybe let me when do you think X is going to happen?").
    if (!Q_START.test(c)) c = c.replace(/^(?:at|in|on|for|to|by|from|with|about|of|around|after|before) (?=(?:what|which|who|whom|how)\b)/, '');
    if (!Q_START.test(c) && clauses[i].asked) c = c.slice(Math.max(0, c.search(/\b(?:how|why|what|when|where|who|which)\b/)));
    if (!Q_START.test(c)) continue;
    if ((c.match(/[a-z0-9']+/g) || []).length < 3) return false;
    return !Q_LIGHT.test(c);
  }
  return false;
}

// ── A request to come up with something ─────────────────────────────────────
// A request for a question, a joke, an idea, "say something": he wants PAN to produce a thing of
// its own. The 2B voice model answers these with two words of agreement
// ("Fair enough." twice running, Nov 17). Read by form, like asksTheWorld; things that are an
// action (music, a timer, a photo, a thread) or that the turn's own facts answer stay where they are.
const A_LEAD = /^(?:(?:i want you to|i'd like you to|i would like you to|i need you to|can you|could you|would you|will you|why don't you|how about you|you should|you can|please|go ahead and|just|now|then|so|okay|ok|all right|alright|well|and|but|hey|yeah|yes|no|pan|come on)\b[\s,]*)+/;
const A_VERB = /^(?:ask (?:me|us)\b|tell (?:me|us) (?:a|an|some|something|anything|more|about|what you think|your)\b|give (?:me|us) (?:a|an|some|your|one|two|three|another)\b|say something\b|(?:suggest|recommend|come up with|think of|make up|invent|pick|choose|name) (?:a|an|some|something|one|two|three|me)\b|surprise me\b|talk to me\b|entertain me\b)/;
const A_NOT = /\b(?:give (?:me|us) (?:a|one) (?:sec|second|minute|moment|break|bit|hand|call|ring|shout)|ask (?:me|us) (?:later|again|tomorrow|next time)|thread|threads|song|songs|music|playlist|track|album|timer|alarm|reminder|directions|route|photo|picture|screenshot)\b/;

/** His line asks PAN to come up with something of its own (see above). */
export function asksForSomething(text) {
  const raw = String(text || '').toLowerCase().replace(/[‘’]/g, "'");
  const clauses = raw.split(/(?<=[.!?])\s+|;\s+/).map((c) => c.replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (let i = clauses.length - 1; i >= 0; i--) {
    const c = clauses[i].replace(A_LEAD, '').trim();
    if (!A_VERB.test(c)) continue;
    return !A_NOT.test(c) && !Q_LIGHT.test(c);
  }
  return false;
}

// ── Held readings ───────────────────────────────────────────────────────────
// A Sims need does not reset every tick; neither does this. A new reading replaces the held
// one only when it is clearly stronger, or the held one has faded.
let _mood = null;       // { label, score, at, detail, evidence }
let _wellbeing = null;  // { state, at, detail }

export function resetReader() { _mood = null; _wellbeing = null; }

function heldScore(h, now, fadeMs) {
  if (!h) return 0;
  const age = now - h.at;
  if (age >= fadeMs) return 0;
  return h.score * Math.pow(0.5, age / (fadeMs / 2));
}

function quote(s) { return `"${String(s).slice(0, 40)}"`; }

/**
 * Read him.
 *
 * input = {
 *   now,                 epoch ms
 *   hour,                his local hour (time.js), 0..23
 *   lines,               his own lines: [{ text, at, channel: 'voice' | 'claude' }]
 *   lastInputAt,         epoch ms of his latest voice turn or Claude prompt, or null
 *   awakeSince,          epoch ms his current waking stretch began (index.js), or null
 *   activity, focus,     the snapshot's strings, for focused / relaxed
 *   dictating,           he is talking to Claude, not PAN
 * }
 */
export function readHim(input = {}) {
  const now = input.now || Date.now();
  const hour = Number.isFinite(input.hour) ? input.hour : new Date(now).getHours();
  const lines = (input.lines || [])
    .map((l) => ({ ...l, human: l.channel === 'claude' ? humanPart(l.text) : String(l.text || '').trim() }))
    .filter((l) => l.human && l.at && now - l.at <= LINES_WINDOW_MS && l.at <= now + MIN)
    .sort((a, b) => b.at - a.at);

  // ── Awake ──
  const sinceInput = input.lastInputAt ? now - input.lastInputAt : Infinity;
  let awake = 'unknown', awakeConfidence = 0.2;
  if (sinceInput <= 30 * MIN) { awake = 'awake'; awakeConfidence = 0.9; }
  else if (sinceInput >= 3 * HOUR && (hour <= 9 || hour >= 23)) { awake = 'asleep'; awakeConfidence = 0.5; }
  else if (sinceInput >= 8 * HOUR) { awake = 'asleep'; awakeConfidence = 0.35; }
  const awakeHours = awake === 'awake' && input.awakeSince ? Math.max(0, (now - input.awakeSince) / HOUR) : null;

  // ── Cues, weighted by recency ──
  const agg = {};
  const evidence = {};
  let emergency = null, unwellWhy = null, confused = 0, urgentCue = false, repeated = false;
  lines.forEach((l, i) => {
    const w = Math.pow(0.5, Math.max(0, now - l.at - LINE_FULL_MS) / LINE_HALF_LIFE_MS);
    const { scores, hits } = cueScores(l.human);
    for (const [k, v] of Object.entries(scores)) agg[k] = (agg[k] || 0) + v * w;
    for (const h of hits) (evidence[h.label] ||= []).push(h.cue);
    if (!emergency && now - l.at <= 10 * MIN) emergency = firstPersonEmergency(l.human);
    if (!unwellWhy && now - l.at <= 60 * MIN) unwellWhy = unwell(l.human);
    if (CONFUSED.test(norm(l.human)) || /\?\s*$/.test(l.human)) confused += w;
    if (URGENT.test(norm(l.human)) && now - l.at <= 5 * MIN) urgentCue = true;
    if (!repeated && now - l.at <= 5 * MIN) repeated = lines.slice(i + 1).some((o) => now - o.at <= 5 * MIN && similar(l.human, o.human));
  });

  // Pace: three lines inside a minute is someone firing off thoughts.
  const recent = lines.filter((l) => now - l.at <= 3 * MIN);
  const span3 = lines.length >= 3 ? lines[0].at - lines[2].at : Infinity;
  const rapid = span3 < MIN;
  const brisk = span3 < 3 * MIN;

  // ── Mood ──
  const s = (k) => agg[k] || 0;
  let cand = null;
  const pick = (label, score, detail, ev = evidence[label]) => { if (!cand || score > cand.score) cand = { label, score, detail, evidence: (ev || []).slice(0, 3) }; };
  if (emergency) pick('stressed', 1, 'he may be in danger', [emergency]);
  if (s('upset') >= 0.5) pick('upset', s('upset'), 'what he said sounds sad');
  if (s('stressed') >= 0.5) pick('stressed', s('stressed'), 'he sounds under pressure');
  if (s('frustrated') >= 0.55) pick('frustrated', s('frustrated'), 'something is not working and it bothers him');
  if (s('impatient') >= 0.5 && s('impatient') >= s('frustrated') * 0.8) pick('impatient', s('impatient') + 0.01, 'he wants it faster');
  if (s('tired') >= 0.5) pick('tired', s('tired'), 'he said he is tired');
  if (s('energized') >= 0.45 && s('energized') > s('frustrated')) pick('energized', s('energized'), 'something landed well');
  if (!cand && s('engaged') >= 0.35) pick('engaged', s('engaged'), 'thinking it through with ideas');
  if (!cand && (rapid || input.dictating || /\b(?:coding|debugging|building|writing)\b/i.test(`${input.activity || ''} ${input.focus || ''}`)) && lines.length) {
    pick('focused', 0.4, rapid ? 'lines coming fast, no strong tone' : 'heads down on the work', []);
  }
  if (!cand && s('calm') >= 0.25) pick('calm', s('calm'), 'steady and easy');

  const held = _mood && heldScore(_mood, now, MOOD_FADE_MS) > 0 ? _mood : null;
  if (cand && (!held || cand.label === held.label || cand.score >= heldScore(held, now, MOOD_FADE_MS) + 0.1)) {
    const fresh = !held || held.label !== cand.label;
    _mood = { ...cand, at: now, since: fresh ? now : held.since };
  } else if (!cand && !held) {
    // Nothing he said decides it: his clock and the hours he has been up do.
    let label = 'neutral', detail = lines.length ? 'no strong tone in his lines' : 'nothing from him lately to read';
    if (awake === 'asleep') { label = 'winding_down'; detail = 'probably asleep'; }
    else if (hour >= 23 || hour < 4) { label = 'winding_down'; detail = `${hour}:00 where he is`; }
    else if (hour >= 5 && hour < 11 && awakeHours != null && awakeHours < 2) { label = 'starting_up'; detail = 'not long up'; }
    else if (/\b(?:game|playing|watching|movie|music|youtube|netflix)\b/i.test(input.activity || '')) { label = 'relaxed'; detail = 'playing or watching'; }
    _mood = { label, score: 0.2, at: now, since: _mood?.label === label ? _mood.since : now, detail, evidence: [] };
  }
  const mood = _mood;
  const energy = mood.label === 'tired' || mood.label === 'winding_down' || mood.label === 'upset' ? 'low'
    : (mood.label === 'energized' || mood.label === 'impatient' || (mood.label === 'frustrated' && mood.score >= 0.8) || rapid) ? 'high' : 'normal';
  const valence = Math.max(-1, Math.min(1, (s('energized') + 0.5 * s('engaged') + 0.3 * s('calm'))
    - (s('frustrated') + 0.6 * s('impatient') + s('stressed') + s('upset') + 0.3 * s('tired'))));
  const moodDetail = mood.evidence?.length
    ? `${mood.detail.charAt(0).toUpperCase()}${mood.detail.slice(1)}: ${mood.evidence.map(quote).join(', ')}`
    : `${mood.detail.charAt(0).toUpperCase()}${mood.detail.slice(1)}`;
  const moodConfidence = Math.round(Math.min(0.9, 0.3 + 0.5 * heldScore(mood, now, MOOD_FADE_MS) + (mood.evidence?.length ? 0.1 : 0)) * 100) / 100;

  // ── Wellbeing ──
  let wb;
  if (emergency) wb = { state: 'emergency', detail: `First person and now: ${quote(emergency)}`, confidence: 0.7 };
  else if (unwellWhy) wb = { state: 'not_ok', detail: unwellWhy.charAt(0).toUpperCase() + unwellWhy.slice(1), confidence: 0.6 };
  else if (awakeHours != null && awakeHours >= 20) wb = { state: 'not_ok', detail: `Up about ${Math.round(awakeHours)} hours`, confidence: 0.5 };
  else if (awakeHours != null && awakeHours >= 16 && hour >= 2 && hour < 6) wb = { state: 'not_ok', detail: `${hour}:00 where he is, up about ${Math.round(awakeHours)} hours`, confidence: 0.45 };
  if (wb) _wellbeing = { ...wb, at: now };
  else if (_wellbeing && now - _wellbeing.at < WELLBEING_FADE_MS && _wellbeing.state !== 'ok') wb = { ..._wellbeing, detail: `${_wellbeing.detail} (${Math.round((now - _wellbeing.at) / MIN)} min ago)` };
  else { wb = { state: 'ok', detail: 'Nothing in his words or hours says otherwise', confidence: 0.6 }; _wellbeing = null; }

  // ── Urgency ──
  let urgency = 'normal', urgencyDetail = 'usual pace';
  if (wb.state === 'emergency') { urgency = 'critical'; urgencyDetail = 'possible emergency'; }
  else if (rapid || (urgentCue && recent.length)) { urgency = 'high'; urgencyDetail = rapid ? '3 lines inside a minute' : 'he asked for it now'; }
  else if (brisk || repeated || s('impatient') >= 0.5) { urgency = 'elevated'; urgencyDetail = repeated ? 'he asked the same thing twice' : brisk ? '3 lines inside 3 minutes' : 'he wants it faster'; }
  else if (awake === 'asleep' || sinceInput > 30 * MIN) { urgency = 'low'; urgencyDetail = awake === 'asleep' ? 'probably asleep' : 'quiet for a while'; }

  // ── Need ──
  let need = null;
  if (wb.state === 'emergency') need = 'help, now';
  else if (mood.label === 'tired' || (wb.state === 'not_ok' && awakeHours != null && awakeHours >= 16)) need = 'rest';
  else if (wb.state === 'not_ok') need = 'a check in';
  else if (confused >= 1.5 || (lines[0] && CONFUSED.test(norm(lines[0].human)))) need = 'clear answers';
  else if (mood.label === 'frustrated' && (evidence.frustrated || []).length) need = 'a fix that works';
  else if (mood.label === 'impatient' || urgency === 'high') need = 'speed';
  else if (input.dictating) need = 'quiet while he talks to Claude';

  // ── Complexity ──
  let complexity = null;
  if (lines.length) {
    const wordCounts = lines.map((l) => words(l.human).length);
    const avg = wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length;
    const tech = lines.reduce((n, l) => n + ((l.human.match(TECH) || []).length), 0);
    complexity = avg >= 40 || (tech >= 6 && lines.length >= 3) ? 'deep'
      : avg >= 20 || tech >= 3 ? 'complex'
      : avg < 8 && tech < 1 ? 'simple' : 'moderate';
  }

  return {
    mood: mood.label,
    mood_detail: moodDetail,
    mood_since: mood.since,
    mood_confidence: moodConfidence,
    valence: Math.round(valence * 100) / 100,
    energy,
    urgency,
    urgency_detail: urgencyDetail,
    need,
    complexity,
    assumption: wb.state,
    assumption_detail: wb.detail,
    assumption_confidence: wb.confidence,
    awake,
    awake_confidence: awakeConfidence,
    awake_hours: awakeHours == null ? null : Math.round(awakeHours * 10) / 10,
    lines_read: lines.length,
  };
}
