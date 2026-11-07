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
    [/\bfor fuck'?s sake\b|\bwhat the (?:fuck|hell)\b|\bwtf\b|\bffs\b/, 0.6],
    [/\bfuck(?:ing)? (?:this|that|it)\b|\bthis (?:shit|crap)\b|\bso much (?:shit|crap)\b/, 0.6],
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
const CONFUSED = /\b(?:i don'?t (?:understand|get it)|what do you mean|makes no sense|i'?m (?:lost|confused))\b/;
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
    let s = 0;
    for (const [re, w] of list) {
      const m = t.match(re);
      if (m) { s += w; hits.push({ label, cue: m[0].trim().slice(0, 40) }); }
    }
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
