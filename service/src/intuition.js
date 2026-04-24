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
import { db, get, all, getOllamaUrl } from './db.js';
import { askAI } from './llm.js';
import { getLatestScreenContext, getLatestScreenContextFromDB } from './screen-watcher.js';
// Lazy import — terminal server may not be initialized when intuition.js is first loaded.
// We call it at runtime (after first snapshot) so the WS server is always ready by then.
let _broadcast = null;
async function getBroadcast() {
  if (!_broadcast) {
    const { broadcastNotification } = await import('./terminal.js');
    _broadcast = broadcastNotification;
  }
  return _broadcast;
}

// ─── Config ───
const PAN_PORT = parseInt(process.env.PAN_CARRIER_PORT || '7777');
const INTUITION_TICK_MS = 30 * 1000;                // passive heartbeat
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
      as_of INTEGER NOT NULL,                   -- ms epoch
      trigger TEXT,                             -- 'heartbeat' | 'event' | 'observe' | 'manual'
      snapshot TEXT NOT NULL,                   -- full JSON doc
      confidence REAL DEFAULT 0,
      source_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_intuition_as_of ON intuition_snapshots(as_of DESC);
    CREATE INDEX IF NOT EXISTS idx_intuition_commander ON intuition_snapshots(commander, as_of DESC);
  `);
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
    if (blob.includes(keyword)) hits.push(topic);
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
  const hour = new Date(now).getHours();
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

  // Device presence — figure out where Commander is interacting FROM
  let lastDeviceSource = 'desktop';              // default: they're at the computer
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

  // ─── WHERE — location inference ───
  // If interacting via localhost dashboard → at the hub (desktop computer)
  // If last event was phone → mobile / away from hub
  // Pendant GPS will override when available
  let where = null;
  if (lastDeviceSource === 'desktop') {
    where = 'at the hub';
  } else if (lastDeviceSource === 'phone') {
    where = 'mobile';
  }

  // ─── SCREEN CONTEXT — vision-based activity (highest priority signal) ───
  // Screen watcher captures a screenshot every 30s and runs it through vision AI.
  // In-memory cache first (fastest), DB fallback for first tick after restart.
  const screenCtx = getLatestScreenContext() || getLatestScreenContextFromDB();

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
  // If actively in terminal with PAN, that counts
  if (activeSessions.length > 0) social.add('PAN');

  // ─── ENGAGEMENT ───
  let engagement = 'alone';
  if (activeSessions.length > 0) {
    if (recentTerminalMsgs.length > 0) {
      const lastMsgAge = now - (new Date(recentTerminalMsgs[0].created_at).getTime() || 0);
      engagement = lastMsgAge < FIVE_MIN ? 'active_conversation_with_pan' : 'session_open';
    } else {
      engagement = 'session_open';
    }
  }
  if (social.size > 1) engagement = 'multi_conversation';   // PAN + others

  // ─── DIRECTION — what Commander is heading toward ───
  // Inferred from active project + tasks
  let direction = null;
  if (inProgressTasks.length > 0) {
    direction = inProgressTasks[0].title.toLowerCase();
  } else if (activeProject) {
    direction = `developing ${(activeProject.project || '').toLowerCase()}`;
  }

  // ─── MOOD — Commander's emotional state (assumption, NOT medical) ───
  // v1: infer from interaction patterns. v2: Cerebras reads conversation tone.
  // NOT a medical device. These are PAN's assumptions about Commander's state.
  let mood = inferMood(recentTerminalMsgs, recentEvents, hour, now);

  // ─── WELLBEING — simple 3-state: ok / not_ok / emergency ───
  // NOT medical advice. PAN's assumption based on activity patterns and conversation.
  // Disclaimer: This is not a medical device. These are automated assumptions only.
  let wellbeing = inferWellbeing(recentTerminalMsgs, recentEvents, hour, now);

  // ─── URGENCY ───
  let urgency = 'normal';
  // If Commander sent multiple messages in quick succession → elevated
  if (recentTerminalMsgs.length >= 3) {
    const times = recentTerminalMsgs.slice(0, 3).map(m => new Date(m.created_at).getTime());
    const span = times[0] - times[2];
    if (span < 60000) urgency = 'high';       // 3 messages in under a minute
    else if (span < 180000) urgency = 'elevated';
  }

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
    if (topicBlob.includes(keyword) && !recentTopics.includes(t)) {
      recentTopics.push(t);
    }
    if (recentTopics.length >= 5) break;
  }
  // If no keywords matched, use project context
  if (recentTopics.length === 0 && activeProject) {
    recentTopics.push(titleCase(`${activeProject.project} Development`));
  }

  // Last heard = most recent REAL user message, trimmed to a readable length
  let lastHeard = null;
  for (const m of recentTerminalMsgs) {
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
    as_of: now,
    trigger,
    now: {
      where: titleCase(where),
      activity: titleCase(activity),
      social: [...social],
      focus: titleCase(focus),
      mood: titleCase(mood.state),
      mood_detail: mood.detail ? mood.detail.charAt(0).toUpperCase() + mood.detail.slice(1) : null,
      assumption: titleCase(wellbeing.state?.replace(/_/g, ' ')),
      assumption_detail: wellbeing.detail ? wellbeing.detail.charAt(0).toUpperCase() + wellbeing.detail.slice(1) : null,
      urgency: titleCase(urgency),
      direction: titleCase(direction),
      need: null,                               // needs deeper classifier
      engagement: titleCase(engagement?.replace(/_/g, ' ')),
      complexity: null,                         // needs classifier
      recent_topics: recentTopics.slice(0, 5),
      last_heard: lastHeard || null,
      last_seen: null,                          // ⏳ pendant camera
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
      events_sampled: recentEvents.length,
      wrap_messages_sampled: recentWrap.length,
      terminal_messages_sampled: recentTerminalMsgs.length,
      last_update_ms: now,
      confidence,
    },
    meta: {
      schema_version: 3,
      generator: 'intuition-daemon-v1.5-smart',
      disclaimer: 'NOT a medical device. Mood and wellbeing are automated assumptions only.',
    },
  };

  return snap;
}

// ─── Mood inference (NOT medical — PAN's assumptions) ───
// Reads conversation tone, activity patterns, time of day.
// Returns { state: string, detail: string }
function inferMood(terminalMsgs, events, hour, now) {
  // Defaults
  let state = 'neutral';
  let detail = 'no strong signals';

  if (terminalMsgs.length === 0) {
    // No conversation → infer from time of day only
    if (hour >= 22 || hour < 6) return { state: 'winding_down', detail: 'late hours, minimal activity' };
    if (hour >= 6 && hour < 10) return { state: 'starting_up', detail: 'morning hours' };
    return { state: 'neutral', detail: 'no recent interaction to read' };
  }

  // Look at message content for tone signals
  const recentText = terminalMsgs.slice(0, 3).map(m => (m.content || '').toLowerCase()).join(' ');
  const msgCount = terminalMsgs.length;

  // Excitement / energy markers
  const excitedWords = ['crazy', 'awesome', 'amazing', 'works', 'fucking', 'dude', 'incredible', 'ridiculous', 'perfect', 'holy', 'wow', 'yes', 'hell yeah', 'jarvis'];
  const frustratedWords = ['broken', 'wrong', 'fail', 'error', 'stuck', 'doesn\'t work', 'why', 'wtf', 'damn', 'shit broke', 'still broken'];
  const calmWords = ['ok', 'fine', 'sure', 'alright', 'cool', 'makes sense', 'good'];

  const excitedHits = excitedWords.filter(w => recentText.includes(w)).length;
  const frustratedHits = frustratedWords.filter(w => recentText.includes(w)).length;
  const calmHits = calmWords.filter(w => recentText.includes(w)).length;

  if (excitedHits >= 2) {
    state = 'energized';
    detail = `high energy — excited about current work`;
  } else if (frustratedHits >= 2) {
    state = 'frustrated';
    detail = `hitting roadblocks — may need clearer answers`;
  } else if (excitedHits === 1) {
    state = 'engaged';
    detail = 'actively invested in the conversation';
  } else if (frustratedHits === 1) {
    state = 'impatient';
    detail = 'something isn\'t going smoothly';
  } else if (calmHits >= 1) {
    state = 'calm';
    detail = 'steady pace, normal flow';
  }

  // Message velocity — rapid-fire means urgency/excitement
  if (msgCount >= 3) {
    const times = terminalMsgs.slice(0, 3).map(m => new Date(m.created_at).getTime());
    const span = times[0] - times[2];
    if (span < 60000 && state === 'neutral') {
      state = 'focused';
      detail = 'rapid messages — deep in thought';
    }
  }

  return { state, detail };
}

// ─── Assumption inference (NOT medical — PAN's guesses ONLY) ───
// 3 states: ok, not_ok, emergency
// This is NOT a medical device. These are PAN's pattern-based guesses.
function inferWellbeing(terminalMsgs, events, hour, now) {
  // Default: ok
  let state = 'ok';
  let detail = 'normal activity patterns';

  // Check for explicit distress signals in conversation
  if (terminalMsgs.length > 0) {
    const recentText = terminalMsgs.slice(0, 5).map(m => (m.content || '').toLowerCase()).join(' ');

    // Only match FIRST-PERSON distress, not discussion about concepts.
    // Phrases like "I'm hurt" vs "people suing you" — very different.
    const emergencyWords = ['i need help', 'call 911', 'ambulance', 'can\'t breathe', 'chest pain', 'i\'m hurt', 'i fell', 'i\'m bleeding'];
    const notOkWords = ['i\'m tired', 'i\'m exhausted', 'i have a headache', 'i\'m sick', 'not feeling well', 'i need a break', 'i\'m stressed', 'i feel like shit'];

    const emergencyHits = emergencyWords.filter(w => recentText.includes(w)).length;
    const notOkHits = notOkWords.filter(w => recentText.includes(w)).length;

    if (emergencyHits >= 1) {
      state = 'emergency';
      detail = 'Commander may need help — first-person distress detected';
    } else if (notOkHits >= 1) {
      state = 'not_ok';
      detail = 'Commander mentioned not feeling well';
    }
  }

  // Time-based heuristic: very late + still active = possible fatigue
  if (state === 'ok' && (hour >= 2 && hour < 6) && terminalMsgs.length > 0) {
    state = 'not_ok';
    detail = 'active at unusual hours — possible fatigue';
  }

  return { state, detail };
}

// ─── Persist ───
function persistSnapshot(snap, trigger) {
  try {
    db.prepare(`
      INSERT INTO intuition_snapshots (commander, as_of, trigger, snapshot, confidence, source_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      snap.commander,
      snap.as_of,
      trigger,
      JSON.stringify(snap),
      snap.signals.confidence || 0,
      (snap.signals.events_sampled || 0) + (snap.signals.wrap_messages_sampled || 0)
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

// ─── Cerebras axis classification (async, non-blocking) ───
// Fires after each tick to fill in axes that the aggregator can't determine.
// Uses Cerebras Qwen 235B (free, ~220ms). Updates the snapshot in-place.
let _classifyPending = false;
const CLASSIFY_MODELS = ['cerebras:qwen-3-235b', 'ollama:qwen3:4b']; // try in order
const CLASSIFY_COOLDOWN_MS = 15000;         // min gap between classify calls
let _lastClassifyTime = 0;

function buildClassifyPrompt(snap) {
  const n = snap.now;
  const signals = [
    `Commander: ${snap.commander}`,
    `Time: ${new Date(snap.as_of).toLocaleTimeString()}`,
    n.where ? `Location: ${n.where}` : null,
    n.activity ? `Activity: ${n.activity}` : null,
    n.focus ? `Focus: ${n.focus}` : null,
    n.engagement ? `Engagement: ${n.engagement}` : null,
    (n.social || []).length > 0 ? `Social: ${n.social.join(', ')}` : null,
    n.recent_topics?.length > 0 ? `Recent topics: ${n.recent_topics.slice(0, 3).join('; ')}` : null,
    n.last_heard ? `Last said: "${n.last_heard.slice(0, 100)}"` : null,
    snap.pan?.active_tasks?.length > 0 ? `Tasks: ${snap.pan.active_tasks.slice(0, 3).map(t => t.title).join(', ')}` : null,
    snap.data?.events || null,
  ].filter(Boolean).join('\n');

  return `You are Intuition, PAN's situational awareness daemon. Given the following signals about Commander's current state, classify these axes. Reply ONLY with a JSON object, no explanation.

SIGNALS:
${signals}

Classify:
{
  "focus": "short phrase: what Commander is focused on right now",
  "direction": "short phrase: what Commander is working toward",
  "mood": "one of: calm, engaged, energized, focused, frustrated, impatient, relaxed, winding_down, starting_up",
  "mood_detail": "one sentence explaining why",
  "urgency": "one of: low, normal, elevated, high, critical",
  "need": "short phrase: what Commander needs from PAN right now, or null",
  "complexity": "one of: simple, moderate, complex, deep",
  "assumption": "one of: ok, not_ok, emergency",
  "assumption_detail": "one sentence: PAN's guess about Commander's wellbeing (NOT medical advice)"
}`;
}

// Call Ollama directly (bypass askAI for local models)
async function callOllama(prompt, model = 'qwen3:4b') {
  const resp = await fetch(`${getOllamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { temperature: 0.3, num_predict: 300 },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
  const data = await resp.json();
  return data.message?.content || '';
}

async function classifyAxes(snap) {
  if (_classifyPending) { console.log('[Intuition] classify skipped: pending'); return; }
  const now = Date.now();
  if (now - _lastClassifyTime < CLASSIFY_COOLDOWN_MS) { console.log('[Intuition] classify skipped: cooldown'); return; }

  _classifyPending = true;
  _lastClassifyTime = now;
  const debugFile = path.join(path.dirname(INTUITION_FILE), 'intuition-debug.log');
  const dbg = (msg) => { console.log(msg); try { fs.appendFileSync(debugFile, new Date().toISOString() + ' ' + msg + '\n'); } catch {} };
  dbg('[Intuition] classify starting...');

  try {
    const prompt = buildClassifyPrompt(snap);
    let raw = null;
    let usedModel = null;

    // Try Cerebras first, fall back to local Ollama
    for (const model of CLASSIFY_MODELS) {
      try {
        if (model.startsWith('ollama:')) {
          raw = await callOllama(prompt, model.replace('ollama:', ''));
          usedModel = model;
        } else {
          raw = await askAI(prompt, {
            model,
            timeout: 5000,
            maxTokens: 250,
            caller: 'intuition-classifier',
            _skipAnonymize: true,
          });
          usedModel = model;
        }
        if (raw) break;
      } catch (e) {
        dbg(`[Intuition] ${model} failed: ${e.message}, trying next...`);
      }
    }

    if (!raw) { _classifyPending = false; return; }

    // Parse response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { _classifyPending = false; return; }

    const classified = JSON.parse(jsonMatch[0]);

    // Merge classified values into the live snapshot (Title Case)
    if (classified.focus) snap.now.focus = titleCase(classified.focus);
    if (classified.direction) snap.now.direction = titleCase(classified.direction);
    if (classified.mood) snap.now.mood = titleCase(classified.mood.replace(/_/g, ' '));
    if (classified.mood_detail) snap.now.mood_detail = classified.mood_detail.charAt(0).toUpperCase() + classified.mood_detail.slice(1);
    if (classified.urgency) snap.now.urgency = titleCase(classified.urgency);
    if (classified.need && classified.need !== 'null') snap.now.need = titleCase(classified.need);
    if (classified.complexity) snap.now.complexity = titleCase(classified.complexity);
    if (classified.assumption) snap.now.assumption = titleCase(classified.assumption.replace(/_/g, ' '));
    if (classified.assumption_detail) snap.now.assumption_detail = classified.assumption_detail.charAt(0).toUpperCase() + classified.assumption_detail.slice(1);

    // Mark as AI-classified
    snap.meta.classifier = usedModel;
    snap.meta.classified_at = Date.now();
    snap.signals.confidence = Math.min((snap.signals.confidence || 0) + 0.25, 1.0);

    // Re-persist with classified values
    persistSnapshot(snap, snap.trigger + '+classified');
    _lastSnapshot = snap;

    dbg(`[Intuition] classified via ${usedModel}: mood=${classified.mood} focus="${classified.focus}" complexity=${classified.complexity} (${Date.now() - now}ms)`);
  } catch (e) {
    dbg(`[Intuition] classify OUTER failed: ${e.message}\n${e.stack}`);
  } finally {
    _classifyPending = false;
  }
}

// ─── Public: tick + accessors ───
export function tickIntuition(trigger = 'heartbeat') {
  if (!_running) return null;
  try {
    const snap = buildSnapshot(trigger);
    persistSnapshot(snap, trigger);
    _lastSnapshot = snap;

    // Fire async classification (non-blocking, updates snapshot later)
    classifyAxes(snap).catch(e => console.warn('[Intuition] classifyAxes unhandled:', e.message));

    if (_onTickCallback) _onTickCallback();
    return snap;
  } catch (e) {
    console.warn('[Intuition] tick failed:', e.message);
    return null;
  }
}

export function getCurrentSnapshot() {
  if (_lastSnapshot) return _lastSnapshot;
  // Fall back to most recent DB row
  try {
    const row = get(`SELECT snapshot FROM intuition_snapshots ORDER BY as_of DESC LIMIT 1`);
    if (row?.snapshot) return JSON.parse(row.snapshot);
  } catch {}
  // Fall back to disk
  try {
    if (fs.existsSync(INTUITION_FILE)) return JSON.parse(fs.readFileSync(INTUITION_FILE, 'utf8'));
  } catch {}
  return null;
}

export function getSnapshotHistory(limit = 50) {
  const rows = all(`
    SELECT id, commander, as_of, trigger, confidence, source_count, snapshot
    FROM intuition_snapshots ORDER BY as_of DESC LIMIT ?
  `, [limit]);
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
