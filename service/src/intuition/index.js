// PAN Intuition — the live situational state daemon.
//
// One source of truth for "what is Commander doing right now?" read by:
//   • PAN (voice/dispatcher) — resolves pronouns, picks agents
//   • Forge/AutoDev          — biases variant generation toward current topics
//   • Dashboard/Atlas        — live panel of the current snapshot
//
// Axes (from 2026-03-31 consciousness canon):
//   Direction, Urgency, Need, Social, Mood, Activity, Engagement, Complexity
//   + health, focus, recent_topics, last_heard, last_seen
// Plus a slow-moving `style` block (voice tone, decision speed, reply length).
//
// v1 is DUMB aggregation: pulls recent events/wrap_messages/sensors into a
// snapshot every ~30s (and on sensor events). Intelligence (Cerebras/Claude
// classification) gets layered in after the plumbing proves out.
//
// Storage:
//   intuition_snapshots  — append-only row per tick (for Atlas timeline + replay)
//   intuition.json       — current snapshot on disk for fast read by non-DB callers
//   GET /api/v1/intuition/current → {snapshot, as_of}

import fs from 'fs';
import path from 'path';
import http from 'http';
import { db, get, all } from '../db.js';
import { getLatestScreenContext, getLatestScreenContextFromDB } from '../screen-watcher.js';
import { getWebcamContext } from '../webcam-watcher.js';
import { writeThought, lastThoughtFor } from './mind.js';
import * as needs from './needs.js';
import { currentUserId } from './nourishment.js';
import { dispatchAction } from './action.js';
import { getConversationState, panSpokeWithin, dictatingToClaude, overheardWithin } from '../conv-state-watcher.js';
import { readHim } from './reader.js';
import { hisZone, localHour } from './time.js';

// In-memory snapshot of last intuition verdict — used to compute deltas and
// avoid restating the same conclusion every 60s. The intuition panel above
// already shows Commander's current state; this stream is supposed to be
// PAN's *decision loop*, not a duplicate readout.
let _lastVerdict = null;          // { focus, mood, urgency, assumption, ts }
let _unchangedStreak = 0;         // # consecutive ticks with no change
// Last interjection deliberation result — used to dedupe by candidate identity
// rather than time. We re-evaluate every tick (event-driven, per CLAUDE.md
// design rules), but only WRITE a thought when the verdict or top candidate
// flips. No 5-minute cooldown.
let _lastInterjectionKey = null;  // string like "act:nourishment" / "suppress:none"
// Lazy import — terminal server may not be initialized when intuition.js is first loaded.
// We call it at runtime (after first snapshot) so the WS server is always ready by then.
let _broadcast = null;
async function getBroadcast() {
  if (!_broadcast) {
    const { broadcastNotification } = await import('../terminal.js');
    _broadcast = broadcastNotification;
  }
  return _broadcast;
}

// ─── Config ───
const PAN_PORT = parseInt(process.env.PAN_CARRIER_PORT || '7777');
const INTUITION_TICK_MS = 60 * 1000;                // passive heartbeat (was 30s)
const INTUITION_FILE = path.join(
  process.env.LOCALAPPDATA || process.env.HOME || '.',
  'PAN', 'data', 'intuition.json'
);
const RECENT_EVENT_LIMIT = 20;
const RECENT_WRAP_LIMIT = 10;

// ─── Runtime state ───
let _tickTimer = null;
let _running = false;
let _lastSnapshot = null;
let _writeErrors = 0;
let _cachedSessions = [];              // last known terminal sessions from Carrier
let _sessionFetchTime = 0;

// Fetch live PTY sessions from Carrier (non-blocking, uses cache if recent)
function fetchLiveSessions() {
  const CACHE_MS = 10000;
  if (Date.now() - _sessionFetchTime < CACHE_MS) return;
  const req = http.get(`http://127.0.0.1:${PAN_PORT}/api/v1/terminal/sessions`, { timeout: 2000 }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        const sessions = Array.isArray(data) ? data : (data.sessions || []);
        _cachedSessions = sessions;
        _sessionFetchTime = Date.now();
      } catch {}
    });
  });
  req.on('error', () => {});
  req.end();
}

// ─── Schema ───
export function ensureIntuitionSchema(database) {
  const d = database || db;
  d.exec(`
    CREATE TABLE IF NOT EXISTS intuition_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commander TEXT NOT NULL,
      as_of INTEGER NOT NULL,
      trigger TEXT,
      snapshot TEXT NOT NULL,
      confidence REAL DEFAULT 0,
      source_count INTEGER DEFAULT 0,
      org_id TEXT DEFAULT 'org_personal'
    );
    CREATE INDEX IF NOT EXISTS idx_intuition_as_of ON intuition_snapshots(as_of DESC);
    CREATE INDEX IF NOT EXISTS idx_intuition_commander ON intuition_snapshots(commander, as_of DESC);

    CREATE TABLE IF NOT EXISTS org_intuition_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT NOT NULL DEFAULT 'org_personal',
      as_of INTEGER NOT NULL,
      trigger TEXT,
      snapshot TEXT NOT NULL,
      member_count INTEGER DEFAULT 0,
      device_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_org_intuition_as_of ON org_intuition_snapshots(org_id, as_of DESC);

    CREATE TABLE IF NOT EXISTS device_presence (
      device_id TEXT PRIMARY KEY,
      user_id   TEXT,
      activity  TEXT,
      screen_title TEXT,
      confidence INTEGER DEFAULT 0,
      platform  TEXT,
      as_of     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_device_presence_as_of ON device_presence(as_of DESC);
  `);

  // Migrate existing intuition_snapshots tables that predate the org_id column
  const migrations = [
    `ALTER TABLE intuition_snapshots ADD COLUMN org_id TEXT DEFAULT 'org_personal'`,
  ];
  for (const sql of migrations) {
    try { d.exec(sql); } catch {} // ignore "duplicate column" on fresh DBs
  }

  // org_id index must come after the migration in case the column was just added
  try {
    d.exec(`CREATE INDEX IF NOT EXISTS idx_intuition_org ON intuition_snapshots(org_id, as_of DESC)`);
  } catch {}
}

// ─── Device Presence ───
// Called by POST /api/v1/client/presence — upserts one row per device.
export function upsertDevicePresence({ device_id, user_id, activity, screen_title, confidence, platform }) {
  if (!device_id) return;
  try {
    db.prepare(`
      INSERT INTO device_presence (device_id, user_id, activity, screen_title, confidence, platform, as_of)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        user_id = excluded.user_id,
        activity = excluded.activity,
        screen_title = excluded.screen_title,
        confidence = excluded.confidence,
        platform = excluded.platform,
        as_of = excluded.as_of
    `).run(device_id, user_id || null, activity || null, screen_title || null, confidence || 0, platform || null, Date.now());
  } catch (e) {
    console.warn('[DevicePresence] upsert failed:', e.message);
  }
}

// ─── Helpers ───
function titleCase(str) {
  if (!str) return str;
  return str.replace(/(^|\s)\S/g, c => c.toUpperCase());
}

// Filter out system/XML messages that aren't real conversation
function isRealMessage(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.startsWith('<')) return false;              // XML/HTML tags
  if (t.startsWith('task-notification')) return false;
  if (t.includes('<task-id>')) return false;
  if (t.includes('<tool-use-id>')) return false;
  if (t.includes('<output-file>')) return false;
  if (t.includes('<system-reminder>')) return false;
  if (t.length < 3) return false;                   // too short to be meaningful
  return true;
}

// ─── Identity ───
// Commander's name lives in the `users` table (synced from the `display_name`
// setting by /api/v1/org/current). Nickname is what they want to be called in
// speech; falls back to display_name, then the `display_name` setting, then
// a hard-coded "Commander".
function getCommanderIdentity() {
  try {
    const u = get("SELECT display_nickname, display_name FROM users WHERE id = 1");
    const name = u?.display_nickname || u?.display_name;
    if (name) return name;
  } catch {}
  try {
    const row = get("SELECT value FROM settings WHERE key = 'display_name'");
    if (row?.value) return String(row.value).replace(/^"|"$/g, '') || 'Commander';
  } catch {}
  return 'Commander';
}

// ─── Known PAN feature keywords ───
// Maps conversation keywords to clean feature/concept names.
// v2 will replace this with Cerebras classification.
const TOPIC_KEYWORDS = {
  'intuition': 'intuition system',
  'dashboard': 'dashboard ui',
  'pendant': 'pendant hardware',
  'discord': 'discord integration',
  'wrapper': 'app wrappers',
  'tauri': 'desktop shell',
  'steward': 'steward services',
  'memory': 'memory pipeline',
  'dream': 'dream cycle',
  'forge': 'forge / autodev',
  'voice': 'voice pipeline',
  'router': 'command router',
  'carrier': 'carrier architecture',
  'craft': 'craft swap',
  'terminal': 'terminal sessions',
  'agent': 'agent system',
  'onboarding': 'onboarding / installer',
  'qr': 'qr onboarding',
  'wellbeing': 'assumption / wellbeing',
  'assumption': 'assumption / wellbeing',
  'mood': 'mood detection',
  'sensor': 'sensor data',
  'camera': 'camera / vision',
  'phone': 'phone integration',
  'preference': 'messaging preferences',
  'whisper': 'speech-to-text',
  'atlas': 'atlas knowledge graph',
  'scout': 'scout / cerebras',
  'installer': 'installer / distribution',
};

// A keyword counts at the start of a word only: as a plain substring, "qr" or "craft" inside
// another word made the focus jump to "QR onboarding" between two ticks (2026-11-03).
const TOPIC_KEYWORD_RES = Object.fromEntries(Object.keys(TOPIC_KEYWORDS).map((k) => [k, new RegExp(`\\b${k}`)]));

// Extract a clean topic from conversation messages.
// Uses keyword matching against known PAN concepts, falls back to project context.
function extractTopic(messages, projectName) {
  if (!messages || messages.length === 0) {
    return projectName ? `${projectName.toLowerCase()} development` : null;
  }

  const blob = messages.slice(0, 3)
    .map(m => (m.content || '').toLowerCase())
    .join(' ');

  // Check for known PAN feature keywords (most specific wins)
  const hits = [];
  for (const [keyword, topic] of Object.entries(TOPIC_KEYWORDS)) {
    if (TOPIC_KEYWORD_RES[keyword].test(blob)) hits.push(topic);
  }

  // Deduplicate and take top 2
  const unique = [...new Set(hits)].slice(0, 2);
  if (unique.length > 0) return unique.join(', ');

  // Fallback: project context
  return projectName ? `${projectName.toLowerCase()} development` : null;
}

// ─── Build a snapshot from raw signals ───
// v1.5: smart aggregation. Reads ALL available signals and REASONS about them
// instead of just dumping raw rows. Each axis uses the best signal available.
function buildSnapshot(trigger = 'heartbeat') {
  const now = Date.now();
  const commander = getCommanderIdentity();
  // His hour, not the hub's: the hub keeps his job's time zone (time.js).
  const zone = hisZone();
  const hour = localHour(now, zone.tz);
  const FIVE_MIN = 5 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  // ─── Raw signal collection ───

  // Recent events (last ~40 for more context)
  let recentEvents = [];
  try {
    recentEvents = all(`
      SELECT id, event_type, session_id, data, created_at
      FROM events ORDER BY id DESC LIMIT 40
    `);
  } catch {}

  // Recent wrapper messages (cross-app chat)
  let recentWrap = [];
  try {
    recentWrap = all(`
      SELECT service, author, text, channel_id, received_at
      FROM wrap_messages WHERE text IS NOT NULL
      ORDER BY received_at DESC LIMIT ${RECENT_WRAP_LIMIT}
    `);
  } catch {}

  // Active PTY sessions from Carrier (live, not from DB)
  // Kick off a background fetch so next tick has fresh data
  fetchLiveSessions();
  const panSessions = _cachedSessions
    .filter(s => s.claudeRunning || s.clients > 0)
    .map(s => ({
      id: s.id,
      model: s.model || 'unknown',
      project: s.project || null,
      started: s.createdAt,
      thinking: s.thinking || false,
      claudeRunning: s.claudeRunning || false,
      clients: s.clients || 0,
    }));

  // Active tasks
  let activeTasks = [];
  try {
    const rows = all(`
      SELECT id, title, status, priority FROM tasks
      WHERE status IN ('todo', 'in_progress')
      ORDER BY priority DESC, id DESC LIMIT 10
    `);
    activeTasks = rows.map(r => ({
      id: r.id, title: r.title, status: r.status, priority: r.priority,
    }));
  } catch {}

  // Recent terminal messages — what Commander is actually saying to PAN right now.
  // Source: UserPromptSubmit events. Data shape: { prompt, cwd, session_id }
  let recentTerminalMsgs = [];
  try {
    const promptRows = all(`
      SELECT data, session_id, created_at FROM events
      WHERE event_type = 'UserPromptSubmit'
      ORDER BY id DESC LIMIT 5
    `);
    for (const r of promptRows) {
      try {
        const d = JSON.parse(r.data);
        if (d.prompt || d.text) {
          recentTerminalMsgs.push({
            content: d.prompt || d.text || '',
            session_id: d.session_id || r.session_id,
            cwd: d.cwd || null,
            created_at: r.created_at,
          });
        }
      } catch {}
    }
  } catch {}

  // What he said to PAN out loud: the RouterCommand rows /query/stream writes for turns PAN
  // answered (source 'phone-voice'). Voice never reached Intuition before 2026-11-03, so
  // "last heard" was always a Claude Code prompt and "where" said the hub while he talked
  // to his phone.
  let recentVoiceMsgs = [];
  try {
    const rows = all(`SELECT data, created_at FROM events WHERE event_type = 'RouterCommand' ORDER BY id DESC LIMIT 5`);
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data);
        if (d.source === 'phone-voice' && d.text) {
          recentVoiceMsgs.push({ content: d.text, reply: d.result || '', place: d.place || null, created_at: r.created_at });
        }
      } catch {}
    }
  } catch {}

  // ─── PAN self-awareness: what are PAN's own systems doing? ───
  let stewardServices = [];
  let recentPanActions = [];
  try {
    // Get latest steward heartbeat for service health
    const hb = all(`
      SELECT data FROM events WHERE event_type = 'StewardHeartbeat'
      ORDER BY id DESC LIMIT 1
    `);
    if (hb.length > 0) {
      try {
        const d = JSON.parse(hb[0].data);
        if (Array.isArray(d.services)) {
          // Array of { id, status, lastCheck, lastError }
          stewardServices = d.services.map(s => ({
            name: s.id || s.name || 'unknown',
            status: s.status || 'unknown',
          }));
        } else if (d.services && typeof d.services === 'object') {
          // Object keyed by name
          stewardServices = Object.entries(d.services).map(([name, info]) => ({
            name, status: (typeof info === 'string' ? info : info.status) || 'unknown',
          }));
        }
      } catch {}
    }
  } catch {}

  try {
    // Recent PAN actions — what did PAN itself just do?
    const actions = all(`
      SELECT event_type, data, created_at FROM events
      WHERE event_type IN ('StewardAction', 'AssistantMessage', 'ToolUse', 'OrchestratorSummary', 'ConsolidationRun', 'EvolutionCycle', 'DreamCycle')
      ORDER BY id DESC LIMIT 10
    `);
    for (const a of actions) {
      try {
        const d = JSON.parse(a.data || '{}');
        let description = null;
        if (a.event_type === 'StewardAction') {
          const act = titleCase((d.action || 'action').replace(/_/g, ' '));
          description = `${act}: ${titleCase(d.service || 'service')}`;
        } else if (a.event_type === 'AssistantMessage') {
          const txt = (d.text || '').slice(0, 60);
          if (txt) description = `Replied: "${txt}${d.text?.length > 60 ? '...' : ''}"`;
        } else if (a.event_type === 'ToolUse') {
          description = `Used tool: ${d.tool || d.name || 'unknown'}`;
        } else if (a.event_type === 'ConsolidationRun') {
          description = 'Ran memory consolidation';
        } else if (a.event_type === 'EvolutionCycle') {
          description = 'Ran evolution cycle';
        } else if (a.event_type === 'DreamCycle') {
          description = 'Ran dream cycle';
        } else if (a.event_type === 'OrchestratorSummary') {
          description = 'Orchestrator completed';
        }
        if (description) {
          recentPanActions.push({ action: description, at: a.created_at });
        }
      } catch {}
    }
  } catch {}

  // ─── Derived signals ───

  // Active wrappers (what apps are open)
  const activeApps = new Set();
  for (const e of recentEvents) {
    if (e.event_type === 'WrapHeartbeat') {
      try { const d = JSON.parse(e.data); if (d.service) activeApps.add(d.service); } catch {}
    }
  }

  // Sensor presence
  const sensorsActive = new Set();
  for (const e of recentEvents) {
    if (e.event_type && e.event_type.toLowerCase().startsWith('sensor')) {
      try { const d = JSON.parse(e.data); if (d.sensor) sensorsActive.add(d.sensor); } catch {}
    }
  }

  // Device presence — figure out where Commander is interacting FROM. Unknown until an event
  // says: the hub is a headless mini PC, so defaulting to "at the hub" was always wrong.
  let lastDeviceSource = null;
  let lastDeviceTime = 0;
  for (const e of recentEvents) {
    try {
      const d = JSON.parse(e.data || '{}');
      const t = new Date(e.created_at).getTime() || 0;
      // Phone logs come with device_type or device_id containing 'phone'
      if (d.device_type === 'phone' || (d.device_id || '').includes('phone')) {
        if (t > lastDeviceTime) { lastDeviceSource = 'phone'; lastDeviceTime = t; }
      }
      // Dashboard/terminal hits are desktop
      if (e.event_type === 'TerminalMessage' || e.event_type === 'DashboardView') {
        if (t > lastDeviceTime) { lastDeviceSource = 'desktop'; lastDeviceTime = t; }
      }
    } catch {}
  }

  // A voice turn is the phone too, and the newest thing he did if it beats the rest.
  const newestVoice = recentVoiceMsgs[0] || null;
  const voiceTime = newestVoice ? (new Date(newestVoice.created_at).getTime() || 0) : 0;
  if (voiceTime > lastDeviceTime) { lastDeviceSource = 'phone'; lastDeviceTime = voiceTime; }

  // ─── WHERE — location inference ───
  // If interacting via localhost dashboard → at the hub (desktop computer)
  // If last event was phone → the place the phone gave with his last voice turn, or mobile
  // Pendant GPS will override when available
  let where = null;
  if (lastDeviceSource === 'desktop') {
    where = 'at the hub';
  } else if (lastDeviceSource === 'phone') {
    where = (newestVoice?.place && now - voiceTime < 30 * 60_000) ? newestVoice.place : 'mobile';
  }

  // ─── SCREEN CONTEXT — vision-based activity (highest priority signal) ───
  // Screen watcher captures a screenshot every 30s and runs it through vision AI.
  // In-memory cache first (fastest), DB fallback for first tick after restart.
  // Defense-in-depth: reject URN/UUID/URL-only descriptions that moondream
  // sometimes hallucinates. screen-watcher.js drops these at the source, but
  // older rows already in the DB can still be picked up by the fallback path.
  function isUsefulScreenDescription(desc) {
    if (!desc) return false;
    const trimmed = String(desc).trim();
    if (trimmed.length < 8) return false;
    if (/^(urn:|uuid:|cid:|did:|isbn:|oid:)/i.test(trimmed)) return false;
    if (/^https?:\/\/\S+$/i.test(trimmed)) return false;
    const wordChars = (trimmed.match(/[a-zA-Z]{3,}/g) || []).join('').length;
    if (wordChars < trimmed.length * 0.3) return false;
    return true;
  }
  // WORLD CONTEXT â€” what the user's CAMERA saw, as distinct from what is on
  // their screen. Fed by VisionAnalysis events, which is what /api/v1/vision and
  // the pendant photo endpoint write.
  //
  // Before this, camera frames reached memory and full-text search but never
  // reached intuition, so the wearable could not influence a single decision the
  // system made. That was the entire point of the wearable.
  //
  // Deliberately SEPARATE from screen_context rather than folded into it: the
  // screen says what he is working on, the camera says where he is and what is
  // physically around him. Collapsing them would let a photo of a ceiling
  // overwrite "building WoE" as the current activity.
  //
  // The staleness window is far longer than the screen's 240s. A screenshot is
  // stale the moment he changes window; where he physically is, is not.
  const WORLD_STALE_MS = 15 * 60_000;
  function getLatestWorldContext() {
    try {
      const rows = all(`
        SELECT data, created_at FROM events
        WHERE event_type = 'VisionAnalysis'
        ORDER BY id DESC LIMIT 1
      `);
      if (!rows.length) return null;
      const d = JSON.parse(rows[0].data || '{}');
      if (!d.description) return null;
      const ts = d.timestamp || new Date(rows[0].created_at).getTime();
      if (Date.now() - ts > WORLD_STALE_MS) return null;
      return { description: d.description, ts, image_file: d.image_file || null, source: d.source || null };
    } catch { return null; }
  }
  // Reuses the screen-vision garbage filter: the same local models emit the same
  // URN/UUID cold-start noise regardless of which camera fed them.
  const rawWorldCtx = getLatestWorldContext();
  const worldCtx = rawWorldCtx && isUsefulScreenDescription(rawWorldCtx.description)
    ? rawWorldCtx
    : null;

  const rawScreenCtx = getLatestScreenContext() || getLatestScreenContextFromDB();
  const screenCtx = rawScreenCtx && isUsefulScreenDescription(rawScreenCtx.description)
    ? rawScreenCtx
    : null;

  // ─── ACTIVITY — what Commander is actually doing ───
  // Priority: screen vision > active Claude session > active tasks > wrapper apps > idle
  // A session is "active" if Claude is running OR a client (dashboard) is connected.
  let activity = 'idle';
  const activeSessions = panSessions.filter(s => s.claudeRunning || s.clients > 0);
  const activeProject = activeSessions.find(s => s.project);
  const inProgressTasks = activeTasks.filter(t => t.status === 'in_progress');
  if (screenCtx?.description) {
    // Vision wins — it sees reality, not inferred state
    activity = screenCtx.description;
  } else if (activeProject) {
    const proj = (activeProject.project || '').toLowerCase();
    const verb = activeProject.thinking ? 'building (thinking)' : 'building';
    activity = `${verb} ${proj}`;
    if (inProgressTasks.length > 0) {
      activity += ` — ${inProgressTasks[0].title.toLowerCase()}`;
    }
  } else if (activeSessions.length > 0) {
    activity = 'in a claude session';
  } else if (inProgressTasks.length > 0) {
    activity = `working on: ${inProgressTasks[0].title.toLowerCase()}`;
  } else if (activeApps.size > 0) {
    activity = `using ${[...activeApps].join(', ').toLowerCase()}`;
  }

  // ─── FOCUS — what's on Commander's mind RIGHT NOW ───
  // Must be an intelligible concept, not raw message text.
  // Priority: in-progress task title > project feature > cleaned topic from conversation
  let focus = null;
  if (inProgressTasks.length > 0) {
    // Best signal: task titles are already clean descriptions
    focus = inProgressTasks[0].title.toLowerCase();
  } else if (activeProject) {
    // Know the project, try to extract topic from recent conversation
    focus = extractTopic(recentTerminalMsgs, activeProject.project);
  } else if (recentTerminalMsgs.length > 0) {
    focus = extractTopic(recentTerminalMsgs, null);
  }
  // Talking to PAN is the newest thing he did: the conversation state's topic says what
  // about (distilled from the voice turns, see conv-state-watcher.js).
  if (newestVoice && now - voiceTime < 10 * 60_000 && voiceTime >= (recentTerminalMsgs[0] ? new Date(recentTerminalMsgs[0].created_at).getTime() || 0 : 0)) {
    const cs = getConversationState();
    if (cs?.topic && cs.distilled_at && now - cs.distilled_at < 10 * 60_000) focus = String(cs.topic).toLowerCase();
  }
  // Fallback to wrap messages only if no terminal activity
  if (!focus && recentWrap.length > 0) {
    focus = extractTopic(recentWrap.map(m => ({ content: m.text || '' })), null);
  }

  // ─── SOCIAL — who Commander is interacting with ───
  const social = new Set();
  // People in wrap messages (last 5 min)
  for (const m of recentWrap) {
    const age = now - (new Date(m.received_at).getTime() || 0);
    if (age < FIVE_MIN && m.author) social.add(m.author);
  }
  // A prompt he gave Claude in the last 5 min. Every Claude session reports UserPromptSubmit
  // here, the desktop app's included, so this is Claude, not PAN. Session notices don't count.
  const lastPrompt = recentTerminalMsgs.find(m => isRealMessage(m.content));
  const lastPromptAge = lastPrompt ? now - (new Date(lastPrompt.created_at).getTime() || 0) : Infinity;
  if (lastPromptAge < FIVE_MIN) social.add('Claude');
  // Voice (conv-state-watcher.js): talking with PAN on the phone, dictating to Claude, and
  // voices the phone heard and let pass. It cannot tell who those are, only that he is not
  // alone.
  let voiceWithPan = false, dictating = false;
  try {
    voiceWithPan = panSpokeWithin(FIVE_MIN);
    dictating = !!dictatingToClaude();
    if (voiceWithPan) social.add('PAN');
    if (dictating) social.add('Claude');
    if (overheardWithin(FIVE_MIN) >= 2) social.add('people nearby');
  } catch {}

  // ─── ENGAGEMENT ───
  let engagement = 'alone';
  if (activeSessions.length > 0) engagement = 'session_open';
  if (lastPromptAge < FIVE_MIN) engagement = 'working_with_claude';
  if (voiceWithPan) engagement = 'active_conversation_with_pan';
  if (dictating) engagement = 'dictating_to_claude';
  if (social.size > 1) engagement = 'multi_conversation';   // PAN + others

  // ─── DIRECTION — what Commander is heading toward ───
  // Inferred from active project + tasks
  let direction = null;
  if (inProgressTasks.length > 0) {
    direction = inProgressTasks[0].title.toLowerCase();
  } else if (activeProject) {
    direction = `developing ${(activeProject.project || '').toLowerCase()}`;
  }

  // ─── MOOD, WELLBEING, URGENCY, NEED, COMPLEXITY, AWAKE ───
  // Read locally from his own lines, their pace, his clock and how long he has been up
  // (reader.js). NOT a medical device: these are PAN's assumptions about him.
  const lastPromptAt = recentTerminalMsgs[0] ? (new Date(recentTerminalMsgs[0].created_at).getTime() || 0) : 0;
  const read = readHim({
    now,
    hour,
    lines: [
      ...recentVoiceMsgs.map((m) => ({ text: m.content, at: new Date(m.created_at).getTime() || 0, channel: 'voice' })),
      ...recentTerminalMsgs.filter((m) => isRealMessage(m.content))
        .map((m) => ({ text: m.content, at: new Date(m.created_at).getTime() || 0, channel: 'claude' })),
    ],
    lastInputAt: Math.max(voiceTime, lastPromptAt) || null,
    awakeSince: awakeSince(now),
    activity,
    focus,
    dictating,
  });

  // ─── Recent topics (keyword-extracted from terminal + wrap messages) ───
  const recentTopics = [];
  const allRecentText = [
    ...recentTerminalMsgs.slice(0, 8).map(m => m.content || ''),
    ...recentWrap.slice(0, 5).map(m => m.text || ''),
  ].filter(isRealMessage);

  // Extract known PAN feature keywords from recent messages
  const topicBlob = allRecentText.join(' ').toLowerCase();
  for (const [keyword, topic] of Object.entries(TOPIC_KEYWORDS)) {
    const t = titleCase(topic);
    if (TOPIC_KEYWORD_RES[keyword].test(topicBlob) && !recentTopics.includes(t)) {
      recentTopics.push(t);
    }
    if (recentTopics.length >= 5) break;
  }
  // If no keywords matched, use project context
  if (recentTopics.length === 0 && activeProject) {
    recentTopics.push(titleCase(`${activeProject.project} Development`));
  }

  // Last heard = most recent REAL user message, trimmed to a readable length. Said to PAN
  // or typed to Claude Code, whichever came last.
  let lastHeard = null;
  const termTime = recentTerminalMsgs[0] ? (new Date(recentTerminalMsgs[0].created_at).getTime() || 0) : 0;
  if (newestVoice && voiceTime >= termTime) {
    const raw = newestVoice.content.trim();
    const firstSentence = raw.match(/^[^.!?\n]+[.!?]?/)?.[0] || raw;
    lastHeard = firstSentence.length > 80 ? firstSentence.slice(0, 77) + '...' : firstSentence;
  }
  for (const m of (lastHeard ? [] : recentTerminalMsgs)) {
    if (m.role === 'assistant') continue;  // skip AI replies
    if (isRealMessage(m.content)) {
      // Take first sentence or first 80 chars, whichever is shorter
      const raw = m.content.trim();
      const firstSentence = raw.match(/^[^.!?\n]+[.!?]?/)?.[0] || raw;
      lastHeard = firstSentence.length > 80 ? firstSentence.slice(0, 77) + '...' : firstSentence;
      break;
    }
  }
  if (!lastHeard) {
    for (const m of recentWrap) {
      if (isRealMessage(m.text)) {
        const raw = m.text.trim();
        const firstSentence = raw.match(/^[^.!?\n]+[.!?]?/)?.[0] || raw;
        lastHeard = firstSentence.length > 80 ? firstSentence.slice(0, 77) + '...' : firstSentence;
        break;
      }
    }
  }
  const lastSender = recentWrap[0]?.author || null;

  // ─── Predictions ───
  const predictions = [];
  if (social.size > 1) {
    const others = [...social].filter(s => s !== 'PAN');
    if (others.length) predictions.push({ what: `continued conversation with ${others.join(', ')}`, confidence: 0.7 });
  }
  if (hour >= 22 || hour < 5) {
    predictions.push({ what: 'winding down for the night', confidence: 0.5 });
  } else if (hour >= 6 && hour < 9) {
    predictions.push({ what: 'morning routine / startup', confidence: 0.4 });
  }
  if (inProgressTasks.length > 0) {
    predictions.push({ what: `will continue: ${inProgressTasks[0].title}`, confidence: 0.6 });
  }
  if (activeProject && inProgressTasks.length > 1) {
    predictions.push({ what: `next task: ${inProgressTasks[1].title}`, confidence: 0.4 });
  }

  // ─── Data summaries ───
  const dataSummaries = {
    terminal: recentTerminalMsgs.length > 0
      ? `${recentTerminalMsgs.length} Messages in Active Session`
      : 'No Active Conversation',
    conversations: recentWrap.length > 0
      ? `${recentWrap.length} Msgs, Latest from ${lastSender || 'Unknown'}: "${(recentWrap[0]?.text || '').slice(0, 50)}"`
      : 'No Recent Messages',
    events: recentEvents.length > 0
      ? `${recentEvents.length} Events (${[...new Set(recentEvents.map(e => e.event_type))].slice(0, 5).join(', ')})`
      : 'No Recent Events',
    camera: screenCtx
      ? `${screenCtx.description} (${Math.round((Date.now() - screenCtx.ts) / 1000)}s ago)`
      : null,                                // ⏳ pendant fallback
    audio: null,                             // ⏳ pendant
    sensors: sensorsActive.size > 0 ? `Active: ${[...sensorsActive].join(', ')}` : 'None Active',
    location: where ? titleCase(where) : null,
    apps: activeApps.size > 0 ? titleCase([...activeApps].join(', ')) : 'None Detected',
  };

  // ─── Confidence — how much data do we actually have? ───
  let confidence = 0;
  if (recentEvents.length > 0) confidence += 0.15;
  if (recentWrap.length > 0) confidence += 0.1;
  if (panSessions.length > 0) confidence += 0.2;
  if (recentTerminalMsgs.length > 0) confidence += 0.2;
  if (where) confidence += 0.1;
  if (sensorsActive.size > 0) confidence += 0.1;
  // Pendant will add 0.15 more when connected
  confidence = Math.min(confidence, 1.0);

  const snap = {
    commander,
    org_id: 'org_personal',
    as_of: now,
    trigger,
    now: {
      where: titleCase(where),
      activity: titleCase(activity),
      social: [...social],
      focus: titleCase(focus),
      mood: titleCase(read.mood.replace(/_/g, ' ')),
      mood_detail: read.mood_detail,
      assumption: titleCase(read.assumption.replace(/_/g, ' ')),
      assumption_detail: read.assumption_detail,
      urgency: titleCase(read.urgency),
      direction: titleCase(direction),
      need: read.need ? titleCase(read.need) : null,
      engagement: titleCase(engagement?.replace(/_/g, ' ')),
      complexity: read.complexity ? titleCase(read.complexity) : null,
      awake: titleCase(read.awake),
      recent_topics: recentTopics.slice(0, 5),
      last_heard: lastHeard || null,
      last_seen: (() => {
        const wc = getWebcamContext();
        if (!wc) return null;
        return wc.presence === 'yes' ? `${wc.identity ?? 'unknown'} at desk` : wc.presence === 'no' ? 'desk empty' : null;
      })(),
    },
    pan: {
      sessions: panSessions.map(s => ({
        ...s,
        description: s.project
          ? `${titleCase(s.project)} — ${s.claudeRunning ? 'Claude active' : s.thinking ? 'thinking' : 'idle'}`
          : s.claudeRunning ? 'Claude active' : 'Session open',
      })),
      services: stewardServices.map(s => ({
        name: titleCase(s.name),
        status: titleCase(s.status),
      })),
      recent_actions: recentPanActions.slice(0, 5),
      active_tasks: activeTasks,
      predictions,
      status: panSessions.length > 0 ? 'Active' : 'Idle',
    },
    data: dataSummaries,
    style: {
      voice_tone: null,                         // learned from conversation history
      reply_length: null,
      formality: null,
    },
    signals: {
      device_source: lastDeviceSource,
      sensors_active: [...sensorsActive],
      active_apps: [...activeApps],
      screen_context: screenCtx ? { description: screenCtx.description, age_ms: now - screenCtx.ts } : null,
      // What the camera (pendant or phone) last saw. Null is normal and must
      // stay non-fatal: there is no pendant attached most of the time.
      world_context: worldCtx
        ? { description: worldCtx.description, age_ms: now - worldCtx.ts, image_file: worldCtx.image_file, source: worldCtx.source }
        : null,
      // Identity/webcam is OPT-IN (PAN_ENABLE_IDENTITY=1). When off — the
      // default — getWebcamContext() returns null and webcam_context is simply
      // absent from the snapshot. Intuition does NOT depend on it: presence is
      // inferred from activity-tracker, and currentUserId() has its own
      // fallback. Do not "fix" this null path into a hard requirement.
      webcam_context: (() => {
        const wc = getWebcamContext();
        if (!wc) return null;
        return { presence: wc.presence, identity: wc.identity, emotion: wc.emotion, people_count: wc.people_count ?? 0, age_ms: now - wc.ts, camera: wc.camera };
      })(),
      events_sampled: recentEvents.length,
      wrap_messages_sampled: recentWrap.length,
      terminal_messages_sampled: recentTerminalMsgs.length,
      last_update_ms: now,
      confidence,
    },
    // The reading with its confidences, plus his clock (tz_source: phone, setting or hub).
    read: { ...read, hour, tz: zone.tz, tz_source: zone.source },
    meta: {
      schema_version: 3,
      generator: 'intuition-daemon-v1.6-local',
      reader: 'local',
      // The dashboard's "Mood read" row shows these.
      classifier: 'local reader',
      classified_at: now,
      disclaimer: 'NOT a medical device. Mood and wellbeing are automated assumptions only.',
    },
  };

  return snap;
}

// ─── His waking stretch ───
// When it began: his first voice turn or Claude prompt after the last break of 4 hours or more,
// within the last 30 hours. Null when there is no such break in the window: a prompt fired by
// a schedule at night can hide one, and "up 30 hours" from that would be worse than no answer.
// Runs at most every 10 minutes. Each type's newest rows come off idx_events_type: 2,000 of them
// reach back days, and it takes 0.07 s. `+event_type` with a created_at bound scanned the whole
// table instead, 5.7 s on the main thread, so a voice turn stalled every 10 minutes (2026-11-05).
const SLEEP_GAP_MS = 4 * 60 * 60_000;
const AWAKE_WINDOW_MS = 30 * 60 * 60_000;
let _awake = { at: 0, since: null };
function awakeSince(now = Date.now()) {
  if (now - _awake.at < 10 * 60_000) return _awake.since;
  let since = null;
  try {
    const times = ['RouterCommand', 'UserPromptSubmit'].flatMap((type) => all(
      `SELECT created_at FROM events WHERE event_type = :type ORDER BY id DESC LIMIT 2000`,
      { ':type': type }
    )).map((r) => new Date(r.created_at).getTime()).filter((t) => t > now - AWAKE_WINDOW_MS);
    let prev = null;
    for (const t of times.sort((a, b) => b - a)) {
      if (prev != null && prev - t >= SLEEP_GAP_MS) { since = prev; break; }
      prev = t;
    }
    if (since == null && prev != null && prev - (now - AWAKE_WINDOW_MS) >= SLEEP_GAP_MS) since = prev;
  } catch {}
  _awake = { at: now, since };
  return since;
}

// ─── Persist ───
function persistSnapshot(snap, trigger) {
  try {
    db.prepare(`
      INSERT INTO intuition_snapshots (commander, as_of, trigger, snapshot, confidence, source_count, org_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      snap.commander,
      snap.as_of,
      trigger,
      JSON.stringify(snap),
      snap.signals.confidence || 0,
      (snap.signals.events_sampled || 0) + (snap.signals.wrap_messages_sampled || 0),
      snap.org_id || 'org_personal'
    );
  } catch (e) {
    _writeErrors++;
    console.warn('[Intuition] snapshot DB write failed:', e.message);
  }

  try {
    fs.mkdirSync(path.dirname(INTUITION_FILE), { recursive: true });
    fs.writeFileSync(INTUITION_FILE, JSON.stringify(snap, null, 2));
  } catch (e) {
    _writeErrors++;
    console.warn('[Intuition] file write failed:', e.message);
  }

  // Push to dashboard over WebSocket — no polling needed, widgets update instantly.
  getBroadcast().then(fn => fn('widget_update', { widget: 'intuition' })).catch(() => {});
}

// ─── Deliberation: what PAN makes of the reading ───
// Mood, urgency, wellbeing and the rest are read in buildSnapshot by reader.js, locally and at
// once. Until 2026-11-03 a cloud model filled them in here after each tick (433 calls that
// day, the free Gemini quota the interpreter needed). What is left is PAN's side: the thought
// about what changed, and whether to speak up.
const DELIBERATE_COOLDOWN_MS = 10_000;
let _deliberating = false;
let _lastDeliberateTime = 0;
// The same debug line every minute says nothing new: write a line again only once it has
// changed (numbers aside) since the run before.
let _prevDbgKeys = new Set();

function deliberate(snap) {
  if (_deliberating) return;
  const now = Date.now();
  if (now - _lastDeliberateTime < DELIBERATE_COOLDOWN_MS) return;
  _deliberating = true;
  _lastDeliberateTime = now;
  const debugFile = path.join(path.dirname(INTUITION_FILE), 'intuition-debug.log');
  const dbgKeys = new Set();
  const dbg = (msg) => {
    const key = msg.replace(/\d+/g, '#');
    dbgKeys.add(key);
    if (_prevDbgKeys.has(key)) return;
    console.log(msg);
    try { fs.appendFileSync(debugFile, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
  };

  try {
    // PAN's-Mind thought — describe PAN's *decision*, not Commander's state.
    // The intuition panel already shows Commander's focus/mood/urgency; this
    // stream is supposed to be the agency loop: what changed since last tick,
    // what am I considering doing about it, what did I choose.
    //
    // Rules:
    //   • If nothing changed: skip writing. Every 10 unchanged ticks (~10min)
    //     emit ONE "still on it" pulse so the stream doesn't go dead.
    //   • If something changed: phrase as a delta ("focus shifted A → B")
    //     plus PAN's decision (hold / watch / consider interjecting).
    //   • The interjection deliberation gets its own `source:'interjection'`
    //     thought below — keep the intuition thought to the observation+verdict.
    try {
      const focus = snap.now.focus || null;
      const mood = snap.now.mood ? String(snap.now.mood).toLowerCase() : null;
      const urgency = snap.now.urgency ? String(snap.now.urgency).toLowerCase() : null;
      const assumption = snap.now.assumption ? String(snap.now.assumption).toLowerCase() : null;
      const current = { focus, mood, urgency, assumption };

      const prev = _lastVerdict;
      const changes = [];
      if (prev) {
        if (prev.focus !== focus && focus) changes.push(`focus ${prev.focus || '—'} → ${focus}`);
        if (prev.mood !== mood && mood) changes.push(`mood ${prev.mood || '—'} → ${mood}`);
        if (prev.urgency !== urgency && urgency && urgency !== 'normal') changes.push(`urgency now ${urgency}`);
        if (prev.assumption !== assumption && assumption) changes.push(`assumption ${prev.assumption || '—'} → ${assumption}`);
      }

      const decision = assumption === 'emergency'
        ? "I'm considering interjecting."
        : assumption === 'not ok'
          ? "I'm watching — something feels off."
          : "Holding — no reason to interrupt.";

      let body = null;
      if (!prev) {
        // First tick after boot/restart — orient, but keep it short.
        body = `First read after restart: ${focus ? focus : 'state unclear'}${mood ? `, ${mood}` : ''}. ${decision}`;
        _unchangedStreak = 0;
      } else if (changes.length > 0) {
        body = `Noticed ${changes.join('; ')}. ${decision}`;
        _unchangedStreak = 0;
      } else {
        _unchangedStreak++;
        if (_unchangedStreak === 1 || _unchangedStreak % 10 === 0) {
          // Skip silent ticks; pulse occasionally so dashboard isn't stale.
          body = `Still on ${focus || 'the same thread'} (${_unchangedStreak} ticks). ${decision}`;
        }
      }

      if (body) {
        writeThought('intuition', body, { reader: 'local', streak: _unchangedStreak }, 0.4);
      }
      _lastVerdict = { ...current, ts: Date.now() };
    } catch (e) {
      dbg(`[Intuition] thought-write failed: ${e.message}`);
    }

    // Interjection deliberation — event-driven, NOT time-throttled.
    //
    // Every tick we enumerate candidate actions from two sources:
    //   1. Life Needs — top need with urgency >= NEED_THRESHOLD
    //   2. State signals — assumption=emergency, mood=frustrated, long silence
    //
    // The flow penalty (deep coding/writing) suppresses ALL candidates unless
    // they're emergency-grade. We pick the highest-scoring candidate and write
    // a thought ONLY when the (verdict, top-candidate) tuple flips — so a
    // static state doesn't spam the stream, but a real change does. No
    // time-based cooldown.
    try {
      const userId = currentUserId();
      // His last input: a voice turn PAN answered (RouterCommand) or a prompt to Claude.
      // These read 'voice_command', 'dashboard_message', 'router_response' and
      // 'pan_utterance', none of which is ever written, so sinceMin was always null and
      // every quiet/idle/stale rule below was dead (audit, 2026-11-03). `+event_type`
      // walks back from the newest id instead of the whole type index.
      const last = get(
        `SELECT created_at FROM events WHERE +event_type IN ('RouterCommand','UserPromptSubmit')
         ORDER BY id DESC LIMIT 1`
      );
      const lastMs = last?.created_at ? Date.parse(last.created_at.replace(' ', 'T')) : null;
      const sinceMin = lastMs ? Math.round((Date.now() - lastMs) / 60_000) : null;

      // Build candidate list. Each: { id, kind, score, reason }
      const candidates = [];

      // ── Staleness gate ──────────────────────────────────────────────────
      // If the user is *actively interacting* (events flowing) but the
      // sensory observation layer hasn't refreshed in a long time, the
      // need-decay model is unreliable: PAN literally can't see whether
      // Commander ate, drank, or rested. Suppress need:* and state:emergency
      // in that case so we don't fire "no nourishment in 2 days" while the
      // user is clearly alive and typing. See user note 2026-05-22.
      const STALE_SENSOR_MS = 6 * 60 * 60_000; // 6h
      const wcAge = snap?.signals?.webcam_context?.age_ms;
      const scAge = snap?.signals?.screen_context?.age_ms;
      const wcStale = wcAge == null || wcAge > STALE_SENSOR_MS;
      const scStale = scAge == null || scAge > STALE_SENSOR_MS;
      const userActive = sinceMin != null && sinceMin < 30;
      const sensorsStale = wcStale && scStale && userActive;

      // (1) Life Needs candidates — gated by TWO rules per 2026-06-03 user
      // policy: "if you don't have data from it, the initial data point, you
      // shouldn't even be tracking it" + "after a certain amount of time it
      // said these things, it should just stop sending those messages."
      //
      //   GATE A — VALIDATED-DATA-SOURCE ALLOWLIST
      //   A need only earns a candidate slot if it's on ENABLED_NEEDS — the
      //   explicit list of needs PAN has a validated data source for. We
      //   previously tried "any non-decay pan_need_events row," but the
      //   screen-watcher was forging signals by pattern-matching coffee mugs
      //   and food images in screenshots (64 nourishment + 43 hydration
      //   "signals" all from screen-watcher in the wild — none were real
      //   consumption). Vision pattern-match ≠ real data.
      //
      //   Currently ENABLED:
      //     - safety: event-driven only, never decay-spam → always allowed
      //   Currently SUPPRESSED (no real signal source):
      //     - nourishment, hydration, rest, health_physical, health_mental,
      //       social, focus, fun, environment
      //
      //   To re-enable a need: add its id to ENABLED_NEEDS once a trusted
      //   signal source lands (pendant, watch, manual log, vision-with-
      //   confirmation, real social-messaging hook).
      //
      //   GATE B — IGNORED-LOOP AUTO-SNOOZE
      //   Even for ENABLED needs: if the same action_key fires N=3 times in
      //   a row with status 'delivered' (no accept/dismiss/snooze feedback
      //   from the user), suppress further candidates for 24h. User feedback
      //   resets the streak. Prevents the same "Social is at 0/100" from
      //   firing every hour across days when the user is clearly ignoring it.
      const ENABLED_NEEDS = new Set(['safety']);
      const NEED_THRESHOLD = 0.5;
      const IGNORED_LOOP_N = 3;
      const IGNORED_SNOOZE_HRS = 24;
      try {
        if (sensorsStale) {
          dbg(`[Intuition] need:* candidates suppressed — sensors stale (wc=${wcAge}ms, sc=${scAge}ms) while user active (${sinceMin}m)`);
        } else {
          const evald = needs.evaluate(userId);
          for (const n of evald) {
            if (n.urgency < NEED_THRESHOLD) continue;
            // GATE A
            if (!ENABLED_NEEDS.has(n.need_id)) {
              dbg(`[Intuition] need:${n.need_id} suppressed — not in ENABLED_NEEDS (no validated data source)`);
              continue;
            }
            // safety bypasses Gate B too (event-driven, not decay-driven).
            if (n.need_id === 'safety') {
              candidates.push({ id: `need:${n.need_id}`, kind: 'need', score: n.urgency, reason: `${n.label.toLowerCase()} event` });
              continue;
            }
            // GATE B
            let ignoredStreak = false;
            try {
              const recent = all(
                `SELECT status FROM pan_interjections
                 WHERE user_id = :u AND action_key = :k
                   AND created_at > datetime('now', 'localtime', '-${IGNORED_SNOOZE_HRS} hours')
                 ORDER BY id DESC LIMIT :lim`,
                { ':u': userId, ':k': `act:need:${n.need_id}`, ':lim': IGNORED_LOOP_N }
              );
              if (recent && recent.length >= IGNORED_LOOP_N && recent.every(r => r.status === 'delivered')) {
                ignoredStreak = true;
              }
            } catch {}
            if (ignoredStreak) {
              dbg(`[Intuition] need:${n.need_id} suppressed — ${IGNORED_LOOP_N} consecutive deliveries ignored in last ${IGNORED_SNOOZE_HRS}h`);
              continue;
            }
            candidates.push({
              id: `need:${n.need_id}`,
              kind: 'need',
              score: n.urgency,
              reason: `${n.label.toLowerCase()} at ${Math.round(n.level)}/100 (weight ${n.weight})`,
            });
          }
        }
      } catch (e) { dbg(`[Intuition] needs.evaluate failed: ${e.message}`); }

      // Cross-kind helper: same Gate B logic for state:* and conv:* candidates.
      // Keeps any candidate kind from spamming when the user is clearly
      // ignoring it. Returns true if the action_key has N consecutive
      // ignored deliveries in the lookback window.
      const _isIgnoredStreak = (actionKey) => {
        try {
          const recent = all(
            `SELECT status FROM pan_interjections
             WHERE user_id = :u AND action_key = :k
               AND created_at > datetime('now', 'localtime', '-${IGNORED_SNOOZE_HRS} hours')
             ORDER BY id DESC LIMIT :lim`,
            { ':u': userId, ':k': actionKey, ':lim': IGNORED_LOOP_N }
          );
          return recent && recent.length >= IGNORED_LOOP_N && recent.every(r => r.status === 'delivered');
        } catch { return false; }
      };

      // (2) State-signal candidates. Each candidate is gated by Gate B
      // (ignored-loop snooze) — same rule as needs: 3 deliveries with no
      // user feedback in 24h → suppress. Mood/quiet candidates are the
      // most prone to spam if the user just sits there working.
      const _pushIfNotIgnored = (cand) => {
        if (!_isIgnoredStreak(`act:${cand.id}`)) candidates.push(cand);
        else dbg(`[Intuition] ${cand.id} suppressed — ignored streak`);
      };
      // The classifier's values are title-cased ("Not Ok", "Emergency"), so compared as
      // written ('not_ok', 'emergency') these never matched.
      const assumption = String(snap.now.assumption || '').toLowerCase().replace(/_/g, ' ');
      if (assumption === 'emergency' && !sensorsStale) {
        _pushIfNotIgnored({ id: 'state:emergency', kind: 'state', score: 1.5, reason: 'assumption=emergency' });
      } else if (assumption === 'not ok') {
        // 0.72 and 0.70 clear the 0.7 bar: at 0.6 and 0.55 a check-in could never be said.
        _pushIfNotIgnored({ id: 'state:not_ok', kind: 'state', score: 0.72, reason: 'assumption=not_ok' });
      }
      if (snap.now.mood && /frustrated|anxious|sad|angry/i.test(snap.now.mood)) {
        _pushIfNotIgnored({ id: `state:mood_${snap.now.mood.toLowerCase()}`, kind: 'state', score: 0.7, reason: `mood=${snap.now.mood}` });
      }
      if (sinceMin != null && sinceMin > 60) {
        _pushIfNotIgnored({ id: 'state:quiet', kind: 'state', score: 0.45, reason: `quiet ${sinceMin}m` });
      }

      // (3) Conversation-flow candidates (conv:*) — fire even in flow.
      // Detect confusion, stuck-ness, tangents, and idle gaps from the
      // event stream + intuition snapshot history.
      try {
        // conv:confused — ≥3 clarifying ?-ending prompts in 5 min
        //
        // `+event_type` (here and in conv:stuck) keeps SQLite off idx_events_type.
        // The DB has no sqlite_stat1, so the planner picked the type index and
        // read every UserPromptSubmit row ever stored (41k on the hub) instead
        // of the last few minutes via idx_events_created: 800ms + 750ms, a
        // 1.5s event-loop block on every classify. With the `+`: 1ms each.
        const confusedCount = get(
          `SELECT COUNT(*) AS n FROM events
           WHERE +event_type IN ('RouterCommand','UserPromptSubmit')
             AND created_at > datetime('now','localtime','-5 minutes')
             AND data LIKE '%?%'`
        )?.n || 0;
        if (confusedCount >= 3) {
          _pushIfNotIgnored({
            id: 'conv:confused',
            kind: 'conv',
            score: 0.75,
            reason: `${confusedCount} clarifying questions in 5m`,
          });
        }

        // conv:stuck — ≥2 stuck-phrase prompts in 10 min
        const stuckRows = all(
          `SELECT data FROM events
           WHERE +event_type IN ('RouterCommand','UserPromptSubmit')
             AND created_at > datetime('now','localtime','-10 minutes')`
        );
        const STUCK_RE = /stuck|don'?t know|not working|why isn'?t|why does(?:n'?t)?|broken|doesn'?t work|won'?t work/i;
        let stuckCount = 0;
        for (const r of stuckRows) {
          if (r?.data && STUCK_RE.test(r.data)) stuckCount++;
        }
        if (stuckCount >= 2) {
          _pushIfNotIgnored({
            id: 'conv:stuck',
            kind: 'conv',
            score: 0.80,
            reason: `${stuckCount} stuck-phrase prompts in 10m`,
          });
        }

        // conv:tangent — focus changed in last 5 min
        // as_of is epoch ms; compared with a datetime() string it was never greater, so
        // this never found a snapshot.
        const recentFoci = all(
          `SELECT snapshot FROM intuition_snapshots
           WHERE as_of > :since
           ORDER BY as_of DESC LIMIT 10`, { ':since': Date.now() - 5 * 60_000 }
        );
        const currentFocus = snap?.now?.focus || null;
        if (currentFocus && recentFoci.length >= 2) {
          let prevFocus = null;
          for (const r of recentFoci) {
            try {
              const s = JSON.parse(r.snapshot);
              const f = s?.now?.focus;
              if (f && f !== currentFocus) { prevFocus = f; break; }
            } catch {}
          }
          if (prevFocus) {
            _pushIfNotIgnored({
              id: 'conv:tangent',
              kind: 'conv',
              score: 0.70,
              reason: `focus shifted ${prevFocus} → ${currentFocus}`,
              from: prevFocus,
              to: currentFocus,
            });
          }
        }

        // conv:idle — quiet 10-30 min (state:quiet handles 60+)
        if (sinceMin != null && sinceMin >= 10 && sinceMin <= 30) {
          _pushIfNotIgnored({
            id: 'conv:idle',
            kind: 'conv',
            score: 0.65,
            reason: `quiet ${sinceMin}m`,
          });
        }
      } catch (e) { dbg(`[Intuition] conv:* candidates failed: ${e.message}`); }

      // Flow penalty — deep coding/writing suppresses non-emergency candidates.
      // EXCEPTION: conv:* candidates bypass flow because the whole point is to
      // unstick a stalled conversation; the user explicitly opted them past
      // the flow gate. (2026-05-22)
      const inFlow = snap.now.focus && /coding|writing|building|debugging/i.test(snap.now.focus);

      // Pick the top candidate (or none).
      candidates.sort((a, b) => b.score - a.score);
      let top = candidates[0] || null;
      const threshold = 0.7;

      let verdict, key, thought, importance;
      const convBypass = top && top.id.startsWith('conv:');
      if (top && (top.score >= threshold) && !(inFlow && top.score < 1.2 && !convBypass)) {
        verdict = 'act';
        key = `act:${top.id}`;
        thought = `I should speak up about ${top.reason} (score ${top.score.toFixed(2)} ≥ ${threshold}${inFlow ? ', overriding flow' : ''}).`;
        importance = 0.8;
      } else if (top && inFlow) {
        verdict = 'suppress';
        key = `suppress:flow:${top.id}`;
        thought = `Holding back on ${top.reason} — Commander is in flow (${snap.now.focus}).`;
        importance = 0.35;
      } else if (top) {
        verdict = 'suppress';
        key = `suppress:${top.id}`;
        thought = `Holding back from interjecting — top candidate ${top.reason}, score ${top.score.toFixed(2)} < ${threshold}.`;
        importance = 0.3;
      } else {
        verdict = 'suppress';
        key = 'suppress:none';
        thought = 'Nothing pressing — no candidate cleared the bar.';
        importance = 0.2;
      }

      // Dedupe by (verdict, top-candidate) identity — write only when it changes.
      if (key !== _lastInterjectionKey) {
        writeThought('interjection', thought, {
          verdict,
          top: top ? top.id : null,
          score: top ? top.score : 0,
          threshold,
          in_flow: !!inFlow,
          since_last_min: sinceMin,
          candidates: candidates.slice(0, 5).map(c => ({ id: c.id, score: c.score })),
        }, importance);
        _lastInterjectionKey = key;

        // If the verdict is "act", hand off to the action engine which
        // delivers to all channels (Π thread, dashboard WS, connected
        // devices). Fire-and-forget — dispatch has its own persistence dedupe
        // (30-min by action_key) so duplicate calls from rapid flips are safe.
        if (verdict === 'act' && top) {
          // Enrich the candidate with the latest need-row data for nicer phrasing.
          let enriched = { ...top };
          if (top.id.startsWith('need:')) {
            try {
              const needId = top.id.split(':')[1];
              const evald = needs.evaluate(userId);
              const n = evald.find(x => x.need_id === needId);
              if (n) {
                enriched.level = n.level;
                enriched.weight = n.weight;
                enriched.hours = n.hours_since_satisfied;
              }
            } catch { /* phrasing falls back to default */ }
          }
          dispatchAction(enriched, { userId, scoreCtx: { since_last_min: sinceMin, in_flow: !!inFlow } })
            .catch(e => dbg(`[Intuition] dispatchAction failed: ${e.message}`));
        }
      }
    } catch (e) {
      dbg(`[Intuition] interjection-thought failed: ${e.message}`);
    }

    dbg(`[Intuition] read locally: mood=${snap.now.mood} wellbeing=${snap.now.assumption} urgency=${snap.now.urgency} need=${snap.now.need || '-'} focus="${snap.now.focus || ''}"`);
  } catch (e) {
    dbg(`[Intuition] deliberation failed: ${e.message}\n${e.stack}`);
  } finally {
    _prevDbgKeys = dbgKeys;
    _deliberating = false;
  }
}

// ─── Public: tick + accessors ───
export function tickIntuition(trigger = 'heartbeat') {
  if (!_running) return null;
  try {
    // The reading is held inside reader.js, so a tick no longer flips the panel between
    // keyword guesses and a cloud reading every minute (audit, 2026-11-03).
    const snap = buildSnapshot(trigger);
    persistSnapshot(snap, trigger);
    _lastSnapshot = snap;

    // Off the tick's own stack, so a bug in it cannot fail the tick.
    Promise.resolve().then(() => deliberate(snap)).catch(e =>
      console.warn('[Intuition] deliberate escaped catch:', e?.message)
    );

    // Fire org tick alongside individual tick (non-blocking)
    Promise.resolve().then(() => tickOrgIntuition('org_personal', trigger)).catch(e =>
      console.warn('[OrgIntuition] tick escaped catch:', e?.message)
    );

    if (_onTickCallback) _onTickCallback();
    return snap;
  } catch (e) {
    console.warn('[Intuition] tick failed:', e.message);
    return null;
  }
}

// Individual situational snapshots ARE org-scoped — the same human can have
// distinct context streams per org (work focus vs personal focus). Body-level
// state (needs, hydration, rest) stays user-scoped — see docs/PAN-ARCHITECTURE.md.
//
// orgId is optional; null/undefined means "most recent regardless of org" (legacy
// callers + boot-time fallbacks where the daemon hasn't tagged snapshots yet).
export function getCurrentSnapshot(orgId = null) {
  if (_lastSnapshot && (!orgId || _lastSnapshot.org_id === orgId)) return _lastSnapshot;
  // Fall back to most recent DB row, scoped if orgId given.
  // db.js fixParams converts arrays to objects keyed by index, so positional `?`
  // with arrays does NOT work in this codebase — use named `:org_id` style.
  try {
    const row = orgId
      ? get(`SELECT snapshot FROM intuition_snapshots WHERE org_id = :org_id ORDER BY as_of DESC LIMIT 1`, { ':org_id': orgId })
      : get(`SELECT snapshot FROM intuition_snapshots ORDER BY as_of DESC LIMIT 1`);
    if (row?.snapshot) return JSON.parse(row.snapshot);
  } catch {}
  // Disk fallback is org-blind by design (single global file). Only use it when
  // the caller didn't specify an org OR when the on-disk snapshot's stamped
  // org_id matches the request — otherwise we'd leak personal-org context to a
  // caller asking about a different org.
  try {
    if (fs.existsSync(INTUITION_FILE)) {
      const onDisk = JSON.parse(fs.readFileSync(INTUITION_FILE, 'utf8'));
      if (!orgId || onDisk.org_id === orgId) return onDisk;
    }
  } catch {}
  return null;
}

export function getSnapshotHistory(limit = 50, orgId = null) {
  const lim = Math.max(1, Math.min(500, parseInt(limit) || 50));
  // LIMIT can't be a bound param in SQLite via better-sqlite3, so inline the
  // sanitized integer. org_id is bound named to stay injection-safe.
  const rows = orgId
    ? all(
        `SELECT id, commander, as_of, trigger, confidence, source_count, snapshot
         FROM intuition_snapshots WHERE org_id = :org_id ORDER BY as_of DESC LIMIT ${lim}`,
        { ':org_id': orgId }
      )
    : all(
        `SELECT id, commander, as_of, trigger, confidence, source_count, snapshot
         FROM intuition_snapshots ORDER BY as_of DESC LIMIT ${lim}`
      );
  return rows.map(r => {
    let parsed = null;
    try { parsed = JSON.parse(r.snapshot); } catch {}
    return {
      id: r.id, commander: r.commander, as_of: r.as_of, trigger: r.trigger,
      confidence: r.confidence, source_count: r.source_count, snapshot: parsed,
    };
  });
}

let _onTickCallback = null;

// ─── Service lifecycle (for Steward) ───
export function startIntuition(intervalMs = INTUITION_TICK_MS, onTick = null) {
  if (_running) return;
  _onTickCallback = onTick;
  ensureIntuitionSchema(db);
  _running = true;
  // Immediate tick so dashboards aren't empty
  tickIntuition('startup');
  _tickTimer = setInterval(() => tickIntuition('heartbeat'), intervalMs);
  console.log(`[Intuition] daemon started (tick ${intervalMs}ms, commander=${getCommanderIdentity()})`);
}

export function stopIntuition() {
  _running = false;
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
  console.log('[Intuition] daemon stopped');
}

export function getIntuitionStatus() {
  return {
    running: _running,
    last_snapshot_as_of: _lastSnapshot?.as_of || null,
    write_errors: _writeErrors,
    file: INTUITION_FILE,
    commander: getCommanderIdentity(),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ─── ORG-WIDE INTUITION ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
//
// Aggregates individual member snapshots + device presence into a single
// org-level view. Answers: "what is the whole org doing right now?"
//
// For single-user PAN: shows the commander + connected client devices.
// For multi-user PAN: shows all members' states rolled up.
//
// Tick cadence: same 60s as individual intuition (called from tickIntuition).

const ORG_INTUITION_FILE = path.join(
  process.env.LOCALAPPDATA || process.env.HOME || '.',
  'PAN', 'data', 'org-intuition.json'
);

let _lastOrgSnapshot = null;
let _getConnectedClients = null;

// Lazy-import client-manager (avoids circular deps at load time)
async function getClientsFn() {
  if (!_getConnectedClients) {
    try {
      const cm = await import('../client-manager.js');
      _getConnectedClients = cm.getConnectedClients;
    } catch { _getConnectedClients = () => []; }
  }
  return _getConnectedClients;
}

// Build the org-level snapshot from all available signals
async function buildOrgSnapshot(orgId = 'org_personal', trigger = 'heartbeat') {
  const now = Date.now();

  // ─── Org metadata ───
  let orgName = 'Personal';
  try {
    const orgRow = get(`SELECT name FROM orgs WHERE id = :id`, { ':id': orgId });
    if (orgRow?.name) orgName = orgRow.name;
  } catch {}

  // ─── Member snapshots — most recent per commander ───
  let memberSnapshots = [];
  try {
    // Named params: db.js fixParams() converts arrays to objects keyed by
    // numeric string ('0','1'...), which doesn't bind to positional `?` —
    // use `:name` placeholders instead. Members active in last 10min.
    const rows = all(`
      SELECT commander, as_of, confidence, snapshot
      FROM intuition_snapshots
      WHERE org_id = :org_id AND as_of > :since
      GROUP BY commander
      HAVING MAX(as_of)
      ORDER BY as_of DESC
      LIMIT 20
    `, { ':org_id': orgId, ':since': now - 10 * 60 * 1000 });

    for (const r of rows) {
      try {
        const snap = JSON.parse(r.snapshot);
        const n = snap.now || {};
        memberSnapshots.push({
          commander: r.commander,
          as_of: r.as_of,
          age_ms: now - r.as_of,
          is_active: (now - r.as_of) < 5 * 60 * 1000,   // active if snapshot < 5min old
          activity: n.activity || null,
          focus: n.focus || null,
          mood: n.mood || null,
          where: n.where || null,
          last_seen: n.last_seen || null,
          last_heard: n.last_heard || null,
          urgency: n.urgency || null,
          engagement: n.engagement || null,
          recent_topics: n.recent_topics || [],
          assumption: n.assumption || null,
          confidence: r.confidence || 0,
        });
      } catch {}
    }
  } catch (e) {
    console.warn('[OrgIntuition] member snapshot fetch failed:', e.message);
  }

  // If no DB snapshots, fall back to best available snapshot (in-memory or DB/disk via getCurrentSnapshot)
  if (memberSnapshots.length === 0) {
    const fallback = (_lastSnapshot && _lastSnapshot.org_id === orgId)
      ? _lastSnapshot
      : getCurrentSnapshot(orgId);
    if (fallback) {
      const n = fallback.now || {};
      memberSnapshots.push({
        commander: fallback.commander,
        as_of: fallback.as_of,
        age_ms: now - fallback.as_of,
        is_active: (now - fallback.as_of) < 5 * 60 * 1000,
        activity: n.activity || null,
        focus: n.focus || null,
        mood: n.mood || null,
        where: n.where || null,
        last_seen: n.last_seen || null,
        last_heard: n.last_heard || null,
        urgency: n.urgency || null,
        engagement: n.engagement || null,
        recent_topics: n.recent_topics || [],
        assumption: n.assumption || null,
        confidence: fallback.signals?.confidence || 0,
      });
    }
  }

  // ─── Connected devices (pan-client devices) ───
  let devices = [];
  try {
    const fn = await getClientsFn();
    const clients = fn();
    devices = clients.map(c => ({
      device_id: c.device_id,
      name: c.name || c.device_id,
      platform: c.platform || null,
      online: c.online,
      trusted: c.trusted,
      last_heartbeat: c.last_heartbeat,
      age_ms: c.last_heartbeat ? now - new Date(c.last_heartbeat).getTime() : null,
      mem_free_mb: c.mem_free_mb || null,
    }));
  } catch {}

  // ─── Device presence (enriched from pan-client presence POSTs) ───
  try {
    const presenceRows = all(`
      SELECT device_id, user_id, activity, screen_title, confidence, platform, as_of
      FROM device_presence
      WHERE as_of > :since
    `, { ':since': now - 10 * 60 * 1000 });  // active in last 10min

    for (const p of presenceRows) {
      const existing = devices.find(d => d.device_id === p.device_id);
      if (existing) {
        // Enrich the existing device entry with presence data
        existing.user_id = p.user_id || existing.user_id;
        existing.activity = p.activity || null;
        existing.screen_title = p.screen_title || null;
        existing.presence_confidence = p.confidence || 0;
        existing.presence_age_ms = now - p.as_of;
        existing.presence_active = (now - p.as_of) < 5 * 60 * 1000;
      } else {
        // Device not in client-manager (e.g. reconnecting) — add from presence table
        devices.push({
          device_id: p.device_id,
          name: p.device_id,
          platform: p.platform || null,
          online: false,
          trusted: null,
          user_id: p.user_id || null,
          activity: p.activity || null,
          screen_title: p.screen_title || null,
          presence_confidence: p.confidence || 0,
          presence_age_ms: now - p.as_of,
          presence_active: (now - p.as_of) < 5 * 60 * 1000,
        });
      }
    }
  } catch (e) {
    console.warn('[OrgIntuition] device_presence fetch failed:', e.message);
  }

  // ─── Task counts ───
  let openTasks = 0, inProgressTasks = 0;
  try {
    const counts = get(`
      SELECT
        SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
      FROM tasks WHERE status IN ('todo', 'in_progress')
    `);
    openTasks = counts?.open || 0;
    inProgressTasks = counts?.in_progress || 0;
  } catch {}

  // ─── Aggregate org state ───
  const activeMembers = memberSnapshots.filter(m => m.is_active);
  const onlineDevices = devices.filter(d => d.online);

  // Collective focus: merge unique focus topics across active members
  const allTopics = [];
  for (const m of activeMembers) {
    if (m.focus) allTopics.push(m.focus);
    if (m.recent_topics) allTopics.push(...m.recent_topics);
  }
  const collectiveFocus = [...new Set(allTopics)].slice(0, 5);

  // Collective activity: primary member's activity + device count context
  let collectiveActivity = null;
  if (activeMembers.length > 0) {
    collectiveActivity = activeMembers[0].activity || 'Idle';
    if (onlineDevices.length > 0) {
      collectiveActivity += ` (${onlineDevices.length} device${onlineDevices.length > 1 ? 's' : ''} online)`;
    }
  }

  // Org mood: take highest-urgency member's mood, or majority
  let orgMood = null;
  const urgencyOrder = ['Critical', 'High', 'Elevated', 'Normal', 'Low'];
  for (const level of urgencyOrder) {
    const m = activeMembers.find(m => m.urgency === level);
    if (m) { orgMood = m.mood; break; }
  }
  if (!orgMood && activeMembers.length > 0) orgMood = activeMembers[0].mood;

  // Org assumption: bubble up any not_ok/emergency
  let orgAssumption = 'Ok';
  for (const m of activeMembers) {
    if (m.assumption === 'Emergency') { orgAssumption = 'Emergency'; break; }
    if (m.assumption === 'Not Ok') orgAssumption = 'Not Ok';
  }

  const orgSnap = {
    org_id: orgId,
    org_name: orgName,
    as_of: now,
    trigger,
    members: memberSnapshots,
    devices,
    org_state: {
      active_members: activeMembers.length,
      total_members: memberSnapshots.length,
      online_devices: onlineDevices.length,
      total_devices: devices.length,
      collective_activity: collectiveActivity,
      collective_focus: collectiveFocus,
      org_mood: orgMood,
      org_assumption: orgAssumption,
      open_tasks: openTasks,
      in_progress_tasks: inProgressTasks,
    },
    meta: {
      schema_version: 1,
      generator: 'org-intuition-v1',
      disclaimer: 'NOT a medical device. Mood and wellbeing are automated assumptions only.',
    },
  };

  return orgSnap;
}

function persistOrgSnapshot(snap) {
  try {
    db.prepare(`
      INSERT INTO org_intuition_snapshots (org_id, as_of, trigger, snapshot, member_count, device_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      snap.org_id,
      snap.as_of,
      snap.trigger,
      JSON.stringify(snap),
      snap.org_state.total_members,
      snap.org_state.total_devices
    );
  } catch (e) {
    console.warn('[OrgIntuition] snapshot DB write failed:', e.message);
  }

  try {
    fs.mkdirSync(path.dirname(ORG_INTUITION_FILE), { recursive: true });
    fs.writeFileSync(ORG_INTUITION_FILE, JSON.stringify(snap, null, 2));
  } catch (e) {
    console.warn('[OrgIntuition] file write failed:', e.message);
  }

  // Push to dashboard
  getBroadcast().then(fn => fn('widget_update', { widget: 'org_intuition' })).catch(() => {});
}

export async function tickOrgIntuition(orgId = 'org_personal', trigger = 'heartbeat') {
  try {
    const snap = await buildOrgSnapshot(orgId, trigger);
    persistOrgSnapshot(snap);
    _lastOrgSnapshot = snap;
    return snap;
  } catch (e) {
    console.warn('[OrgIntuition] tick failed:', e.message);
    return null;
  }
}

export function getCurrentOrgSnapshot(orgId = 'org_personal') {
  if (_lastOrgSnapshot && _lastOrgSnapshot.org_id === orgId) return _lastOrgSnapshot;
  // Fall back to DB
  try {
    const row = get(`
      SELECT snapshot FROM org_intuition_snapshots
      WHERE org_id = :org_id ORDER BY as_of DESC LIMIT 1
    `, { org_id: orgId });
    if (row?.snapshot) return JSON.parse(row.snapshot);
  } catch {}
  // Fall back to disk
  try {
    if (fs.existsSync(ORG_INTUITION_FILE)) return JSON.parse(fs.readFileSync(ORG_INTUITION_FILE, 'utf8'));
  } catch {}
  return null;
}

export function getOrgSnapshotHistory(orgId = 'org_personal', limit = 50) {
  const safeLimit = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
  try {
    const rows = all(`
      SELECT id, org_id, as_of, trigger, member_count, device_count, snapshot
      FROM org_intuition_snapshots
      WHERE org_id = :org_id
      ORDER BY as_of DESC LIMIT ${safeLimit}
    `, { org_id: orgId });
    return rows.map(r => {
      let parsed = null;
      try { parsed = JSON.parse(r.snapshot); } catch {}
      return {
        id: r.id, org_id: r.org_id, as_of: r.as_of, trigger: r.trigger,
        member_count: r.member_count, device_count: r.device_count, snapshot: parsed,
      };
    });
  } catch { return []; }
}

export function getOrgMemberSnapshots(orgId = 'org_personal') {
  // Latest snapshot per commander for this org. This was one GROUP BY over every snapshot
  // the org ever had (a row a minute since spring), reading each row's JSON: 5.8-7.5 s on the
  // hub, synchronous, so with the Intuition panel open every voice turn could stall behind it
  // twice a minute (2026-11-03). Members seen in the last day, then one indexed read each.
  // `+commander`: without sqlite_stat1 the planner would walk idx_intuition_commander to group,
  // which is the whole table again; this keeps it on the (org_id, as_of) range.
  try {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const latest = all(`
      SELECT commander, MAX(as_of) AS as_of FROM intuition_snapshots
      WHERE org_id = :org_id AND as_of > :since
      GROUP BY +commander ORDER BY as_of DESC
    `, { org_id: orgId, since });
    return latest.map(l => {
      const r = get(`SELECT confidence, snapshot FROM intuition_snapshots
        WHERE commander IS :commander AND as_of = :as_of AND org_id = :org_id LIMIT 1`,
        { commander: l.commander, as_of: l.as_of, org_id: orgId }) || {};
      let parsed = null;
      try { parsed = JSON.parse(r.snapshot); } catch {}
      return { commander: l.commander, as_of: l.as_of, confidence: r.confidence, snapshot: parsed };
    });
  } catch { return []; }
}
