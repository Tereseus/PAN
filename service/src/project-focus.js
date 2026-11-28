// Which project a voice line is about, and only that project's notes for the answer (Nov 28).
// Pure: no database, no model, so the bench (evals/projects) runs the same code as the hub.
// projects.js holds the notes and the meaning vectors; this file decides with them.
//
// Why only one project: every project question sent all eight projects' notes to the answering
// model (Claude Haiku 5.5 on a Claude login), about 9,900 tokens, 2.5 to 3.9 s a turn on the hub
// (steps clock, Nov 27). A line about one project needs that project's notes, plus the two "who is
// waiting" lists when it is about waiting. When no single project matches (a name in several
// projects, two projects as close in meaning), the answer gets all the notes, as before.

export const WAITING_ON_ME = /\b(?:who(?:'s| is| are)?|anyone|anybody|is anyone|is anybody)\b[^?.!]*\bwait(?:ing)? (?:on|for) (?:me|us)\b|\bwho (?:do|have) i (?:still )?(?:owe|need to (?:answer|reply to|get back to))\b|\bwho (?:haven'?t|have not) i (?:answered|replied to)\b/i;
export const I_WAIT_ON = /\bwho (?:am i|are we) (?:still )?waiting (?:on|for)\b|\bwho (?:still )?owes (?:me|us)\b|\bwho do (?:i|we) wait (?:on|for)\b/i;
export const QUESTION = /\?\s*$|^(?:who|what|when|where|why|how|which|is|are|did|do|does|should|can|could|has|have|will|was)\b/i;
export const SELF_NOW = /\bwhat version\b|\b(?:are|were) you\b[^?.!]{0,30}\b(?:updated?|on the latest|running|online|listening|muted|charged|awake)\b|\b(?:what'?s|what is) your (?:version|battery|status)\b/i;

// About waiting: the answer keeps the two lists (who waits on him, who he waits on).
const ABOUT_WAITING = /\bwait|\bowes?\b|\bowed\b|\bsupposed to\b|\bsend (?:us|me)\b|\bget back to\b|\bhear(?:d)? back\b|\brepl(?:y|ied)\b|\banswer(?:ed)?\b|\bchase\b|\bholding\b|\bblocked\b|\bpending\b/i;

// Lines plainly about everyday things, never a project (fix 4, Nov 28): the meaning check is skipped,
// which saves the line's embedding (about 50 to 160 ms on the hub). Only reached after no name and no
// project topic matched, so "when does the camera ship" still goes by its topic first.
const EVERYDAY = /\b(?:weather|forecast|temperature|raining|snowing|what time|time is it|today'?s date|what'?s the date|how are you|how'?s it going|how you doing|tell me a joke|meaning of life|translate|how do you say|square root|capital of|population of|how far is|who (?:won|invented|wrote|discovered|painted) |set a timer|set an alarm|remind me|directions to)\b|\d\s*(?:plus|minus|times|divided by|x)\s*\d/i;
export function clearlyNotProject(text) { return EVERYDAY.test(String(text || '')); }

// Words of a name that must match whole, case blind; names under 3 letters are skipped.
// The assistant's own name is in every line said to it ("ΠAN hardware"), so it never counts.
// ΠAN's own parts and the assistants he talks to come up in his talk about ΠAN itself, not projects.
export const NOT_NAMES = new Set(['pan', 'πan', 'the', 'and', 'for', 'with', 'hub', 'claude', 'haiku', 'sonnet', 'opus', 'mint', 'g16',
  'agent', 'question', 'questions', 'model', 'models', 'app', 'update', 'memory', 'bench', 'thread', 'threads', 'phone']);
export function namesIn(notes) {
  const out = new Set();
  for (const p of notes.projects) {
    for (const w of p.words || []) out.add(w);
    // the capitalised words of the project's own name: "Medallion", "LLC"
    for (const w of String(p.name).split(/[^\p{L}\p{N}]+/u)) if (/^\p{Lu}/u.test(w) && !NOT_NAMES.has(w.toLowerCase()) && !(p.everyday || []).includes(w)) out.add(w);
  }
  for (const l of [...(notes.waiting_on_owner || []), ...(notes.owner_waiting_on || [])]) {
    const m = String(l).match(/^([^(]+)\(([^,)]+)/);
    if (m) { out.add(m[1].trim()); out.add(m[2].trim()); }
  }
  return [...out].filter((w) => w.length >= 3);
}
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const hasWord = (text, w) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(w)}(?![\\p{L}\\p{N}])`, 'iu').test(text);

function projectText(p) {
  return [p.name, p.summary, ...(p.words || []), ...(p.topics || []), ...(p.facts || []), ...(p.qa || []).flatMap((x) => [x.q, x.a])].join('\n');
}

const count = (text, w) => (String(text).match(new RegExp(`(?<![\\p{L}\\p{N}])${esc(w)}(?![\\p{L}\\p{N}])`, 'giu')) || []).length;
// The project a name belongs to: the one with it in its own name, else in its own words, else the one
// that says it at least twice as often as any other. A name in several projects alike: all of them.
function ownersOf(notes, w) {
  const inName = notes.projects.filter((p) => hasWord(p.name, w));
  if (inName.length === 1) return [inName[0].name];
  const inWords = notes.projects.filter((p) => (p.words || []).some((x) => String(x).toLowerCase() === w.toLowerCase()));
  if (inWords.length === 1) return [inWords[0].name];
  const n = notes.projects.map((p) => ({ name: p.name, n: count(projectText(p), w) })).filter((x) => x.n).sort((a, b) => b.n - a.n);
  if (n.length === 1 || (n.length > 1 && n[0].n >= 2 && n[0].n >= 2 * n[1].n)) return [n[0].name];
  return n.map((x) => x.name);
}

// Every other project the line names by one of its topics or a long word of its own name ("the
// licence for the data dividend" names two): a line about two projects gets all the notes.
function mentioned(notes, t) {
  return notes.projects.filter((p) => [...(p.topics || []).filter((w) => w.length >= 4 && !NOT_NAMES.has(String(w).toLowerCase())),
    ...String(p.name).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5 && !NOT_NAMES.has(w.toLowerCase()))]
    .some((w) => hasWord(t, w))).map((p) => p.name);
}

const CLOSE = 0.03;   // two projects this close in meaning: no single one, so all the notes

/**
 * What a line is, before any model: null (not a project line), { list: 'waiting_on_you' | 'you_wait_on' },
 * or { why, hits, waitingHit } where hits are the names of the projects it points at.
 * meaning(text) is async and gives [{ project, score }] (best score per project), or null.
 */
export async function routeProject(notes, text, { meaning, MEANING = 0.78, skipEveryday = true } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length > 300 || !notes?.projects?.length) return null;
  if (WAITING_ON_ME.test(t)) return { list: 'waiting_on_you' };
  if (I_WAIT_ON.test(t)) return { list: 'you_wait_on' };
  if (!QUESTION.test(t)) return null;
  if (SELF_NOW.test(t)) return null;
  const waitingLines = [...(notes.waiting_on_owner || []), ...(notes.owner_waiting_on || [])];
  const names = namesIn(notes).filter((w) => !NOT_NAMES.has(w.toLowerCase()) && hasWord(t, w));
  const also = mentioned(notes, t);
  if (names.length) {
    return { why: `name:${names[0]}`, hits: [...new Set([...names.flatMap((w) => ownersOf(notes, w)), ...also])],
      waitingHit: names.some((w) => waitingLines.some((l) => hasWord(l, w))) };
  }
  // A project's own thing said as ours or the one ("the screens", "our battery", "did we pay for the
  // screens"), but never his own phone's ("my battery", "the phone battery").
  if (!/\b(?:my|phone|phone's|laptop|computer|car's)\b/i.test(t)) {
    for (const p of notes.projects) {
      const hit = (p.topics || []).find((w) => w.length >= 3 && !NOT_NAMES.has(w) && new RegExp(`\\b(?:the|our|those|these)\\s+${esc(w)}\\b`, 'i').test(t));
      if (hit) return { why: `topic:${hit}`, hits: [...new Set([p.name, ...also])], waitingHit: false };
    }
  }
  if ((skipEveryday && clearlyNotProject(t)) || !meaning) return null;
  const scores = await meaning(t);
  if (!scores?.length) return null;
  const best = Math.max(...scores.map((x) => x.score));
  if (best < MEANING) return null;
  return { why: `meaning:${best.toFixed(2)}`, hits: [...new Set([...scores.filter((x) => x.score >= best - CLOSE).map((x) => x.project), ...also])], waitingHit: false };
}

/** The notes the answer reads: one project (plus the waiting lists when about waiting), else all. */
export function focusNotes(notes, text, route) {
  const hits = [...new Set(route?.hits || [])];
  if (hits.length !== 1) return { notes, scope: 'all' };
  const p = notes.projects.find((x) => x.name === hits[0]);
  if (!p) return { notes, scope: 'all' };
  const waiting = !!route.waitingHit || ABOUT_WAITING.test(String(text || ''));
  return {
    notes: { ...notes, projects: [p], waiting_on_owner: waiting ? notes.waiting_on_owner || [] : [], owner_waiting_on: waiting ? notes.owner_waiting_on || [] : [] },
    scope: waiting ? 'one+waiting' : 'one',
  };
}

export function renderNotes(n) {
  const out = [];
  if (n.waiting_on_owner?.length) out.push('WAITING ON YOU:', ...n.waiting_on_owner.map((l) => '- ' + l), '');
  if (n.owner_waiting_on?.length) out.push('YOU ARE WAITING ON:', ...n.owner_waiting_on.map((l) => '- ' + l), '');
  for (const p of n.projects || []) {
    out.push(`PROJECT: ${p.name}`, p.summary || '', ...(p.facts || []).map((f) => '- ' + f));
    for (const q of p.qa || []) out.push(`Q: ${q.q}`, `A: ${q.a}`);
    out.push('');
  }
  return out.join('\n');
}

export function answerPrompt(notes, q, writtenAt = notes.written_at) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return `Today is ${today}. You are ΠAN, the person's voice assistant. Answer from these project notes only (written ${writtenAt}). Only if the question is about something else entirely (the weather, the time, the news, his phone, a general question), reply with only: NOT_PROJECT
If it is about something in these notes, answer it, even when the notes lack the exact answer: then say you don't know that and give what the notes do say ("the notes don't give a deadline; filing is planned after December 22"). Never add anything the notes do not say. Answer the way you would say it out loud: one to three short sentences, the answer first, no lists, no markdown.

Project notes:
${renderNotes(notes)}

He asks: "${q}"
Your answer:`;
}
