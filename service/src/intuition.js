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
import { db, get, all } from './db.js';

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

// ─── Topic extraction (v1: keyword + pattern, no LLM) ───
// Turns raw conversation messages into a short intelligible topic string.
// Looks for nouns/concepts that repeat across messages, strips filler.
function extractTopic(messages, projectName) {
  if (!messages || messages.length === 0) return null;

  // Combine last 3 messages into one text blob
  const blob = messages.slice(0, 3)
    .map(m => (m.content || '').toLowerCase())
    .join(' ')
    .replace(/[^a-z0-9\s\-_]/g, ' ')     // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();

  if (!blob) return null;

  // Stop words to filter out
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
    'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
    'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
    'just', 'don', 'now', 'and', 'but', 'or', 'if', 'because', 'while',
    'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'you', 'your',
    'he', 'she', 'it', 'they', 'them', 'its', 'his', 'her', 'our', 'their',
    'what', 'which', 'who', 'whom', 'about', 'up', 'like', 'know', 'think',
    'want', 'make', 'going', 'gonna', 'really', 'actually', 'basically',
    'something', 'thing', 'things', 'stuff', 'way', 'right', 'yeah', 'ok',
    'well', 'also', 'get', 'got', 'let', 'put', 'say', 'said', 'tell',
    'much', 'even', 'still', 'already', 'kind', 'kinda', 'pretty', 'cause',
  ]);

  // Count meaningful words (2+ chars, not stop words)
  const words = blob.split(' ').filter(w => w.length > 2 && !stopWords.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;

  // Sort by frequency, take top concepts
  const topWords = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);

  if (topWords.length === 0) return projectName ? `${projectName.toLowerCase()} development` : null;

  // Build a readable topic from top 2-3 words
  // If project name appears, don't repeat it
  const filtered = topWords.filter(w => w !== (projectName || '').toLowerCase());
  const topic = filtered.slice(0, 3).join(' + ');

  return topic || (projectName ? `${projectName.toLowerCase()} development` : null);
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

  // ─── ACTIVITY — what Commander is actually doing ───
  // Priority: active Claude session > active tasks > wrapper apps > idle
  let activity = 'idle';
  const activeSessions = panSessions.filter(s => s.claudeRunning);
  const activeProject = activeSessions.find(s => s.project);
  const inProgressTasks = activeTasks.filter(t => t.status === 'in_progress');
  if (activeProject) {
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

  // ─── Recent topics (blend terminal + wrap) ───
  const recentTopics = [];
  for (const m of recentTerminalMsgs.slice(0, 3)) {
    const t = (m.content || '').slice(0, 80);
    if (t) recentTopics.push(t);
  }
  for (const m of recentWrap.slice(0, 3)) {
    const t = (m.text || '').slice(0, 80);
    if (t && !recentTopics.includes(t)) recentTopics.push(t);
  }

  const lastHeard = recentTerminalMsgs[0]?.content || recentWrap[0]?.text || null;
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
      ? `${recentTerminalMsgs.length} messages in active session`
      : 'no active conversation',
    conversations: recentWrap.length > 0
      ? `${recentWrap.length} msgs, latest from ${lastSender || 'unknown'}: "${(recentWrap[0]?.text || '').slice(0, 50)}"`
      : 'no recent messages',
    events: recentEvents.length > 0
      ? `${recentEvents.length} events (${[...new Set(recentEvents.map(e => e.event_type))].slice(0, 5).join(', ')})`
      : 'no recent events',
    camera: null,                            // ⏳ pendant
    audio: null,                             // ⏳ pendant
    sensors: sensorsActive.size > 0 ? `active: ${[...sensorsActive].join(', ')}` : 'none active',
    location: where || null,                 // desktop inference for now, pendant GPS later
    apps: activeApps.size > 0 ? [...activeApps].join(', ') : 'none detected',
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
      where,
      activity,
      social: [...social],
      focus,
      mood: mood.state,
      mood_detail: mood.detail,
      assumption: wellbeing.state,               // ok | not_ok | emergency
      assumption_detail: wellbeing.detail,       // PAN's guess — NOT medical advice
      urgency,
      direction,
      need: null,                               // needs deeper classifier
      engagement,
      complexity: null,                         // needs classifier
      recent_topics: recentTopics.slice(0, 5),
      last_heard: lastHeard ? lastHeard.slice(0, 120) : null,
      last_seen: null,                          // ⏳ pendant camera
    },
    pan: {
      sessions: panSessions,
      active_tasks: activeTasks,
      predictions,
      status: panSessions.length > 0 ? 'active' : 'idle',
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
}

// ─── Public: tick + accessors ───
export function tickIntuition(trigger = 'heartbeat') {
  if (!_running) return null;
  try {
    const snap = buildSnapshot(trigger);
    persistSnapshot(snap, trigger);
    _lastSnapshot = snap;
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

// ─── Service lifecycle (for Steward) ───
export function startIntuition(intervalMs = INTUITION_TICK_MS) {
  if (_running) return;
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
