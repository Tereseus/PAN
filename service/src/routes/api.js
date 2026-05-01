import { Router } from 'express';
import { insert, all, get, run, db, logEvent, anonymize, anonymizeEventData, allScoped, getScoped, runScoped, insertScoped } from '../db.js';
import { logEventScoped } from '../events.js';
import { getActiveOrg, isIncognitoAllowed } from '../org-policy.js';
import { requireOrg } from '../middleware/org-context.js';
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

// Tier 0 Phase 2: Apply org context to all API routes.
// Attaches req.org_id and req.membership. Falls back to org_personal.
router.use(requireOrg);

// Org management moved to /api/v1/orgs (routes/orgs.js)

// Dashboard chat — routes through AI router with dashboard source tag
router.post('/chat', async (req, res) => {
  const { message, project_id, source } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const { route } = await import('../router.js');
    const result = await route(message, { source: source || 'dashboard', project_id });
    insertEvent('dashboard-chat', 'DashboardChat', JSON.stringify({
      query: message, response: (result.response || '').slice(0, 2000), project_id, source: 'dashboard',
      speech_act: result.speech_act || null, intent: result.intent || null
    }), req.user?.id);
    res.json({ response: result.response || 'No response' });
  } catch (err) {
    console.error('[PAN Chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Centralized event logging — scope-aware. Reads X-PAN-Scope from the request
// (set by the phone when in incognito mode) and routes the write to the
// matching SQLCipher file. 'main' is the canonical pan.db. Anything else is a
// sibling DB lazily created by db-registry. The scope/req-aware overload is
// the preferred form; the legacy 4-arg form keeps existing call sites working.
function insertEvent(sidOrReq, eventType, dataStr, userId) {
  // Overload: insertEvent(req, type, data, userId)
  if (sidOrReq && typeof sidOrReq === 'object' && sidOrReq.headers) {
    const req = sidOrReq;
    const scope = req.panScope || 'main';
    const sid = req.headers['x-session-id'] || `phone-${(req.headers['x-device-name'] || 'unknown').toString().toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    return logEventScoped(scope, sid, eventType, dataStr, userId);
  }
  // Legacy form: insertEvent(sid, type, data, userId) → main scope
  return logEvent(sidOrReq, eventType, dataStr, userId);
}

// Scope middleware: read X-PAN-Scope into req.panScope so downstream
// handlers can pass it through to logEventScoped / searchMemory. Defaults
// to 'main' so anything that doesn't set the header keeps working.
//
// Tier 0 Phase 4: enforce org policy. If the active org disallows incognito
// (policy_incognito_allowed = 0), downgrade the scope to 'main' and surface
// the denial via the X-PAN-Scope-Denied response header so the phone can
// grey out the toggle and show "Disabled by your organization".
router.use((req, res, next) => {
  const raw = (req.headers['x-pan-scope'] || 'main').toString().trim();
  // Whitelist: lowercase letters, digits, hyphen. Prevent header injection
  // from creating arbitrary file paths via the lazy-create DB code path.
  let scope = /^[a-z0-9-]{1,32}$/.test(raw) ? raw : 'main';

  if (scope === 'incognito' && !isIncognitoAllowed(req)) {
    res.setHeader('X-PAN-Scope-Denied', 'incognito');
    scope = 'main';
  }

  req.panScope = scope;
  next();
});

// Auto-register phone when it connects
// Uses device name as stable identifier (not IP, which changes with WiFi/Tailscale)
router.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  // Only register non-localhost (phone comes from LAN/Tailscale)
  if (ip !== '127.0.0.1' && ip !== '::1' && !ip.endsWith('127.0.0.1')) {
    const deviceName = req.headers['x-device-name'] || 'Phone';
    const deviceId = req.headers['x-device-id']; // stable Android ID if sent
    // Use stable key: device-id header > device name > fallback to IP
    const phoneHost = deviceId ? `phone-${deviceId}` : `phone-${deviceName.replace(/\s+/g, '-').toLowerCase()}`;

    const existing = getScoped(req, "SELECT * FROM devices WHERE hostname = :h AND org_id = :org_id", { ':h': phoneHost });
    if (!existing) {
      // Also check for any old IP-based entries for this device name and remove them
      runScoped(req, "DELETE FROM devices WHERE device_type = 'phone' AND name = :name AND hostname != :h AND org_id = :org_id",
        { ':name': deviceName, ':h': phoneHost });
      insertScoped(req, `INSERT INTO devices (hostname, name, device_type, capabilities, last_seen, org_id)
        VALUES (:h, :name, 'phone', '["voice","camera","sensors"]', datetime('now','localtime'), :org_id)`, {
        ':h': phoneHost, ':name': deviceName
      });
    } else {
      // Update name + last_seen
      runScoped(req, "UPDATE devices SET name = :name, last_seen = datetime('now','localtime') WHERE hostname = :h AND org_id = :org_id",
        { ':name': deviceName, ':h': phoneHost });
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
  console.log(`[PAN Audio] POST /audio: source=${source} transcript="${(transcript||'').slice(0,80)}" from=${req.ip}`);
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
    const { analyzeImage } = await import('../claude.js');
    const prompt = question || 'What is in this image? Describe it concisely in 1-3 sentences.';
    console.log(`[PAN Vision] Analyzing image (${image_base64.length} chars), question: "${prompt.slice(0, 80)}"`);

    const description = await analyzeImage(prompt, image_base64, { caller: 'vision' });
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
    console.error('[PAN Vision] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Vision analysis failed', detail: err.message, description: 'I could not analyze the image right now.' });
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
        ftsResults = allScoped(req,
          `SELECT f.rowid as event_id, e.event_type, e.created_at, e.data,
                  rank as fts_rank
           FROM events_fts f
           JOIN events e ON e.id = f.rowid
           WHERE events_fts MATCH :q AND e.org_id = :org_id
           ORDER BY rank
           LIMIT 100`,
          { ':q': ftsQuery }
        );
      } catch (err) {
        console.error('[PAN Recall] FTS error:', err.message);
      }
    }

    // Step 2: Also get recent events as fallback context
    const recentEvents = allScoped(req,
      `SELECT id, event_type, data, created_at FROM events
       WHERE event_type NOT IN ('SessionEnd', 'SessionStart') AND org_id = :org_id
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

    const totalEvents = getScoped(req, 'SELECT COUNT(*) as c FROM events WHERE org_id = :org_id')?.c || 0;

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

  // Extract device identity from headers (phone sends these)
  const device_id = req.headers['x-device-id'] || req.headers['x-device-name'] || null;
  const device_type = 'phone';

  if (!text) {
    return res.status(400).json({ error: 'missing text' });
  }

  try {
    const hostname = (await import('os')).hostname();

    // Create command record first so router can log against it
    const cmdId = insertScoped(req, `INSERT INTO command_queue (target_device, command_type, command, text, status, org_id)
      VALUES (:target, 'processing', '', :text, 'processing', :org_id)`, {
      ':target': hostname,
      ':text': text
    });

    const { route } = await import('../router.js');
    // Parse sensors — may be a JSON string or object
    let parsedSensors = sensors;
    if (typeof sensors === 'string') {
      try { parsedSensors = JSON.parse(sensors); } catch { parsedSensors = null; }
    }
    const result = await route(text, {
      source: 'phone',
      device_id,
      intent_hint,
      _commandId: cmdId,
      conversation_history: context,
      sensors: parsedSensors
    });

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

    // Log voice event with speech_act + speaker for Augur/Intuition
    insertEvent(req, 'VoiceCommand', JSON.stringify({
      text,
      speech_act: result.speech_act || 'command',
      intent: result.intent,
      speaker_id: req.body.speaker_id || null,
      speaker_confidence: req.body.speaker_confidence || null,
      response: (result.response || '').slice(0, 500),
      response_time_ms: result.response_time_ms || null,
    }), req.user?.id);

    // Build actions array — describes where each intent should be executed
    const actions = [];
    if (result.route === 'music' || result.intent === 'music') {
      actions.push({ target: 'device', device_type: 'phone', type: 'play_music', args: { query: result.query || result.searchTerm || text } });
    }
    if (result.intent === 'navigate') {
      actions.push({ target: 'device', device_type: 'phone', type: 'navigate', args: { destination: result.query || text } });
    }
    if (result.intent === 'system' && result.command) {
      actions.push({ target: 'device', device_type: 'desktop', type: 'run_command', args: { command: result.command } });
    }
    if (result.intent === 'terminal') {
      actions.push({ target: 'server', type: 'terminal', args: { action: result.action, project: result.project } });
    }

    // Use router-resolved action_target (preference store / smart defaults) to enhance actions
    if (result.action_target && !result.action_target.needsClarification) {
      const t = result.action_target;
      const existing = actions.find(a => a.type === t.action_type);
      if (existing) {
        if (t.device_id)   existing.device_id   = t.device_id;
        if (t.device_type) existing.device_type  = t.device_type;
        if (t.app)         existing.app          = t.app;
        existing.source = t.source;
      } else if (t.device_id || t.device_type) {
        actions.push({
          target:      'device',
          device_id:   t.device_id   || null,
          device_type: t.device_type || null,
          type:        t.action_type,
          app:         t.app         || null,
          args:        { query: result.query || text },
          source:      t.source,
        });
      }
    }

    // Clarification — store pending intent so the next reply can resume
    if (result.intent === 'clarification' && result.clarification) {
      try {
        insertScoped(req, `INSERT INTO events (event_type, session_id, data, created_at)
          VALUES ('pending_clarification', :sid, :data, datetime('now','localtime'))`,
          { ':sid': device_id || 'unknown', ':data': JSON.stringify(result.clarification) }
        );
      } catch {}
    }

    // Dispatch actions to remote pan-client PCs via sendToClient
    // Any action whose device_id points to a connected trusted client gets sent directly.
    for (const action of actions) {
      if (!action.device_id || action.target === 'server' || action.device_type === 'phone') continue;
      try {
        const { sendToClient, getConnectedClients } = await import('../client-manager.js');
        const connected = getConnectedClients();
        const match = connected.find(c => c.trusted && c.online &&
          (c.device_id === action.device_id || c.device_id?.toLowerCase() === action.device_id?.toLowerCase()));
        if (!match) continue;

        // Map action type → sendToClient command
        const args = action.args || {};
        switch (action.type) {
          case 'open_app':
            sendToClient(match.device_id, 'open_app', { app: action.app || args.app || args.query }).catch(() => {});
            break;
          case 'open_url':
          case 'open_browser':
            sendToClient(match.device_id, 'open_url', { url: args.url || args.query }).catch(() => {});
            break;
          case 'play_music':
            sendToClient(match.device_id, 'open_app', { app: action.app || 'spotify' }).catch(() => {});
            break;
          case 'play_movie':
            sendToClient(match.device_id, 'open_app', { app: action.app || 'vlc' }).catch(() => {});
            break;
          case 'notification':
          case 'tts_speak':
            sendToClient(match.device_id, action.type, { text: args.text || args.message || result.response }).catch(() => {});
            break;
          case 'shell_exec':
          case 'run_command':
            sendToClient(match.device_id, 'shell_exec', { command: args.command || args.query }).catch(() => {});
            break;
          case 'screenshot':
            sendToClient(match.device_id, 'screenshot', {}).catch(() => {});
            break;
          default:
            // Forward anything else as-is
            sendToClient(match.device_id, action.type, args).catch(() => {});
        }
        console.log(`[PAN Router] Dispatched ${action.type} → ${match.device_id}`);

        // Learn from successful dispatch — increment preference so PAN routes here again
        try {
          const { learnCorrection } = await import('../smart-router.js');
          const deviceRow = all("SELECT * FROM devices WHERE hostname = :h", { ':h': match.device_id })[0];
          if (deviceRow) learnCorrection(action.type, deviceRow, action.app || null, req.org_id || 'org_personal', user_id || null);
        } catch {}
      } catch (e) {
        // Non-fatal
      }
    }

    // Push actions back to originating device via WS push channel
    if (actions.length > 0 && device_id) {
      try {
        const { pushToDevice } = await import('../server.js');
        pushToDevice(device_id, { type: 'actions', actions, response_text: result.response });
      } catch (e) {
        // Non-fatal — device may not be connected via WS push channel
      }
    }

    res.json({
      response_text: result.response,
      intent: result.intent,
      speech_act: result.speech_act || null,
      route: result.intent || null,
      query: result.query || result.searchTerm || null,
      action: result.action || null,
      response_time_ms: result.response_time_ms || null,
      actions
    });
  } catch (err) {
    console.error('[PAN] Query error:', err.message);
    res.json({ response_text: 'PAN is having trouble thinking right now. Try again.' });
  }
});

// POST /api/v1/devices/capabilities — phone/other devices self-report their capabilities
router.post('/devices/capabilities', (req, res) => {
  const { capabilities } = req.body;
  const device_id = req.headers['x-device-id'] || req.headers['x-device-name'];
  if (!capabilities || !device_id) {
    return res.status(400).json({ error: 'capabilities and device id required' });
  }
  try {
    const existing = getScoped(req, `SELECT capabilities FROM devices WHERE hostname = :h OR name = :h AND org_id = :org_id`, { ':h': device_id });
    const merged = [...new Set([...(JSON.parse(existing?.capabilities || '[]')), ...capabilities])];
    runScoped(req, `UPDATE devices SET capabilities = :c WHERE (hostname = :h OR name = :h) AND org_id = :org_id`, {
      ':c': JSON.stringify(merged),
      ':h': device_id,
    });
    res.json({ ok: true, capabilities: merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Active devices — online in last 5 minutes
router.get('/devices/active', (req, res) => {
  const devices = allScoped(req, `
    SELECT id, hostname, name, device_type, capabilities, last_seen, tailscale_hostname
    FROM devices
    WHERE last_seen >= datetime('now', '-5 minutes', 'localtime')
    AND org_id = :org_id
    ORDER BY last_seen DESC
  `);
  res.json({ devices: devices.map(d => ({
    ...d,
    capabilities: (() => { try { return JSON.parse(d.capabilities || '[]'); } catch { return []; } })(),
    online: true
  }))});
});

// ── Conversation history (per device, persisted across restarts) ─────────────

// POST /api/v1/history — phone ships each turn as it happens
router.post('/history', (req, res) => {
  const { role, text, device_id } = req.body;
  if (!role || !text) return res.status(400).json({ error: 'role and text required' });
  try {
    insertScoped(req, `INSERT INTO events (event_type, session_id, transcript, response, data, created_at)
      VALUES ('conversation_turn', :session_id, :transcript, :response, :data, datetime('now','localtime'))`, {
      ':session_id': device_id || 'phone',
      ':transcript': role === 'user' ? text : '',
      ':response': role === 'assistant' ? text : '',
      ':data': JSON.stringify({ role, device_id }),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/v1/history?device_id=X&limit=10 — phone loads history on startup
router.get('/history', (req, res) => {
  const { device_id, limit = 10 } = req.query;
  const session_id = device_id || 'phone';
  try {
    const rows = allScoped(req, `
      SELECT transcript, response, data, created_at FROM events
      WHERE event_type = 'conversation_turn'
        AND session_id = :session_id
        AND org_id = :org_id
      ORDER BY created_at DESC
      LIMIT :limit
    `, { ':session_id': session_id, ':org_id': req.org_id || 'org_personal', ':limit': parseInt(limit) });

    const turns = rows.reverse().flatMap(r => {
      const out = [];
      if (r.transcript) out.push({ role: 'user', text: r.transcript, created_at: r.created_at });
      if (r.response) out.push({ role: 'assistant', text: r.response, created_at: r.created_at });
      return out;
    });
    res.json({ turns });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  const events = allScoped(req, `SELECT * FROM events WHERE event_type = 'PhoneAudio' AND org_id = :org_id ORDER BY created_at DESC LIMIT :limit`, {
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
  const stats = getScoped(req, `SELECT
    (SELECT COUNT(*) FROM events WHERE org_id = :org_id) as total_events,
    (SELECT COUNT(*) FROM events WHERE event_type = 'PhoneAudio' AND org_id = :org_id) as audio_events,
    (SELECT COUNT(*) FROM projects WHERE org_id = :org_id) as projects,
    (SELECT COUNT(*) FROM memory_items WHERE org_id = :org_id) as memory_items
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

// ── Screen Recording ──────────────────────────────────────────────
import { startRecording, stopRecording, extractFrames, getRecordingStatus, listRecordings } from '../screen-recorder.js';

// POST /api/v1/recording/start — start screen recording
router.post('/recording/start', (req, res) => {
  const { fps } = req.body || {};
  const result = startRecording({ fps });
  if (result.error) return res.status(409).json(result);
  insertEvent(`recording-${Date.now()}`, 'RecordingStart', JSON.stringify(result));
  res.json(result);
});

// POST /api/v1/recording/stop — stop screen recording
router.post('/recording/stop', (req, res) => {
  const result = stopRecording();
  if (result.error) return res.status(409).json(result);
  insertEvent(`recording-${Date.now()}`, 'RecordingStop', JSON.stringify(result));
  res.json(result);
});

// GET /api/v1/recording/status — check if recording
router.get('/recording/status', (req, res) => {
  res.json(getRecordingStatus());
});

// GET /api/v1/recording/list — list all recordings
router.get('/recording/list', (req, res) => {
  res.json(listRecordings());
});

// POST /api/v1/recording/frames — extract frames from a recording
router.post('/recording/frames', async (req, res) => {
  const { file, fps } = req.body;
  if (!file) return res.status(400).json({ error: 'file required' });
  try {
    const result = await extractFrames(file, { fps });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Anonymization / Data Export ──────────────────────────────────
// POST /api/v1/anonymize — test anonymization on arbitrary text
router.post('/anonymize', (req, res) => {
  const { text, options } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const result = anonymize(text, options);
  res.json(result);
});

// GET /api/v1/export/anonymized — export anonymized event data for data dividends
// Query params: limit (default 100), offset (default 0), event_type (optional filter)
router.get('/export/anonymized', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const eventType = req.query.event_type;

  let query = `SELECT id, session_id, event_type, data, created_at FROM events WHERE org_id = :org_id`;
  const params = {};

  if (eventType) {
    query += ` AND event_type = :type`;
    params[':type'] = eventType;
  }
  query += ` ORDER BY created_at DESC LIMIT :limit OFFSET :offset`;
  params[':limit'] = limit;
  params[':offset'] = offset;

  const events = allScoped(req, query, params);
  const total = getScoped(req, `SELECT COUNT(*) as c FROM events WHERE org_id = :org_id${eventType ? ` AND event_type = :type` : ''}`, eventType ? { ':type': eventType } : {})?.c || 0;

  const anonymized = events.map(e => {
    const { data: anonData, totalReplacements } = anonymizeEventData(e.data);
    return {
      id: e.id,
      event_type: e.event_type,
      data: JSON.parse(anonData),
      created_at: e.created_at,
      pii_stripped: totalReplacements,
    };
  });

  res.json({
    events: anonymized,
    total,
    limit,
    offset,
    pii_total: anonymized.reduce((sum, e) => sum + e.pii_stripped, 0),
  });
});

// GET /api/v1/anonymize/stats — scan DB for PII density (how much PII exists)
router.get('/anonymize/stats', (req, res) => {
  const sample = all(`SELECT id, event_type, data FROM events ORDER BY created_at DESC LIMIT 500`);
  let totalPII = 0;
  const byType = {};
  for (const e of sample) {
    const { totalReplacements } = anonymizeEventData(e.data);
    totalPII += totalReplacements;
    if (totalReplacements > 0) {
      byType[e.event_type] = (byType[e.event_type] || 0) + totalReplacements;
    }
  }
  res.json({
    sample_size: sample.length,
    total_pii_instances: totalPII,
    pii_per_event: sample.length > 0 ? (totalPII / sample.length).toFixed(2) : 0,
    by_event_type: byType,
  });
});

// GET /api/v1/ai/models — returns available models, live from Anthropic API if key exists
// Falls back to a hardcoded list of known models so the settings dropdown always has options.
const KNOWN_CLAUDE_MODELS = [
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5',  tier: 'fast'    },
  { id: 'claude-sonnet-4-6',         name: 'Claude Sonnet 4.6', tier: 'balanced' },
  { id: 'claude-opus-4-6',           name: 'Claude Opus 4.6',   tier: 'powerful' },
  { id: 'claude-opus-4-7',           name: 'Claude Opus 4.7',   tier: 'powerful' },
];

router.get('/ai/models', async (req, res) => {
  try {
    const local = getLocalModels();
    res.json({ models: KNOWN_CLAUDE_MODELS, local, source: 'hardcoded' });
  } catch (err) {
    res.json({ models: KNOWN_CLAUDE_MODELS, local: [], source: 'hardcoded', error: err.message });
  }
});

function getLocalModels() {
  try {
    const row = get("SELECT value FROM settings WHERE key = 'custom_models'");
    if (row?.value) {
      const models = JSON.parse(row.value);
      return models.map(m => ({
        id: m.id,
        name: m.name || m.id,
        provider: m.provider || 'local',
        tier: 'local',
      }));
    }
  } catch {}
  return [];
}

export default router;
