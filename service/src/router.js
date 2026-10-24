import { spawn } from 'child_process';
import { insert, all, get, logEvent, allScoped, getScoped } from './db.js';
import { claude, askAIStream, getConfiguredModel, getModelForCaller } from './claude.js';
import { askAIWithFallback, askAIStreamWithFallback } from './llm-fallback.js';
import { buildToolBlocks } from './tools.js';
import { buildSelfBlock } from './self.js';
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
import { searchMemory, searchMemoryByDate, parseWhen, isReadablePreview } from './memory-search.js';
import { writeThought } from './thoughts.js';
import { noteMealMention } from './intuition/nourishment.js';
import { noteSignalsInUtterance } from './intuition/signals.js';
import { getCurrentSnapshot } from './intuition/index.js';
import { getConversationState } from './conv-state-watcher.js';
import { recentThoughts } from './intuition/mind.js';
import { planFromResult as planProsody } from './tts-prosody.js';

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
  'must','need','needed','once','only','other','over','plan','project','said','same','say','see',
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

// Build the situation block from the live intuition snapshot. Returns '' when
// no snapshot is available (boot-up, isolated tests). See task #745 (#NEW-2).
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
// router. Goal: ~5k tokens of grounded context per turn for ~250ms prefill
// cost on Cerebras Qwen 3 235B. See epic #986.

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
  if (/^[A-Z][a-z]+\s+I'(?:ll|m)\s+/i.test(t)) return true;
  // 5. Filler acknowledgement followed by "call/meet/be" — "ok I'll call you back"
  if (/^(?:ok|okay|alright|yeah|sure|cool|got\s*it)[,.]?\s+I'(?:ll|m)\s+/i.test(t)) return true;
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
  if (RECALL_RE.test(text)) {
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
  // dismissal feedback, memory facts, episodic hits. ~5k tokens total, ~250ms
  // prefill on Cerebras. All defensive: missing table → empty block.
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
    let personality = '';
    try {
      const row = get("SELECT value FROM settings WHERE key = 'personality'");
      if (row) personality = row.value.replace(/^"|"$/g, '').trim();
    } catch {}
    const personalityBlock = personality ? `\nPersonality: ${personality}\nAlways stay in character.` : '';
    // Anonymize user text ONLY — sensor data (GPS, etc.) must pass through
    // so location-aware queries work. The sensor block is structured data the
    // user consented to share; the text may contain unintentional PII.
    const safeText = anonymizeForAI(text);

    const hintBlock = context.intent_hint
      ? `\nOVERRIDE: Server pattern matched — your response MUST use {"intent":"${context.intent_hint}",...}. Do not use a different intent.\n`
      : '';
    dbg.ai_started_at = Date.now();
    // #996: route through fallback chain (cerebras → claude → ollama by default).
    // Honors `ai_fallback_enabled=false` for users who want single-backend semantics.
    const _fallbackMeta = {};
    let weatherBlock = '';
    try { weatherBlock = await buildToolBlocks(text, sensors); } catch {}
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
      try { noteMealMention(text || '', { source: context?.source || null, intent }); } catch {}
      try { noteSignalsInUtterance(text || '', { source: context?.source || null, intent }); } catch {}
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
      if (context?.source && /benchmark|regression/.test(context.source)) {
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
      // Cerebras decided this needs full capability (code, files, multi-step).
      // Fire-and-forget into a live PTY adapter; return immediate TTS ack.
      //
      // Benchmark/test sources must NEVER touch a real user session — they would
      // inject messages into the active terminal, cost money, and corrupt history.
      if (context?.source && /benchmark|regression/.test(context.source)) {
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
        insert(`INSERT INTO memory_items (item_type, content, context, confidence, classified_at, org_id)
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
      insert(`INSERT INTO memory_items (item_type, content, context, confidence, classified_at, org_id)
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
  learnCorrection(last.action_type, targetDevice, targetApp, context.org_id || 'org_personal', context.user_id || null);

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

// De-dupe latch for voice/router-turn failure alerts. When every AI backend
// cascade-fails (Cerebras → Claude → local Ollama all error), routeStream still
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
      detail: `A ${source || 'voice'} turn could not be answered: every configured backend (Cerebras → Claude → local Ollama) failed to produce a response. Error: ${reason}. PAN replied with a fallback message.`,
    });
  } catch (e) {
    console.warn('[routeStream] Could not raise voice_failed alert:', e.message);
  }
}

export async function* routeStream(text, context = {}) {
  // Batch 4 (#986): every `done` emit gets a prosody plan derived from
  // `result.importance`. Wrap once, use everywhere — keeps the diff small
  // and guarantees consumers always see a `prosody` field.
  const withProsody = (result) => ({ ...result, prosody: planProsody(result) });

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

  // Ambient pre-filter — emit dedicated 'ambient' chunk (not [AMBIENT] literal)
  // so phone client can silently drop without TTS, no embed/LLM round-trip needed.
  const isVoice = context.source === 'voice' || context.source === 'mic' || context.source === 'phone';
  if (isVoice && quickAmbientCheck(text)) {
    yield { type: 'chunk', text: '' };
    yield { type: 'done', result: withProsody({ intent: 'ambient', response: '', importance: 0.1 }) };
    return;
  }

  // Build the same prompt handleUnified builds, then stream it
  const projects = allScoped(null, "SELECT name, path FROM projects WHERE org_id = :org_id ORDER BY name");
  const projectList = projects.map(p => `- ${p.name}: ${p.path.replace(/\//g, '\\')}`).join('\n');

  // #NEW-1: intent-gated memory lookup (mirror of handleUnified). Pure
  // conversation never touches FTS5/vector; only explicit recall sniff does.
  let memoryContext = '';
  if (RECALL_RE.test(text)) {
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
    try {
      if (when) {
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
    } else if (when || OWN_HISTORY_RE.test(text)) {
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
      const nothing = when
        ? (subjectTerms.length
            ? `I don't have anything recorded about ${subjectTerms[0]} from ${when.label}.`
            : `I don't have anything recorded from ${when.label}.`)
        : `I don't have anything saved about that.`;
      console.log(`[routeStream] no readable memory for a past-question — answering honestly without the model: ${JSON.stringify(text.slice(0, 60))}`);
      yield { type: 'chunk', text: speakable(nothing) };
      yield { type: 'done', result: withProsody({ intent: 'memory', action: 'recall', response: nothing, addressed: 1, importance: 0.4 }) };
      return;
    } else {
      const what = when ? `from ${when.label}` : `about that`;
      memoryContext = `\nMEMORY SEARCH FOUND NOTHING ${what.toUpperCase()}.`
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

  const historyBlock = context.conversation_history
    ? `\nRecent conversation:\n${context.conversation_history}\n` : '';

  let sensorBlock = '';
  const sensors = context.sensors || null;
  if (sensors) {
    const parts = [];
    const phone = sensors.phone || {};
    if (phone.gps) { const addr = phone.gps.address ? ` (${phone.gps.address})` : ''; parts.push(`Location: ${phone.gps.lat?.toFixed(5)}, ${phone.gps.lng?.toFixed(5)}${addr}`); }
    if (phone.compass != null) parts.push(`Compass: ${Math.round(phone.compass)}°`);
    if (parts.length > 0) sensorBlock = `\nUser's current sensor readings: ${parts.join(' | ')}\n`;
  }

  let personality = '';
  try { const row = get("SELECT value FROM settings WHERE key = 'personality'"); if (row) personality = row.value.replace(/^"|"$/g, '').trim(); } catch {}
  const personalityBlock = personality ? `\nPersonality: ${personality}\nAlways stay in character.` : '';

  const hintBlock = context.intent_hint
    ? `\nOVERRIDE: Server pattern matched — your response MUST use {"intent":"${context.intent_hint}",...}.\n` : '';

  const safeText = anonymizeForAI(text);
  const isDash = context.source === 'dashboard';

  // Real forecast data when the question is about weather. Returns an empty
  // string for anything else, when GPS is unknown, or if the API is slow - it
  // has a hard 3s timeout because this runs inline on a voice turn.
  let weatherBlock = '';
  try { weatherBlock = await buildToolBlocks(text, sensors); } catch {}
  // selfBlock is 1030 chars describing which model is running, what is
  // local, what leaves the house. It is the right answer to "how do you
  // work" / "is this private" and dead weight on every other turn, which
  // is most of them. Gate it on the question instead of paying for it
  // always - it is a live read, so nothing goes stale by being skipped.
  let selfBlock = '';
  try {
    const _self = buildSelfBlock();
    if (/\b(model|models|local|locally|offline|cloud|private|privacy|secure|encrypt|how do you work|how you work|what are you running|your config|leave the house|sent anywhere|listening)\b/i.test(String(text || ''))) {
      selfBlock = _self;
    } else {
      // One line, always. Dropping the block entirely made PAN invent its own
      // privacy state - asked how it was doing it said "still running on local
      // iron instead of melting in the cloud" while it was on Gemini. That is
      // the one thing it must never guess about, so the model line stays for
      // ~120 chars and the other ~900 only load when actually asked.
      const _line = (_self.split('\n').find(l => /conversation model/i.test(l)) || '').trim();
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
${memoryFactsBlock}${activeTasksBlock}${recentTopicsBlock}${dismissalFeedbackBlock}${dialogHistoryBlock}${historyBlock}${situationBlock}${convStateBlock}${dialogStateBlock}${recentMindBlock}${episodicHitsBlock}${sensorBlock}${weatherBlock}${selfBlock}${hintBlock}
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

  const model = getConfiguredModel ? getConfiguredModel() : 'cerebras:qwen-3-235b';

  let fullBuf = '';
  // lastLen is what has actually been SPOKEN; held is what has been extracted.
  // They used to be the same number - the gate is the reason they are not.
  let lastLen = 0;
  let held = '';
  let gate = null;      // null = undecided, so early words are buffered not spoken
  let sawEnd = false;   // response string closed; keep reading for the tail
  let addressed = null;

  try {
    // #996: streaming fallback wrapper. Connect-time failures cascade through
    // chain (cerebras → claude → ollama); mid-stream failures propagate as
    // truncation (no mid-stream switching — would corrupt the chunk sequence).
    for await (const chunk of askAIStreamWithFallback(prompt, { callerClass: 'voice', caller: 'router', maxTokens: 300, _skipAnonymize: true, source: context.source, device_id: context.device_id, signal: context.signal || null })) {
      fullBuf += chunk;
      if (gate === null) {
        const d = readAddressGate(fullBuf);
        if (d) { gate = d.gate; addressed = d.addressed; }
      }
      const { text: extracted, done } = extractResponseField(fullBuf);
      // Keep the text even while muted: the looksDirectedAtPan veto below can
      // still overrule the model, and it needs something to say.
      if (extracted.length > held.length) held = extracted;
      // A word already out of the speaker cannot be taken back; a held one
      // costs nothing. So nothing is emitted until the gate opens.
      if (gate === 'open' && held.length > lastLen) {
        // lastLen still advances by the RAW length, so the stream position stays
        // correct; only what gets spoken is filtered.
        const delta = speakable(held.slice(lastLen));
        lastLen = held.length;
        if (delta) yield { type: 'chunk', text: delta };
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
    }
  } catch (e) {
    console.error('[routeStream] LLM error:', e.message);
    // Surface the broken voice path in the Alerts panel (de-duped, fire-and-forget).
    _raiseVoiceAlert(e.message, context.source);
    // Always yield a response — silence on the phone means the user thinks PAN is broken
    yield { type: 'done', result: withProsody({ intent: 'query', response: "Sorry, I ran into a problem thinking that through. Try again.", importance: 0.5 }) };
    return;
  }

  // Parse the final JSON for intent + actions
  try {
    const jsonMatch = fullBuf.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (parsed) {
      // Veto a wrong 'ambient' on an utterance that is obviously a question
      // or a command. See looksDirectedAtPan for why this is not left to the model.
      if (parsed.intent === 'ambient' && looksDirectedAtPan(text)) {
        console.warn('[routeStream] ambient -> query override: ' + String(text).slice(0, 70));
        parsed.intent = 'query';
        // A question mark or a question word is a harder signal than the
        // model's own confidence, so it reopens the gate too. `held` was
        // kept through the mute for exactly this.
        gate = 'open';
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
        let hits = [];
        try {
          if (when) {
            hits = searchMemoryByDate({ from: when.from, to: when.to, limit: 25 });
            console.log(`[routeStream] recall scoped to ${when.label} (${when.from} .. ${when.to}) — ${hits.length} readable events`);
          } else {
            // VECTORS STAY ON for an explicit recall. skipVector was applied to
            // every caller to stop the 4-6s synchronous vec0 scan freezing the
            // hub; right for the per-turn pre-gate, wrong here. FTS alone returns
            // the hook envelope ({"session_id":...}), the vector half returns what
            // he actually said. This path only runs when he explicitly asked to
            // remember something, so it is rare and worth the seconds.
            hits = await Promise.race([
              searchMemory(searchTerm, { limit: 10, caller: 'routeStream' }),
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
        yield { type: 'done', result: withProsody({ ...parsed, intent: 'ambient', response: '', addressed, importance: 0.1 }) };
        return;
      }
      if (gate === 'hold') {
        // The middle band, and the whole point of the number. Not sure enough
        // to talk over him, not sure enough to swallow a real question. Hand
        // the phone the words plus how long to sit on them: it speaks if the
        // room goes quiet and drops them if he carries on talking.
        // Same filter as the streamed path - this text is spoken too.
        const heldText = speakable(String(held || parsed.response || '')).trim();
        // A hold is only worth anything if there is something to say. When the
        // model decided ambient it writes the "[AMBIENT]" placeholder, and
        // holding a placeholder just delays silence - so treat that as a mute.
        if (!heldText || /^\[ambient\]$/i.test(heldText)) {
          yield { type: 'chunk', text: '' };
          yield { type: 'done', result: withProsody({ ...parsed, intent: 'ambient', response: '', addressed, importance: 0.1 }) };
          return;
        }
        console.log(`[routeStream] addressed=${addressed} — holding ${heldText.length} chars for ${ADDRESSED_HOLD_MS}ms`);
        yield { type: 'done', result: withProsody({ ...parsed, response: heldText, addressed, hold_ms: ADDRESSED_HOLD_MS, importance: 0.3 }) };
        return;
      }

      yield { type: 'done', result: withProsody({ ...parsed, addressed, response: parsed.response || (lastLen > 0 ? fullBuf.slice(fullBuf.indexOf('"response":"') + 12).split('"')[0] : '') }) };
    } else {
      yield { type: 'done', result: withProsody({ intent: 'query', response: "I didn't catch that — could you try again?", importance: 0.4 }) };
    }
  } catch {
    yield { type: 'done', result: withProsody({ intent: 'query', response: "I didn't catch that — could you try again?", importance: 0.4 }) };
  }
}

export { route, classifyIntent };
