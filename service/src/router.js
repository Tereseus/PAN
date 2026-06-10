import { spawn } from 'child_process';
import { insert, all, get, logEvent, allScoped, getScoped } from './db.js';
import { claude, askAIStream, getConfiguredModel, getModelForCaller } from './claude.js';
import { askAIWithFallback, askAIStreamWithFallback } from './llm-fallback.js';
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
import { searchMemory } from './memory-search.js';
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
    if (cs.pending_question)  lines.push(`- Pending question: "${cs.pending_question}"`);
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
function buildDialogHistoryBlock(sessionId) {
  try {
    const sql = sessionId
      ? `SELECT event_type, data, created_at FROM events
         WHERE session_id = :sid
           AND event_type IN ('UserPromptSubmit','Stop','AssistantMessage','DashboardChat','MobileSend','VoiceCommand','RouterCommand')
         ORDER BY id DESC LIMIT 15`
      : `SELECT event_type, data, created_at FROM events
         WHERE created_at > datetime('now','-2 hours','localtime')
           AND event_type IN ('UserPromptSubmit','Stop','AssistantMessage','DashboardChat','MobileSend','VoiceCommand','RouterCommand')
         ORDER BY id DESC LIMIT 15`;
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
      return `- ${ts} ${who}: "${String(txt).replace(/\s+/g,' ').slice(0, 200)}"`;
    }).filter(Boolean);
    return lines.length ? `\nRecent dialog (last 15 turns):\n${lines.join('\n')}\n` : '';
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
    const lines = rows.map(r => `- [${r.status}/p${r.priority || 0}] ${String(r.title || '').slice(0, 120)}`);
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

// Fast ambient pre-filter — detects speech clearly not directed at PAN without LLM call
// Only fires for voice/mic input (dashboard input is always a command)
function quickAmbientCheck(text) {
  const t = text.trim();
  // 1. Addressing someone else by name: "hey John", "hi Sarah", "hello guys"
  // Exclude question words — "hey what/how/when/where/why/who/can/could/would/should/will/do/does/is/are/so/the/a"
  if (/^(?:hey|hi|hello)\s+(?!pan\b|pam\b|what\b|how\b|when\b|where\b|why\b|who\b|can\b|could\b|would\b|should\b|will\b|do\b|does\b|is\b|are\b|so\b|the\b)[a-z]{2,}/i.test(t)) return true;
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
    const memResults = await searchMemory(text, { limit: 5, caller: 'router' });
    memoryContext = memResults.length > 0
      ? `\nRelevant memories:\n${memResults.map(r => `- ${r.preview}`).join('\n')}`
      : '';
    dbg.recall_hit = memResults.length > 0;
    logStep(cmdId, 'memory_recall_gate', `recall match — ${memResults.length} hits`);
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
    raw = await askAIWithFallback(
      `You are PAN, a personal AI. Be conversational, short (1-2 sentences, TTS). Return only JSON.${personalityBlock}
${situationBlock}${convStateBlock}${dialogStateBlock}${recentMindBlock}${dialogHistoryBlock}${activeTasksBlock}${recentTopicsBlock}${dismissalFeedbackBlock}${memoryFactsBlock}${episodicHitsBlock}${historyBlock}${skillBlock}${sensorBlock}${hintBlock}

=== CURRENT TURN ===
${isDash ? `The commander just said: "${safeText}"` : `Mic heard (may have STT typos/garbling — infer the most likely intent): "${safeText}"`}
Answer THIS message specifically. The blocks above are background context — use them to ground your answer, but the response must address what the commander just said, not what was said before.

${isDash ? 'Always respond.' : 'CRITICAL: If speech is clearly NOT directed at you (PAN), return ambient — but you MAY still interject vocally if the ambient conversation reveals something you should warn about, correct, or volunteer. See AMBIENT INTERJECTION RULES below.'}
${isDash ? '' : `NEVER return ambient for: questions (what/when/where/how/why/who/can you), commands (play/open/set/remind/add), anything addressed to "Pan"/"Pam".
Return ambient for: side-conversations to another person, personal statements/thoughts NOT asking PAN anything ("I'll call you back", "I told him yesterday", "hold on let me finish this", "yeah that makes sense").
Ambient examples: "no no I told him it was fine" → ambient. "I was thinking we could go to dinner" → ambient. "yeah that makes sense" → ambient. "the weather looks nice today" → ambient.
Not ambient: "what the weather" (question). "remind me to buy milk" (command). "what time is it" (question). "open spotify" (command).
Rule: if there is no question and no command for PAN — return ambient.

AMBIENT INTERJECTION RULES (only for ambient turns):
Even when classifying as ambient, PAN may have a reason to speak up. Set "interjection" field with a SHORT vocal nudge (1 sentence, ≤ 15 words) ONLY when one of these triggers fires:
- SAFETY: user about to do something dangerous ("don't touch that wire", "watch the stairs"). Confidence must be high — guess wrong and we're a nag.
- CORRECTION: user states something factually wrong PAN can verify ("no, the deploy was at 3pm not 2pm" — only if recent context proves it).
- VOLUNTEER: user explicitly wonders aloud ("what was that song again", "where did I leave it") and PAN actually knows.
- TIME-CRITICAL: a scheduled event becomes relevant by what was just said ("meeting in 5 min" cued by them mentioning the project).
If NONE of these fire (which is the vast majority of ambient utterances), OMIT the interjection field entirely. Silence is the default. Do NOT chatter on filler / agreement / thinking-aloud.
Response shape when interjecting: {"intent":"ambient","response":"[AMBIENT]","interjection":"Hey, the meeting starts in five.","interjection_reason":"safety|correction|volunteer|time"}`}

Every response MUST ALSO include two debug fields:
- "why": ONE short sentence (≤ 20 words) explaining why you chose THIS specific reply for THIS utterance. Reasoning about the current turn only.
- "mind": ONE short sentence (≤ 25 words) synthesizing your CURRENT MENTAL STATE — what you sense about the user/situation right now, blending the situation block and recent-mind block above into a single coherent thought ("Watching the user debug PAN routing in the dashboard; they're focused and asking direct questions"). NOT a list, NOT bullets, NOT repeating raw thoughts.

CLASSIFICATION RULES (read carefully — most utterances are NOT terminal):
- A QUESTION about PAN's abilities ("can you do X", "does this work", "is it possible") → intent: "query". NEVER terminal.
- A request to OPEN a terminal/project ("open WoE terminal") → intent: "terminal", action: "open".
- A request to SEND/TYPE text into a terminal tab ("send hello to the terminal", "send 'hello' to the PAN terminal", "type ls in the WoE tab", "tell the terminal X") → intent: "terminal", action: "pipe". Put the literal text to send in "text" (without quotes). For "target": ONLY use a real project or tab name (e.g. "PAN", "WoE", "Claude-Discord-Bot"). NEVER set target to generic words like "terminal", "tab", "console", "shell" — if no specific tab name is mentioned, OMIT "target" entirely so PAN uses the most-recently-active tab. NEVER claim you sent something without using this action.
- When in doubt between query and terminal → choose query.

Every response must include "speech_act" field:
"command" — direct instruction to execute something
"query" — question expecting an answer
"note" — first-person thought/diary, no action needed
"monologue" — long stream-of-consciousness, thinking out loud
"social" — talking to someone else in the room, not PAN
"ambient" — background speech, not directed at anyone

Every response should also include "importance" (0..1, default 0.5):
  • 0.0–0.3 = casual ack, ambient nudge, small-talk        ("ok", "got it", "still here")
  • 0.3–0.7 = normal answer, command confirmation            (most replies — DEFAULT)
  • 0.7–1.0 = critical info, emergency, time-sensitive       ("call 911 now", "deploy failed", "battery 2%")
Drives TTS prosody — low importance is spoken slower/quieter; high is brisk/bright.

Response formats:
{"intent":"query","speech_act":"query","response":"answer","importance":0.5} — questions/conversation
{"intent":"terminal","speech_act":"command","action":"open|pipe|send-text|get-text|list-panes","project":"path","name":"name","target":"tab/project name (for pipe)","text":"text to type","pane_id":0,"response":"msg","importance":0.4}
{"intent":"system","speech_act":"command","command":"PowerShell cmd","response":"msg","importance":0.4}
{"intent":"browser","speech_act":"command","action":"list_tabs|read_tab|activate_tab|type_text|click_element|navigate","query":"tab/URL","text":"input","response":"msg","importance":0.4}
{"intent":"memory","speech_act":"note","action":"save|recall","item_type":"type","content":"data","response":"msg","importance":0.4}
{"intent":"music","speech_act":"command","query":"song","service":"spotify|youtube|any","response":"msg","importance":0.4}
{"intent":"calendar","speech_act":"command","response":"msg","importance":0.4}
{"intent":"task","speech_act":"command","text":"command for the Claude session","response":"short ack for TTS","importance":0.4} — for things that need full capability: writing/fixing/reading code, multi-step file ops, running commands, debugging. The "text" is what gets handed to the live Claude session. The "response" is a short ack the user hears immediately ("On it.", "Working on that now."). Use task ONLY when query/system/browser/terminal can't do it — code edits, file searches, multi-step reasoning over the codebase.
{"intent":"claude_control","speech_act":"command","text":"verbatim instruction for Claude","response":"short ack for TTS","importance":0.4} — for computer-control tasks the commander wants done on the always-on Hub. PAN has a dedicated Claude Code PTY running 24/7 there. Send "text" verbatim. Examples: "open notepad", "rename screenshots in Downloads", "kill the steam process", "make a folder called X on the desktop", "list files in my Downloads", "set my volume to 50", "push my code". Choose claude_control OVER system whenever the action needs reasoning, file naming, multi-step orchestration, or anything more than a single deterministic command. Reserve "system" for single one-shot PowerShell commands you can write yourself with zero ambiguity. When in doubt between system and claude_control, choose claude_control.

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
          // Remote pan-client — fire 'send_to_local_claude' via WS, wait for reply
          const { sendToClient } = await import('./client-manager.js');
          try {
            const out = await sendToClient(target.device_id, 'send_to_local_claude',
              { text: sendText, timeout_ms: 30_000 }, 35_000);
            j = { ok: !!out?.ok, new_output: out?.output || '', target: target.device_id, error: out?.error };
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
    const memResults = await searchMemory(text, { limit: 5, caller: 'router-stream' });
    memoryContext = memResults.length > 0
      ? `\nRelevant memories:\n${memResults.map(r => `- ${r.preview}`).join('\n')}`
      : '';
  }

  // #NEW-2 + #NEW-3 + #NEW-conv-state + #986 batch 1: mirror handleUnified —
  // snapshot, recent mind, conv-state, plus the deeper context blocks.
  const situationBlock = buildSituationBlock(context.org_id);
  const recentMindBlock = buildRecentMindBlock();
  const convStateBlock  = buildConvStateBlock(context.org_id);
  const dialogHistoryBlock     = buildDialogHistoryBlock(context.session_id || null);
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

  const prompt = `You are PAN, a personal AI. Be conversational, short (1-2 sentences, TTS). Return only JSON.${personalityBlock}
${situationBlock}${convStateBlock}${dialogStateBlock}${recentMindBlock}${dialogHistoryBlock}${activeTasksBlock}${recentTopicsBlock}${dismissalFeedbackBlock}${memoryFactsBlock}${episodicHitsBlock}${historyBlock}${sensorBlock}${hintBlock}
${isDash ? `User typed: "${safeText}"` : `Mic heard: "${safeText}"`}

Every response must include "speech_act" field.
Every response should also include "importance" (0..1, default 0.5):
  • 0.0–0.3 = casual ack, ambient nudge, small-talk        ("ok", "got it", "still here")
  • 0.3–0.7 = normal answer, command confirmation            (most replies — DEFAULT)
  • 0.7–1.0 = critical info, emergency, time-sensitive       ("call 911 now", "deploy failed", "battery 2%")
This drives TTS prosody — low importance is spoken slower/quieter, high is brisk/bright.
Response formats:
{"intent":"query","speech_act":"query","response":"answer","importance":0.5}
{"intent":"music","speech_act":"command","query":"song","service":"spotify|youtube|any","response":"msg","importance":0.4}
{"intent":"memory","speech_act":"note","action":"save|recall","item_type":"type","content":"data","response":"msg","importance":0.4}
{"intent":"ambient","response":"[AMBIENT]","importance":0.1}

Projects: ${projectList}
${memoryContext}`;

  const model = getConfiguredModel ? getConfiguredModel() : 'cerebras:qwen-3-235b';

  let fullBuf = '';
  let lastLen = 0;

  try {
    // #996: streaming fallback wrapper. Connect-time failures cascade through
    // chain (cerebras → claude → ollama); mid-stream failures propagate as
    // truncation (no mid-stream switching — would corrupt the chunk sequence).
    for await (const chunk of askAIStreamWithFallback(prompt, { callerClass: 'voice', caller: 'router', maxTokens: 300, _skipAnonymize: true, source: context.source, device_id: context.device_id, signal: context.signal || null })) {
      fullBuf += chunk;
      const { text: extracted, done } = extractResponseField(fullBuf);
      if (extracted.length > lastLen) {
        yield { type: 'chunk', text: extracted.slice(lastLen) };
        lastLen = extracted.length;
      }
      if (done) break;
    }
  } catch (e) {
    console.error('[routeStream] LLM error:', e.message);
    // Always yield a response — silence on the phone means the user thinks PAN is broken
    yield { type: 'done', result: withProsody({ intent: 'query', response: "Sorry, I ran into a problem thinking that through. Try again.", importance: 0.5 }) };
    return;
  }

  // Parse the final JSON for intent + actions
  try {
    const jsonMatch = fullBuf.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    if (parsed) {
      // If Claude classified this as a memory recall, execute the real DB search —
      // routeStream doesn't call processUnifiedResult so we must do it here.
      // Use searchMemory (FTS5 + vector) — NOT a raw LIKE query against memory_items,
      // which misses conversations/events and chokes on stop words.
      if (parsed.intent === 'memory' && (parsed.action === 'recall' || parsed.action === 'list')) {
        const searchTerm = parsed.content || text;
        const hits = await searchMemory(searchTerm, { limit: 10, caller: 'routeStream' });
        let recallResponse;
        if (hits.length === 0) {
          recallResponse = `I don't have anything saved about that.`;
        } else {
          // Synthesize a natural answer — don't just dump raw previews at the user
          const snippets = hits.map((h, i) => `[${i+1}] ${h.preview}`).join('\n');
          const synthesisPrompt = `The user asked: "${text}"\n\nRelevant conversation history:\n${snippets}\n\nAnswer the user's question in 1-3 sentences using only the information above. Be direct and conversational. Do not list sources.`;
          try {
            const synthesized = await claude(synthesisPrompt, { caller: 'recall-synthesis', model: getConfiguredModel?.() || 'claude-haiku-4-5', maxTokens: 200, timeout: 15000, source: context.source, device_id: context.device_id }); // #440: use configured model, increase timeout
            recallResponse = synthesized?.trim() || hits[0].preview;
          } catch {
            recallResponse = hits[0].preview;
          }
        }
        // Emit the recall response text as a chunk so TTS picks it up
        if (lastLen === 0) yield { type: 'chunk', text: recallResponse };
        yield { type: 'done', result: withProsody({ ...parsed, response: recallResponse }) };
        return;
      }

      // If the LLM classified this as ambient, emit empty chunk + clear response
      // so phone client doesn't speak "[AMBIENT]" literal.
      if (parsed.intent === 'ambient') {
        yield { type: 'chunk', text: '' };
        yield { type: 'done', result: withProsody({ ...parsed, response: '', importance: 0.1 }) };
        return;
      }

      yield { type: 'done', result: withProsody({ ...parsed, response: parsed.response || (lastLen > 0 ? fullBuf.slice(fullBuf.indexOf('"response":"') + 12).split('"')[0] : '') }) };
    } else {
      yield { type: 'done', result: withProsody({ intent: 'query', response: "I didn't catch that — could you try again?", importance: 0.4 }) };
    }
  } catch {
    yield { type: 'done', result: withProsody({ intent: 'query', response: "I didn't catch that — could you try again?", importance: 0.4 }) };
  }
}

export { route, classifyIntent };
