// Intuition's reading of the conversation: topic, phase, what is open, how he is talking,
// whether his last line was finished. No model.
//
// Until 2026-11-03 conv-state-watcher.js asked a model for this after every answered turn
// (gemma4:e2b on the hub's CPU, the same CPU the voice turn needs, and a summary that could
// say things nobody said). These are rules over the lines themselves: who said what, when,
// and the words that keep coming back. The output keeps the old shape, so the router's
// conversation block and the snapshot's focus read it unchanged, plus `topics` (the last few
// with times), `mentioned` (things just named, for "it" and "that one") and `tone`.
//
// Pure: no imports from outside intuition/, no database. Topic shift is lexical (stems that
// carry over from line to line). Embedding distance can veto a shift later if the state
// bench shows paraphrases splitting one topic in two.

import { toneOf } from './reader.js';

const MIN = 60_000;
const TOPIC_WINDOW_MS = 10 * MIN;
const IDLE_MS = 5 * MIN;
const OPENING_GAP_MS = 30 * MIN;
const MAX_TOPICS = 5;

const STOP = new Set(`a about above after again against all almost also am an and any are aren't as at be because been
before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down
during each either else even ever every few for from further get gets getting got gonna had hadn't has hasn't have
haven't having he he'd he'll he's her here here's hers herself him himself his how how's however i i'd i'll i'm i've
if in into is isn't it it's its itself just let let's like made make makes making many may maybe me might mine more
most much must mustn't my myself need needs no nor not now of off often on once one ones only or other others ought
our ours ourselves out over own pan please quite rather really right said same say says see seem seems shall shan't
she she'd she'll she's should shouldn't since so some something somewhere still such sure take than that that's the
their theirs them themselves then there there's these they they'd they'll they're they've thing things think this
those though through thus to too under until up upon us use used using very via wanna want wants was wasn't way we
we'd we'll we're we've well were weren't what what's whatever when when's where where's whether which while who
who's whom whose why why's will with within without won't would wouldn't yeah yes yet you you'd you'll you're you've
your yours yourself yourselves okay ok alright actually basically kind sort mean know knew go going goes gone went
come comes came look looks looked try tried trying put puts give gives gave tell told ask asked asking talk talking
thanks thank hey hi hello um uh hmm oh ah stuff lot lots bit guess also anyway anything everything nothing someone
everyone anyone`.split(/\s+/).filter(Boolean));

// Words that are never the topic: common verbs, opinion and size words, numbers, and time
// words ("tomorrow" is when, not what). They still count for nothing in topic shift.
for (const w of `set turn play call remind open show find check build keep wait understand start stop help happen
happens happened feel feels felt add remove run change fix send read write hear listen speak become becomes became
done sound sounds love hate hope wish believe remember forget learn explain move stay leave bring buy pay fail fails
failed failing work works worked working put works seem tried happen trying sounds able cause caused getting
good bad better best worse worst great nice big small little long short tall high low new old first last next
different whole hard easy fast slow real true wrong sure annoying awesome amazing cool fine okay perfect weird crazy
two three four five six seven eight nine ten twenty hundred thousand million half
today tomorrow tonight yesterday morning evening night afternoon week month year time times day days minute minutes
hour hours second seconds moment reason question problem point part idea`.split(/\s+/)) if (w) STOP.add(w);

const ADDRESS = /^(?:(?:hey|hi|hello|yo|ok(?:ay)?|so|good (?:morning|afternoon|evening)),?\s+)*(?:pan,?\s+)?/i;

const IMPERATIVE = /^(?:(?:hey |ok(?:ay)? |so |and |now |pan,? )*)(?:please |can you |could you |would you |will you )?(?:set|turn|switch|play|pause|stop|start|resume|skip|call|text|send|message|remind|open|close|show|tell|ask|translate|interpret|add|remove|delete|take|navigate|find|search|look up|check|read|write|note|save|record|mute|unmute|be quiet|shut up|repeat|say|give me|get me|book|order|buy|cancel|wake me)\b/i;
const DECIDING = /\b(?:should (?:we|i)|which (?:one|is better|should)|or should|let'?s go with|pick|choose|decide|decision|option [a-d1-4]|either .{1,30} or)\b/i;
const WRAPPING = /\b(?:thanks|thank you|cheers|bye|good ?night|see you|talk (?:to you )?later|that'?s (?:all|it)|never ?mind|we'?re done|i'?m done|stop listening)\b/i;
const GREETING = /^(?:hey|hi|hello|good (?:morning|afternoon|evening)|yo)\b/i;
const SELF_CORRECT = /\b(?:i mean|no wait|wait no|actually|sorry|or rather|let me rephrase|scratch that|what i meant)\b/i;
const FILLER = /\b(?:um+|uh+|like|you know|kind of|sort of|i guess)\b/gi;
const UNFINISHED_END = /(?:,|\b(?:and|but|so|or|because|the|a|an|to|of|with|for|if|that|which|um+|uh+|like|then|when|is|are|my|your|in|on|at))\s*$/i;

function stem(w) {
  let s = w.replace(/'s$/, '');
  if (s.length > 5 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 4 && s.endsWith('es') && /(?:ch|sh|x|ss|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us') && !s.endsWith('is')) s = s.slice(0, -1);
  if (s.length > 6 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 5 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 5 && s.endsWith('ly')) s = s.slice(0, -2);
  if (/(?:ion|ions)$/.test(s) && s.length > 7) s = s.replace(/ions?$/, '');   // translation -> translat
  if (s.length > 4 && /([b-df-hj-np-tv-z])\1$/.test(s)) s = s.slice(0, -1);    // runn -> run
  if (s.length > 5 && s.endsWith('e')) s = s.slice(0, -1);                      // translate -> translat
  return s;
}

// Latin words only: a Greek or Japanese line PAN interpreted has no English topic to give.
function tokens(text) {
  const out = [];
  const plain = String(text || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[‘’]/g, "'");
  const re = /[A-Za-z][A-Za-z']+/g;
  let m, i = 0, lastEnd = 0;
  while ((m = re.exec(plain))) {
    const surface = m[0].replace(/'+$/, '');
    const lower = surface.toLowerCase();
    const sentenceStart = /(?:^|[.!?]\s+)$/.test(plain.slice(Math.max(0, m.index - 3), m.index)) || m.index === 0;
    // joined: nothing but spaces since the previous word, so a name can run on ("New York").
    const joined = i > 0 && /^\s+$/.test(plain.slice(lastEnd, m.index));
    out.push({ surface, lower, i: i++, joined, proper: /^[A-Z]/.test(surface) && !sentenceStart && lower !== 'i' });
    lastEnd = m.index + m[0].length;
  }
  return out;
}

function contentTokens(text) {
  return tokens(text).filter((t) => t.lower.length > 2 && !STOP.has(t.lower) && !STOP.has(stem(t.lower)) && !/^\d/.test(t.lower));
}

function stems(text) { return new Set(contentTokens(text).map((t) => stem(t.lower))); }

/** Proper names and capitalised runs: "Eiffel Tower", "Thessaloniki", "Claude". */
export function namedThings(text) {
  const out = [];
  const toks = tokens(text);
  for (let k = 0; k < toks.length; k++) {
    // A common word starts a name only when another capitalised word follows it: "New York".
    const runsOn = k + 1 < toks.length && toks[k + 1].joined && /^[A-Z]/.test(toks[k + 1].surface);
    if (!toks[k].proper || (STOP.has(toks[k].lower) && !runsOn)) continue;
    let run = [toks[k].surface];
    while (k + 1 < toks.length && toks[k + 1].joined && /^[A-Z]/.test(toks[k + 1].surface)) run.push(toks[++k].surface);
    out.push(run.join(' '));
  }
  return out;
}

function isHis(u) { return u.isFinal && u.source !== 'pan' && u.source !== 'room' && !u.toClaude; }

function topicOf(lines, now) {
  // stem -> { score, surfaces: Map(surface -> n), lines: Set }
  const score = new Map();
  const bigrams = new Map();
  lines.forEach((u, li) => {
    const w = Math.pow(0.5, Math.max(0, now - u.at) / (3 * MIN));
    const toks = contentTokens(String(u.text || '').replace(ADDRESS, ''));
    toks.forEach((t, k) => {
      const st = stem(t.lower);
      const e = score.get(st) || { score: 0, surfaces: new Map(), lines: new Set() };
      e.score += w * (t.proper ? 1.5 : 1);
      const form = t.proper ? t.surface : t.lower;   // names keep their capital
      e.surfaces.set(form, (e.surfaces.get(form) || 0) + 1);
      e.lines.add(li);
      score.set(st, e);
      const next = toks[k + 1];
      if (next && next.i === t.i + 1 && next.joined) {
        const key = `${st} ${stem(next.lower)}`;
        const b = bigrams.get(key) || { score: 0, text: `${t.lower} ${next.lower}`, n: 0, proper: t.proper && next.proper };
        b.score += w; b.n++;
        if (t.proper && next.proper) b.text = `${t.surface} ${next.surface}`;
        bigrams.set(key, b);
      }
    });
  });
  const ranked = [...score.entries()]
    .map(([st, e]) => ({ st, value: e.score * (e.lines.size >= 2 ? 1.5 : 1), label: [...e.surfaces.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.value - a.value);
  if (!ranked.length) return { label: null, terms: [] };
  // A pair of words beats single words when it is a name ("Eiffel Tower"), comes up twice, or
  // is made of two of the top three words ("phrase list").
  const top3 = new Set(ranked.slice(0, 3).map((r) => r.st));
  const bestBigram = [...bigrams.entries()]
    .filter(([key, b]) => b.n >= 2 || b.proper || key.split(' ').every((s) => top3.has(s)))
    .map(([, b]) => b).sort((a, b) => b.score - a.score)[0];
  let label;
  if (bestBigram && bestBigram.score >= ranked[0].value * 0.6) label = bestBigram.text;
  else label = ranked.slice(0, ranked[1] && ranked[1].value >= ranked[0].value * 0.75 ? 2 : 1).map((r) => r.label).join(', ');
  return { label, terms: ranked.slice(0, 8).map((r) => r.st) };
}

function lastSentence(text, max = 90) {
  const parts = String(text || '').trim().split(/(?<=[.!?])\s+/);
  const s = parts[parts.length - 1] || '';
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function firstClause(text, max = 60) {
  const s = String(text || '').trim().split(/[.!?;]\s/)[0];
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

/**
 * Read the conversation.
 *   utterances  the watcher's buffer: [{ text, isFinal, source: him|room|pan|dashboard|..., at, toClaude? }]
 *   prev        the previous state from this function (topic start and history), or null
 *   now         epoch ms
 */
export function readConversation({ utterances = [], prev = null, now = Date.now() } = {}) {
  const finals = utterances.filter((u) => u.isFinal).sort((a, b) => a.at - b.at);
  const his = finals.filter(isHis);
  const newest = finals[finals.length - 1] || null;
  const hisNewest = his[his.length - 1] || null;

  // ── Topic, and whether the newest line moved off it ──
  let topicStart = prev?.topic_start || 0;
  let topics = Array.isArray(prev?.topics) ? prev.topics.slice() : [];
  const inTopic = (u) => u.at >= topicStart && now - u.at <= TOPIC_WINDOW_MS;
  let topicShift = false;
  if (hisNewest && hisNewest.at > (prev?.last_his_at || 0)) {
    const before = his.filter((u) => u !== hisNewest && inTopic(u));
    const S = stems(hisNewest.text);
    const T = new Set(before.flatMap((u) => [...stems(u.text)]));
    const overlap = [...S].some((s) => T.has(s));
    const longGap = before.length && hisNewest.at - before[before.length - 1].at > TOPIC_WINDOW_MS;
    if ((S.size >= 2 && T.size >= 3 && !overlap) || longGap || !before.length) {
      if (prev?.topic && before.length) {
        topics.unshift({ label: prev.topic, from: topicStart, to: before[before.length - 1].at });
        topics = topics.slice(0, MAX_TOPICS);
        topicShift = true;
      }
      topicStart = hisNewest.at;
    }
  }
  const topicLines = finals.filter((u) => u.source !== 'room' && !u.toClaude && inTopic(u));
  // His words name the topic. PAN's only when his have nothing to go on ("how tall is it",
  // "The Eiffel Tower is about 330 meters").
  const topic = topicOf(topicLines.filter(isHis), now).label || topicOf(topicLines, now).label;

  // ── Phase ──
  let phase = 'discussing';
  if (!newest || now - newest.at > IDLE_MS) phase = 'idle';
  else if (hisNewest && hisNewest === newest || (hisNewest && newest.source === 'pan')) {
    const t = String(hisNewest.text).trim();
    const prevHis = his[his.length - 2];
    if (WRAPPING.test(t) && t.split(/\s+/).length <= 8) phase = 'wrapping_up';
    else if (GREETING.test(t) || !prevHis || hisNewest.at - prevHis.at > OPENING_GAP_MS) phase = IMPERATIVE.test(t) ? 'command' : 'opening';
    else if (IMPERATIVE.test(t)) phase = 'command';
    else if (DECIDING.test(t)) phase = 'deciding';
  }

  // ── What is open ──
  let pending = null;
  if (newest && newest.source === 'pan' && /\?\s*$/.test(newest.text)) pending = `PAN asked: ${lastSentence(newest.text)}`;

  // ── How he is talking ──
  let pattern = null;
  const recentHis = his.filter((u) => now - u.at <= TOPIC_WINDOW_MS).slice(-5);
  if (recentHis.length) {
    const wc = recentHis.map((u) => String(u.text).split(/\s+/).filter(Boolean).length);
    const avg = wc.reduce((a, b) => a + b, 0) / wc.length;
    const traits = [];
    if (avg < 6) traits.push('terse');
    else if (avg > 25) traits.push('verbose');
    if (recentHis.some((u) => SELF_CORRECT.test(u.text))) traits.push('self-correcting');
    if (recentHis.reduce((n, u) => n + ((String(u.text).match(FILLER) || []).length), 0) >= 3) traits.push('thinking aloud');
    if (recentHis.filter((u) => /\?\s*$/.test(u.text)).length >= Math.max(2, recentHis.length / 2)) traits.push('asking questions');
    pattern = traits.slice(0, 2).join(', ') || 'plain';
  }

  // ── Was his last line finished ──
  let complete = null;
  if (hisNewest) {
    const t = String(hisNewest.text).trim();
    if (/[.!?…]["')\]]*$/.test(t)) complete = true;
    else if (UNFINISHED_END.test(t)) complete = false;
    else complete = t.split(/\s+/).length >= 3;
  }

  // ── Things just named ──
  const mentioned = [];
  for (const u of finals.slice(-4).reverse()) {
    if (u.source === 'room' || u.toClaude) continue;
    for (const n of namedThings(u.text)) if (!mentioned.includes(n)) mentioned.push(n);
    if (mentioned.length >= 5) break;
  }

  // ── One line of what is happening, from the lines themselves ──
  let summary = null;
  if (newest && phase !== 'idle') {
    const lastPan = newest.source === 'pan' ? newest : null;
    if (pending) summary = `${pending.replace(/^PAN asked: /, 'PAN asked him: ')}, and is waiting for his answer`;
    else if (hisNewest && phase === 'command') summary = `He asked PAN to ${firstClause(hisNewest.text).replace(/^(?:hey |ok(?:ay)? |so |pan,? )*(?:please |can you |could you |would you )?/i, '')}${lastPan ? ', and PAN answered' : ''}`;
    else if (hisNewest && /\?\s*$/.test(hisNewest.text)) summary = `He asked "${lastSentence(hisNewest.text, 70)}"${lastPan ? ' and PAN answered' : ''}`;
    else if (topic) summary = `Talking about ${topic}${topicShift && topics[0] ? ` (moved on from ${topics[0].label})` : ''}`;
  }

  return {
    topic: topic || null,
    topic_start: topicStart || null,
    topic_shift: topicShift,
    topics,
    phase,
    pending_question: pending,
    user_pattern: pattern,
    likely_turn_complete: complete,
    summary: summary ? summary.slice(0, 180) : null,
    mentioned,
    tone: hisNewest && now - hisNewest.at <= IDLE_MS ? toneOf(hisNewest.text) : null,
    last_his_at: hisNewest ? hisNewest.at : (prev?.last_his_at || 0),
  };
}

// ── A question that leans on the last one ──
// "How long would it take to get there?" right after "How far is the sun from the earth?" means
// the sun. The voice model read it on its own and said "I don't know where you're headed"
// (2026-11-08): with an older exchange above the newest one it loses which one is current, and
// it found the sun at once when one line said what he was following up on. The thing in focus
// is the last thing he asked. A question that brings at most one new word of its own and
// points back (there, it, he, that) or carries on ("and by car?", "why?", "how long?") leans
// on it, and the focus stays there, through more such questions, until he asks something
// with words of its own.

const POINTER = /\b(?:there|it|its|that|this|those|these|they|them|their|he|him|his|she|her|then)\b/i;
// Borrows the rest of the last question: "and Mars?", "what about by car?", "why not?", "how
// long?". "How far is Mars?" and "why is the sky blue?" have their own and do not.
const CARRIES_ON = /^(?:and|or|but|what about|how about|why not|compared to|such as|like what|which one)\b|^(?:why|how come|really|seriously|how (?:long|much|many|far|fast|big|old|often))\s*[?.!]*$/i;
const ASKING = /^(?:what|how|why|who|whom|whose|where|when|which|is|are|was|were|can|could|would|will|do|does|did|should|has|have|had)\b/i;
// "It" and "that" pointing at nothing: "what time is it", "is it going to rain", "never mind".
const POINTS_AT_NOTHING = /\b(?:what (?:time|day|date|year|month) is it|is it (?:going to|gonna|supposed to) (?:rain|snow|be)\b[^?.!]*|it'?s (?:raining|snowing|cold|hot|warm|late|early|sunny|windy)|how'?s it going|how is it going|that'?s (?:it|all)|never ?mind|forget (?:about )?it|got it|get it)\b/gi;
const OPENER = /^(?:(?:ok(?:ay)?|so|well|hey|pan|alright|all right|right|um+|uh+)[,.]?\s+)+/i;
const PHOTO_TAG = /^\[photo\]\s*/i;

/** His and PAN's lines from a history block. The phone writes "User:" and "PAN:", the hub's own
 *  fallback "You:" for him (routes/api.js voiceHistory), and "PAN (what the photo showed):". */
export function historyLines(history) {
  const out = [];
  for (const raw of String(history || '').split('\n')) {
    const m = raw.match(/^\s*(User|You|He|PAN)(?: \([^)]{0,40}\))?: ?(.*)$/);
    if (m) out.push({ his: m[1] !== 'PAN', text: m[2].trim() });
    else if (out.length && raw.trim()) out[out.length - 1].text += ` ${raw.trim()}`;
  }
  return out;
}

function leansOn(text, exchange) {
  const t = String(text || '').replace(PHOTO_TAG, '').replace(OPENER, '').trim();
  const bare = t.replace(POINTS_AT_NOTHING, ' ').trim();
  if (!CARRIES_ON.test(bare) && !(POINTER.test(bare) && (/\?\s*$/.test(t) || ASKING.test(bare)))) return false;
  const known = stems([exchange.asked, ...exchange.said].join(' '));
  return [...stems(bare)].filter((s) => !known.has(s)).length <= 1;
}

/**
 * What a question leans on, or null when it stands on its own.
 *   history  the history block the voice model gets ("User: ..." / "PAN: ..." lines, oldest first)
 *   text     what he just said
 * Returns { asked, about, photo }: the last thing he asked, the question that started this run
 * of follow-ups when that was earlier (else null), and whether that start was a photo.
 */
export function followUpOf(history, text) {
  const exchanges = [];
  for (const l of historyLines(history)) {
    if (l.his) exchanges.push({ asked: l.text.replace(PHOTO_TAG, ''), said: [], photo: PHOTO_TAG.test(l.text) });
    else if (exchanges.length) exchanges[exchanges.length - 1].said.push(l.text);
  }
  const last = exchanges[exchanges.length - 1];
  if (!last || !last.asked || !leansOn(text, last)) return null;
  // Back through earlier follow-ups to the question that started them. A photo always starts:
  // "hey what am I looking at" heard as "he what am I looking at?" would otherwise lean.
  let k = exchanges.length - 1;
  for (let hops = 0; k > 0 && hops < 3 && !exchanges[k].photo && leansOn(exchanges[k].asked, exchanges[k - 1]); hops++) k--;
  return { asked: last.asked, about: k < exchanges.length - 1 ? exchanges[k].asked : null, photo: exchanges[k].photo };
}

/** The line the voice model gets under the history when a question leans on the last one. */
export function followUpLine(fu) {
  if (!fu) return '';
  const clean = (s) => String(s).replace(/[\s.?!]+$/, '').slice(0, 160);
  return `(He is following up on the last thing he asked: ${clean(fu.asked)}${fu.about ? `, which was about: ${clean(fu.about)}` : ''}.)`;
}
