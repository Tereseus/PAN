import { Router } from 'express';
import { insert, all, get, run, indexEventFTS } from '../db.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFilePromise = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = join(__dirname, '..', 'data', 'photos');
if (!existsSync(PHOTOS_DIR)) mkdirSync(PHOTOS_DIR, { recursive: true });

const UI_SCRIPT = join(__dirname, '..', 'ui-automation.py');

// Pending desktop actions queue — shared between all routes
// Desktop agent (Electron tray) polls /actions and executes these
const pendingActions = [];

const router = Router();

// Insert event + auto-index into FTS (attaches user_id from req.user if available)
function insertEvent(sid, eventType, dataStr, userId) {
  const eventId = insert(`INSERT INTO events (session_id, event_type, data, user_id)
    VALUES (:sid, :type, :data, :uid)`, {
    ':sid': sid, ':type': eventType, ':data': dataStr, ':uid': userId || null
  });
  indexEventFTS(eventId, eventType, dataStr);
  return eventId;
}

// Auto-register phone when it connects
router.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  // Only register non-localhost (phone comes from LAN)
  if (ip !== '127.0.0.1' && ip !== '::1' && !ip.endsWith('127.0.0.1')) {
    const phoneHost = `phone-${ip.replace(/[^0-9.]/g, '')}`;
    const deviceName = req.headers['x-device-name'];
    const existing = get("SELECT * FROM devices WHERE hostname = :h", { ':h': phoneHost });
    if (!existing) {
      insert(`INSERT INTO devices (hostname, name, device_type, capabilities, last_seen)
        VALUES (:h, :name, 'phone', '["voice","camera","sensors"]', datetime('now','localtime'))`, {
        ':h': phoneHost, ':name': deviceName || 'Phone'
      });
    } else if (deviceName) {
      // Update name + last_seen only if phone sent its name
      run("UPDATE devices SET name = :name, last_seen = datetime('now','localtime') WHERE hostname = :h",
        { ':name': deviceName, ':h': phoneHost });
    } else {
      // No name header — just update last_seen
      run("UPDATE devices SET last_seen = datetime('now','localtime') WHERE hostname = :h", { ':h': phoneHost });
    }
  }
  next();
});

// Utterance aggregation
const MERGE_WINDOW_MS = 8000;
let lastAudioTime = 0;
let lastAudioSessionId = null;
let lastAudioUserId = null;
let utteranceBuffer = [];
let flushTimer = null;

function flushUtterance() {
  if (utteranceBuffer.length === 0) return;

  const fullText = utteranceBuffer.join(' ');
  const sid = lastAudioSessionId || `phone-${Date.now()}`;

  insertEvent(sid, 'PhoneAudio', JSON.stringify({
    transcript: fullText,
    timestamp: Date.now(),
    duration_ms: 0,
    source: 'phone_mic',
    fragment_count: utteranceBuffer.length
  }), lastAudioUserId);

  console.log(`[PAN] Utterance (${utteranceBuffer.length} fragments): ${fullText.slice(0, 100)}...`);
  utteranceBuffer = [];
  lastAudioSessionId = null;
}

router.post('/audio', (req, res) => {
  const { transcript, timestamp, duration_ms, source } = req.body;
  const now = Date.now();

  if (!transcript || transcript.startsWith('[raw_audio:')) {
    return res.json({ ok: true });
  }

  if (now - lastAudioTime > MERGE_WINDOW_MS && utteranceBuffer.length > 0) {
    flushUtterance();
  }

  utteranceBuffer.push(transcript);
  lastAudioUserId = req.user?.id || null;
  lastAudioTime = now;
  if (!lastAudioSessionId) lastAudioSessionId = `phone-${now}`;

  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushUtterance, MERGE_WINDOW_MS);

  res.json({ ok: true });
});

router.post('/photo', (req, res) => {
  const { jpeg_base64, timestamp, source } = req.body;

  insertEvent(`Pandant-${Date.now()}`, 'PandantPhoto', JSON.stringify({ timestamp, source, size: jpeg_base64?.length || 0 }), req.user?.id);

  res.json({ ok: true });
});

router.post('/vision', async (req, res) => {
  const { image_base64, question } = req.body;

  if (!image_base64) {
    return res.status(400).json({ error: 'missing image_base64' });
  }

  try {
    const { claudeVision } = await import('../claude.js');
    const prompt = question || 'What is in this image? Describe it concisely in 1-3 sentences.';
    console.log(`[PAN Vision] Analyzing image (${image_base64.length} chars), question: "${prompt.slice(0, 80)}"`);

    const description = await claudeVision(prompt, image_base64, { caller: 'vision' });
    console.log(`[PAN Vision] Result: ${description.slice(0, 100)}`);

    // Save the image to disk
    const photoId = `vision-${Date.now()}`;
    const photoFilename = `${photoId}.jpg`;
    try {
      writeFileSync(join(PHOTOS_DIR, photoFilename), Buffer.from(image_base64, 'base64'));
      console.log(`[PAN Vision] Image saved: ${photoFilename}`);
    } catch (e) {
      console.error(`[PAN Vision] Failed to save image: ${e.message}`);
    }

    // Log the vision event with photo path
    insertEvent(photoId, 'VisionAnalysis', JSON.stringify({
        question: prompt,
        description: description.slice(0, 500),
        image_file: photoFilename,
        image_size: image_base64.length,
        timestamp: Date.now()
      }), req.user?.id);

    res.json({ description });
  } catch (err) {
    console.error('[PAN Vision] Error:', err.message);
    res.status(500).json({ error: 'Vision analysis failed', description: 'I could not analyze the image right now.' });
  }
});

// Recall — smart conversation search. Haiku extracts keywords, SQL pre-filters, Haiku summarizes.
// Searches ALL event types: RouterCommand (Q&A), PhoneAudio (voice), UserPromptSubmit (terminal prompts), VisionAnalysis.
router.post('/recall', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  try {
    const { claude } = await import('../claude.js');
    const startTime = Date.now();

    // Step 1: FTS5 search — instant ranked results from any DB size
    // Extract search terms (strip common words)
    const stopWords = new Set(['what','when','where','who','how','did','do','does','is','are','was','were',
      'the','a','an','in','on','at','to','for','of','and','or','but','with','about','we','i','me','my',
      'you','your','it','that','this','have','has','had','can','could','would','should','will',
      'talk','talked','say','said','discuss','discussed','tell','told','remember','recall','find',
      'search','look','know','think','before','something','anything','stuff','things']);
    const searchTerms = text.toLowerCase().split(/\s+/)
      .map(w => w.replace(/[^a-z0-9]/g, ''))
      .filter(w => w.length > 2 && !stopWords.has(w));

    let ftsResults = [];
    if (searchTerms.length > 0) {
      // FTS5 query — use OR so any matching term scores
      const ftsQuery = searchTerms.join(' OR ');
      try {
        ftsResults = all(
          `SELECT f.rowid as event_id, e.event_type, e.created_at, e.data,
                  rank as fts_rank
           FROM events_fts f
           JOIN events e ON e.id = f.rowid
           WHERE events_fts MATCH :q
           ORDER BY rank
           LIMIT 100`,
          { ':q': ftsQuery }
        );
      } catch (err) {
        console.error('[PAN Recall] FTS error:', err.message);
      }
    }

    // Step 2: Also get recent events as fallback context
    const recentEvents = all(
      `SELECT id, event_type, data, created_at FROM events
       WHERE event_type NOT IN ('SessionEnd', 'SessionStart')
       ORDER BY created_at DESC LIMIT 30`
    );

    // Step 3: Build clean snippets from FTS results + recent
    function extractSnippet(e) {
      let data = {};
      try { data = JSON.parse(e.data); } catch { return null; }
      if (e.event_type === 'RouterCommand') {
        const q = data.text || ''; const a = data.result || data.response_text || '';
        if (q || a) return `Voice: "${q}" → ${a}`;
      } else if (e.event_type === 'UserPromptSubmit') {
        const p = data.prompt || '';
        if (p.length >= 10 && !p.startsWith('{')) return `Terminal: ${p}`;
      } else if (e.event_type === 'Stop') {
        const m = data.last_assistant_message || '';
        if (m.length >= 20) return `Claude: ${m}`;
      } else if (e.event_type === 'PhoneAudio') {
        const t = data.transcript || '';
        const finals = t.match(/Final: (.+?)(?:\[|Heard|$)/g)
          ?.map(m => m.replace(/^Final: /, '').replace(/\[.*$/, '').trim())
          .filter(Boolean).join('; ');
        if (finals) return `Heard: ${finals}`;
      } else if (e.event_type === 'VisionAnalysis') {
        const d = data.description || data.result || '';
        if (d) return `Saw: ${d}`;
      }
      return null;
    }

    // Deduplicate and merge FTS results + recent
    const seen = new Set();
    const entries = [];
    for (const e of ftsResults) {
      if (seen.has(e.event_id)) continue;
      seen.add(e.event_id);
      const snippet = extractSnippet(e);
      if (snippet) entries.push({ time: e.created_at, text: snippet.slice(0, 500), source: 'search' });
    }
    for (const e of recentEvents) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const snippet = extractSnippet(e);
      if (snippet) entries.push({ time: e.created_at, text: snippet.slice(0, 500), source: 'recent' });
    }

    if (entries.length === 0) {
      return res.json({ response_text: "No conversation history to search through." });
    }

    // Step 4: Build context — FTS results first (most relevant), then recent for background
    const TOKEN_BUDGET = 60000; // ~15K tokens
    let snippetText = '';
    let count = 0;
    for (const e of entries) {
      const line = `[${e.time}] ${e.text}\n`;
      if (snippetText.length + line.length > TOKEN_BUDGET) break;
      snippetText += line;
      count++;
    }

    const totalEvents = get('SELECT COUNT(*) as c FROM events')?.c || 0;

    // Step 5: Single Haiku call
    const summary = await claude(
      `You are PAN, a personal AI memory system. The user asked: "${text}"

Here are ${count} matching entries from their history (${totalEvents} total events in database, ${ftsResults.length} matched the search "${searchTerms.join(' ')}"):

${snippetText}
Answer the user's question based on these results. Be specific — mention dates, exact details, and what was said. If the answer isn't in the data, say so honestly. Keep it to 2-4 sentences, conversational tone.`,
      { maxTokens: 600, timeout: 30000, caller: 'recall' }
    );

    const elapsed = Date.now() - startTime;
    console.log(`[PAN Recall] "${text}" → FTS:${ftsResults.length} + recent:${recentEvents.length} = ${count} sent to Haiku, ${elapsed}ms`);
    res.json({ response_text: summary.trim() });
  } catch (err) {
    console.error('[PAN Recall] Error:', err.message);
    res.json({ response_text: 'I had trouble searching through conversations.' });
  }
});

// UI Automation — queued for desktop agent execution
// The PAN service runs as LOCAL SYSTEM which can't see the user's desktop.
// UI commands get queued here, the Electron tray app (user session) executes them.
const pendingUiRequests = new Map(); // id -> { resolve, reject, timeout }

router.post('/ui', (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'missing command' });

  const id = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Queue the command for the desktop agent
  pendingActions.push({
    id, type: 'ui_automation', command,
    timestamp: new Date().toISOString()
  });

  // Wait for the desktop agent to execute and return the result
  const timeout = setTimeout(() => {
    pendingUiRequests.delete(id);
    res.json({ ok: false, error: 'Desktop agent timeout — is the tray app running?' });
  }, 30000);

  pendingUiRequests.set(id, {
    resolve: (result) => {
      clearTimeout(timeout);
      pendingUiRequests.delete(id);
      insertEvent(id, 'UIAutomation', JSON.stringify({ command, result: result.ok ? 'success' : result.error, timestamp: Date.now() }), req.user?.id);
      res.json(result);
    }
  });
});

// Desktop agent posts UI results back here
router.post('/ui/result', (req, res) => {
  const { id, result } = req.body;
  const pending = pendingUiRequests.get(id);
  if (pending) {
    pending.resolve(result || { ok: false, error: 'empty result' });
  }
  res.json({ ok: true });
});

// GET /api/v1/ui/screenshot — convenience endpoint
router.get('/ui/screenshot', (req, res) => {
  // Queue a screenshot command and wait for result
  const id = `ui-ss-${Date.now()}`;
  pendingActions.push({ id, type: 'ui_automation', command: 'screenshot', timestamp: new Date().toISOString() });

  const timeout = setTimeout(() => {
    pendingUiRequests.delete(id);
    res.status(504).json({ ok: false, error: 'timeout' });
  }, 10000);

  pendingUiRequests.set(id, {
    resolve: (result) => {
      clearTimeout(timeout);
      pendingUiRequests.delete(id);
      if (result.ok && result.image_base64) {
        res.set('Content-Type', 'image/jpeg');
        res.send(Buffer.from(result.image_base64, 'base64'));
      } else {
        res.status(500).json(result);
      }
    }
  });
});

// Browser extension bridge — the extension polls for commands and returns results
const pendingBrowserCommands = [];
const pendingBrowserResults = new Map(); // id -> { resolve, timeout }

// Extension polls this for pending commands
router.get('/browser/commands', (req, res) => {
  const commands = [...pendingBrowserCommands];
  pendingBrowserCommands.length = 0;
  res.json(commands);
});

// Extension sends results back here
router.post('/browser/result', (req, res) => {
  const { id, result } = req.body;
  const pending = pendingBrowserResults.get(id);
  if (pending) {
    pending.resolve(result);
    pendingBrowserResults.delete(id);
  }
  res.json({ ok: true });
});

// Internal: send a browser command and wait for result
async function browserCommand(action, params = {}, timeoutMs = 10000) {
  const id = `br-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  pendingBrowserCommands.push({ id, action, ...params });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingBrowserResults.delete(id);
      resolve({ ok: false, error: 'Browser extension timeout — is it installed?' });
    }, timeoutMs);

    pendingBrowserResults.set(id, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      }
    });
  });
}

// Public API for browser commands
router.post('/browser', async (req, res) => {
  const { action, ...params } = req.body;
  if (!action) return res.status(400).json({ error: 'missing action' });

  const result = await browserCommand(action, params);

  // Log browser actions
  insertEvent(`browser-${Date.now()}`, 'BrowserAction', JSON.stringify({ action, params, success: result.ok, timestamp: Date.now() }), req.user?.id);

  res.json(result);
});

// Export browserCommand for use by router.js
globalThis._panBrowserCommand = browserCommand;

// Phone accessibility service bridge
const pendingA11yCommands = [];
const pendingA11yResults = new Map();

router.get('/accessibility/commands', (req, res) => {
  const commands = [...pendingA11yCommands];
  pendingA11yCommands.length = 0;
  res.json(commands);
});

router.post('/accessibility/result', (req, res) => {
  const { id, result } = req.body;
  const pending = pendingA11yResults.get(id);
  if (pending) {
    pending.resolve(result);
    pendingA11yResults.delete(id);
  }
  res.json({ ok: true });
});

router.post('/accessibility', async (req, res) => {
  const { action, ...params } = req.body;
  if (!action) return res.status(400).json({ error: 'missing action' });

  const id = `a11y-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  pendingA11yCommands.push({ id, action, ...params });

  const timeout = setTimeout(() => {
    pendingA11yResults.delete(id);
    res.json({ ok: false, error: 'Accessibility service timeout — is it enabled in Android Settings?' });
  }, 15000);

  pendingA11yResults.set(id, {
    resolve: (result) => {
      clearTimeout(timeout);
      pendingA11yResults.delete(id);
      res.json(result);
    }
  });
});

router.post('/sensor', (req, res) => {
  const { sensor_type, values, timestamp } = req.body;

  insertEvent(`Pandant-${Date.now()}`, 'SensorData', JSON.stringify({ sensor_type, values, timestamp }), req.user?.id);

  res.json({ ok: true });
});

router.post('/query', async (req, res) => {
  const { text, context, intent_hint, sensors } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'missing text' });
  }

  try {
    const hostname = (await import('os')).hostname();

    // Create command record first so router can log against it
    const cmdId = insert(`INSERT INTO command_queue (target_device, command_type, command, text, status)
      VALUES (:target, 'processing', '', :text, 'processing')`, {
      ':target': hostname,
      ':text': text
    });

    const { route } = await import('../router.js');
    // Parse sensors — may be a JSON string or object
    let parsedSensors = sensors;
    if (typeof sensors === 'string') {
      try { parsedSensors = JSON.parse(sensors); } catch { parsedSensors = null; }
    }
    const result = await route(text, { source: 'phone', intent_hint, _commandId: cmdId, conversation_history: context, sensors: parsedSensors });

    // Update the command record with results
    if (result.intent === 'terminal' && result.terminalResult) {
      // WezTerm handled it directly — mark as completed, no tray queue needed
      run(`UPDATE command_queue SET command_type = 'terminal', status = 'completed', result = :result WHERE id = :id`, {
        ':id': cmdId, ':result': JSON.stringify(result.terminalResult)
      });
    } else if (result.intent === 'terminal' && result.terminalAction) {
      // Fallback: queue for tray agent
      run(`UPDATE command_queue SET command_type = 'terminal', command = :cmd, status = 'pending' WHERE id = :id`, {
        ':id': cmdId, ':cmd': JSON.stringify(result.terminalAction)
      });
      pendingActions.push({ id: cmdId, type: 'terminal', ...result.terminalAction, timestamp: new Date().toISOString() });
    } else if (result.desktopAction) {
      run(`UPDATE command_queue SET command_type = :type, command = :cmd, status = 'pending' WHERE id = :id`, {
        ':id': cmdId, ':type': result.desktopAction.type || 'command', ':cmd': result.desktopAction.command || ''
      });
      pendingActions.push({ id: cmdId, ...result.desktopAction, timestamp: new Date().toISOString() });
    } else {
      run(`UPDATE command_queue SET command_type = :type, status = 'completed', result = :result WHERE id = :id`, {
        ':id': cmdId, ':type': result.intent, ':result': result.response
      });
    }

    res.json({
      response_text: result.response,
      intent: result.intent,
      route: result.intent || null,
      query: result.query || result.searchTerm || null,
      action: result.action || null,
      response_time_ms: result.response_time_ms || null
    });
  } catch (err) {
    console.error('[PAN] Query error:', err.message);
    res.json({ response_text: 'PAN is having trouble thinking right now. Try again.' });
  }
});

// Desktop agent polls this for pending actions
router.get('/actions', (req, res) => {
  const actions = [...pendingActions];
  pendingActions.length = 0; // Clear after reading
  res.json(actions);
});

router.post('/sync', (req, res) => {
  const { uploads } = req.body;

  if (!Array.isArray(uploads)) {
    return res.status(400).json({ error: 'uploads must be an array' });
  }

  let count = 0;
  for (const item of uploads) {
    insertEvent(`phone-sync-${Date.now()}`, `PhoneSync_${item.type}`, item.payload, req.user?.id);
    count++;
  }

  res.json({ ok: true, synced: count });
});

router.get('/recent', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const events = all(`SELECT * FROM events WHERE event_type = 'PhoneAudio' ORDER BY created_at DESC LIMIT :limit`, {
    ':limit': limit
  });

  const results = events.map(e => {
    const data = JSON.parse(e.data);
    return {
      timestamp: e.created_at,
      transcript: data.transcript,
      fragments: data.fragment_count || 1,
      source: data.source
    };
  });

  res.json(results);
});

router.get('/stats', (req, res) => {
  const stats = get(`SELECT
    (SELECT COUNT(*) FROM events) as total_events,
    (SELECT COUNT(*) FROM events WHERE event_type = 'PhoneAudio') as audio_events,
    (SELECT COUNT(*) FROM projects) as projects,
    (SELECT COUNT(*) FROM memory_items) as memory_items
  `);
  res.json(stats);
});

// ── Resistance Router API ──
// Phone and PC both call these to get action plans and report results

import { getActionPlan, reportResult, reportLastFailed, setPreference, getPreference, getAllPreferences, getResistanceStats } from '../resistance.js';

// GET /api/v1/resistance/plan?action=play_music&platform=android
// Returns ordered list of methods to try
router.get('/resistance/plan', (req, res) => {
  const { action, platform } = req.query;
  if (!action) return res.status(400).json({ error: 'action required' });
  const plan = getActionPlan(action, platform || 'pc');
  res.json(plan);
});

// POST /api/v1/resistance/result — report success or failure of a path
router.post('/resistance/result', (req, res) => {
  const { action, path, success, error, duration_ms } = req.body;
  if (!action || !path) return res.status(400).json({ error: 'action and path required' });
  reportResult(action, path, success, error, duration_ms);
  res.json({ ok: true });
});

// POST /api/v1/resistance/failed — "that didn't work" — log failure, get next suggestion
router.post('/resistance/failed', (req, res) => {
  const { action, platform } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });
  const result = reportLastFailed(action, platform || 'pc');
  res.json(result);
});

// POST /api/v1/resistance/preference — set preferred app for an action
router.post('/resistance/preference', (req, res) => {
  const { action, preferred } = req.body;
  if (!action || !preferred) return res.status(400).json({ error: 'action and preferred required' });
  setPreference(action, preferred);
  res.json({ ok: true, action, preferred });
});

// GET /api/v1/resistance/preferences — get all preferences
router.get('/resistance/preferences', (req, res) => {
  res.json(getAllPreferences());
});

// GET /api/v1/resistance/stats — dashboard stats
router.get('/resistance/stats', (req, res) => {
  res.json(getResistanceStats());
});

export default router;
