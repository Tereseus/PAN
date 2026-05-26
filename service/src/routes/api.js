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

// Dashboard chat — routes through AI router with dashboard source tag.
// Also persists BOTH sides to chat_messages when thread_id is provided
// (voice call loop, comms popout) so the conversation appears in the thread
// UI and survives page reloads.
router.post('/chat', async (req, res) => {
  const { message, project_id, source, thread_id, org_id } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    // Feed conv-state watcher: every chat-line is a "final" turn from the user.
    // The watcher debounce-distills ~500ms after this; the router below reads
    // the previous state synchronously so the very first turn after boot will
    // see a null state — that's fine, it just falls back to the live utterance.
    try {
      const { noteUtterance } = await import('../conv-state-watcher.js');
      noteUtterance({
        orgId: org_id || 'org_personal',
        text: message,
        isFinal: true,
        source: source || 'dashboard',
        deviceId: req.headers['x-device-name'] || null,
      });
    } catch (e) { /* never block chat */ }

    // Pull recent thread history so the router sees prior turns. Without
    // this, every voice-call turn was a cold prompt — PAN had no memory of
    // its own last reply, so it'd claim to do X, then a turn later deny
    // ever saying it. See conversation 2026-05-22 ~01:13 PM.
    // Format: "You: ...\nPAN: ..." one per line, oldest → newest, last 10
    // exchanges (=20 lines max). Self-sender = "You", anything else = "PAN".
    let conversation_history = '';
    if (thread_id) {
      try {
        const rows = db.prepare(`
          SELECT sender_id, body FROM chat_messages
          WHERE thread_id = ? AND body_type = 'text'
          ORDER BY created_at DESC LIMIT 20
        `).all(thread_id);
        if (rows.length > 0) {
          conversation_history = rows.reverse().map(r => {
            const who = r.sender_id === 'self' ? 'You' : 'PAN';
            const body = String(r.body || '').slice(0, 400);
            return `${who}: ${body}`;
          }).join('\n');
        }
      } catch (e) { console.warn('[PAN Chat] history pull failed:', e?.message); }
    }

    const { route } = await import('../router.js');
    const result = await route(message, {
      source: source || 'dashboard',
      project_id,
      thread_id: thread_id || null,
      org_id:   org_id   || 'org_personal',
      conversation_history,
    });
    const response = (result?.response || '').trim() || 'No response';

    insertEvent('dashboard-chat', 'DashboardChat', JSON.stringify({
      query: message, response: response.slice(0, 2000), project_id, source: source || 'dashboard',
      speech_act: result.speech_act || null, intent: result.intent || null
    }), req.user?.id);

    // Debug trace — router captures the prompt context, model, latency, and
    // reasoning into result._debug. We persist it in the PAN message metadata
    // so the comms popout can show a "🧠 why" disclosure under each bubble.
    const debug = result?._debug || null;

    // Persist to chat thread if a thread_id is provided
    let userMsgId = null, panMsgId = null;
    if (thread_id && response && response !== 'No response') {
      try {
        const crypto = await import('crypto');
        const now = Date.now();
        userMsgId = 'cmsg_' + crypto.randomBytes(8).toString('hex');
        panMsgId  = 'cmsg_pan_' + now + '_' + crypto.randomBytes(4).toString('hex');
        const senderForPan = thread_id === 'thread-pan-system' ? 'contact-pan-system' : 'pan';

        db.prepare(`
          INSERT INTO chat_messages (id, thread_id, sender_id, body, body_type, metadata, created_at)
          VALUES (?, ?, 'self', ?, 'text', ?, ?)
        `).run(userMsgId, thread_id, message, JSON.stringify({ source: source || 'dashboard' }), now);

        db.prepare(`
          INSERT INTO chat_messages (id, thread_id, sender_id, body, body_type, metadata, created_at)
          VALUES (?, ?, ?, ?, 'text', ?, ?)
        `).run(panMsgId, thread_id, senderForPan, response,
               JSON.stringify({
                 intent: result?.intent || null,
                 source: source || 'dashboard',
                 debug,
               }),
               now + 1);

        db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(now + 1, thread_id);
      } catch (e) {
        console.warn('[PAN Chat] thread persist failed:', e?.message);
      }
    }

    res.json({
      response,
      intent: result?.intent || null,
      action: result?.action || null,
      // #986 Batch 4: surface prosody plan so non-streaming consumers
      // (dashboard, older phone path) can drive TTS rate/pitch the same as
      // /chat/stream's done event. Falls back to null if the router didn't
      // attach one (e.g. legacy error paths).
      prosody: result?.prosody || null,
      importance: typeof result?.importance === 'number' ? result.importance : null,
      user_message_id: userMsgId,
      pan_message_id:  panMsgId,
      debug,
    });
  } catch (err) {
    console.error('[PAN Chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── #986 batch 2: streaming chat + cancellation ─────────────────────────────
// Map of in-flight stream_id → AbortController. Used by /chat/stream to register
// a controller per request, and by /cancel to abort one mid-stream when the user
// says "stop" / "cancel" / "shut up" or clicks the cancel button. Entries are
// removed when the stream completes naturally OR after a 30s TTL safety net so
// we never leak controllers if the client disconnects without /cancel firing.
const streamControllers = new Map(); // stream_id → { controller, expiresAt }
const STREAM_TTL_MS = 60_000;
function registerStream(streamId, controller) {
  streamControllers.set(streamId, { controller, expiresAt: Date.now() + STREAM_TTL_MS });
}
function clearStream(streamId) {
  streamControllers.delete(streamId);
}
// Periodic GC — strictly safety; the per-request finally{} clears entries in the
// happy path. Runs every 30s, drops anything past its TTL.
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of streamControllers) {
    if (entry.expiresAt < now) {
      try { entry.controller.abort(); } catch {}
      streamControllers.delete(id);
    }
  }
}, 30_000).unref?.();

// POST /api/v1/chat/stream — SSE version of /chat. Streams the model's response
// token-by-token so the dashboard renders incrementally (no 1.5-13s blank wait).
// Emits:
//   data: {"type":"stream_start","stream_id":"..."}
//   data: {"type":"chunk","text":"..."}          (repeated; partial response field)
//   data: {"type":"done","result":{response,intent,action,...}}
// Cancel by POSTing { stream_id } to /api/v1/cancel.
router.post('/chat/stream', async (req, res) => {
  const { message, project_id, source, thread_id, org_id } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const sendKeepalive = () => { if (!res.writableEnded) res.write(': keepalive\n\n'); };
  const keepalive = setInterval(sendKeepalive, 5000);

  // Generate a stream_id and register an AbortController under it. The client
  // gets it in the first frame so it can POST to /cancel later.
  const streamId = 'stream_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const controller = new AbortController();
  registerStream(streamId, controller);
  send({ type: 'stream_start', stream_id: streamId });

  // Client disconnect → abort. Listen on `res` (not `req`) because Node's
  // IncomingMessage emits 'close' as soon as the request body is fully consumed,
  // even while the response is still being sent — that fired our abort within
  // microseconds of registration. `res.on('close')` only fires when the response
  // stream itself terminates, so we use writableEnded to distinguish a clean
  // server-side end (don't abort) from a client disconnect (do abort).
  res.on('close', () => {
    if (!res.writableEnded) {
      try { controller.abort(); } catch {}
    }
  });

  // Feed conv-state watcher (same as non-streaming /chat).
  try {
    const { noteUtterance } = await import('../conv-state-watcher.js');
    noteUtterance({
      orgId: org_id || 'org_personal',
      text: message,
      isFinal: true,
      source: source || 'dashboard',
      deviceId: req.headers['x-device-name'] || null,
    });
  } catch {}

  // Same conversation_history pull as /chat for thread continuity.
  let conversation_history = '';
  if (thread_id) {
    try {
      const rows = db.prepare(`
        SELECT sender_id, body FROM chat_messages
        WHERE thread_id = ? AND body_type = 'text'
        ORDER BY created_at DESC LIMIT 20
      `).all(thread_id);
      if (rows.length > 0) {
        conversation_history = rows.reverse().map(r => {
          const who = r.sender_id === 'self' ? 'You' : 'PAN';
          return `${who}: ${String(r.body || '').slice(0, 400)}`;
        }).join('\n');
      }
    } catch {}
  }

  let finalResult = null;
  let assembledText = '';
  try {
    const { routeStream } = await import('../router.js');
    for await (const event of routeStream(message, {
      source: source || 'dashboard',
      project_id,
      thread_id: thread_id || null,
      org_id:   org_id   || 'org_personal',
      conversation_history,
      signal: controller.signal,
    })) {
      // If cancellation fired, swap the generic error 'done' frame routeStream
      // emits on abort for a clean 'cancelled' frame so the client can render
      // an "interrupted" affordance instead of an error toast.
      if (controller.signal.aborted) {
        send({ type: 'cancelled', stream_id: streamId, partial: assembledText });
        break;
      }
      if (event.type === 'chunk') assembledText += event.text || '';
      if (event.type === 'done') finalResult = event.result || null;
      send(event);
      if (event.type === 'done') break;
    }
  } catch (err) {
    if (controller.signal.aborted) {
      send({ type: 'cancelled', stream_id: streamId, partial: assembledText });
    } else {
      console.error('[chat/stream]', err.message);
      send({ type: 'done', result: { intent: 'query', response: 'Something went wrong.' } });
    }
  } finally {
    clearInterval(keepalive);
    clearStream(streamId);
  }

  // Persist to thread + log the event (same as /chat) — only on successful
  // completion (not cancellation), so cancelled replies don't pollute history.
  const response = (finalResult?.response || assembledText || '').trim();
  if (response && !controller.signal.aborted) {
    try {
      insertEvent('dashboard-chat-stream', 'DashboardChat', JSON.stringify({
        query: message, response: response.slice(0, 2000), project_id,
        source: source || 'dashboard', stream_id: streamId,
        speech_act: finalResult?.speech_act || null, intent: finalResult?.intent || null,
      }), req.user?.id);
    } catch {}
    if (thread_id) {
      try {
        const crypto = await import('crypto');
        const now = Date.now();
        const userMsgId = 'cmsg_' + crypto.randomBytes(8).toString('hex');
        const panMsgId  = 'cmsg_pan_' + now + '_' + crypto.randomBytes(4).toString('hex');
        const senderForPan = thread_id === 'thread-pan-system' ? 'contact-pan-system' : 'pan';
        db.prepare(`INSERT INTO chat_messages (id, thread_id, sender_id, body, body_type, metadata, created_at)
                    VALUES (?, ?, 'self', ?, 'text', ?, ?)`)
          .run(userMsgId, thread_id, message, JSON.stringify({ source: source || 'dashboard', stream_id: streamId }), now);
        db.prepare(`INSERT INTO chat_messages (id, thread_id, sender_id, body, body_type, metadata, created_at)
                    VALUES (?, ?, ?, ?, 'text', ?, ?)`)
          .run(panMsgId, thread_id, senderForPan, response,
               JSON.stringify({ intent: finalResult?.intent || null, source: source || 'dashboard', stream_id: streamId }), now + 1);
        db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(now + 1, thread_id);
      } catch {}
    }
  }

  if (!res.writableEnded) res.end();
});

// POST /api/v1/cancel — abort an in-flight stream by stream_id. Returns
// { ok: true, aborted: bool }. Idempotent: cancelling an unknown stream_id is
// not an error (the stream may have already finished).
router.post('/cancel', (req, res) => {
  const { stream_id } = req.body || {};
  if (!stream_id) return res.status(400).json({ error: 'stream_id required' });
  const entry = streamControllers.get(stream_id);
  if (!entry) return res.json({ ok: true, aborted: false, reason: 'unknown_or_complete' });
  try { entry.controller.abort(); } catch {}
  streamControllers.delete(stream_id);
  res.json({ ok: true, aborted: true });
});

// GET /api/v1/cancel/active — debug visibility into live streams.
router.get('/cancel/active', (_req, res) => {
  const now = Date.now();
  res.json({
    count: streamControllers.size,
    streams: [...streamControllers.entries()].map(([id, e]) => ({
      stream_id: id, ttl_ms: Math.max(0, e.expiresAt - now)
    })),
  });
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
           ORDER BY CASE e.event_type WHEN 'RouterCommand' THEN 0 ELSE 1 END, rank
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
        // Skip recall-failure events — they pollute results with "we haven't talked about X"
        const failurePhrases = ["haven't talked about", "no record of", "no matching items", "first time you've mentioned",
          "don't have access to previous", "can't find", "nothing found", "[AMBIENT]", "No matching items"];
        if (failurePhrases.some(p => a.includes(p))) return null;
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
    // 8K chars keeps Cerebras fast; FTS already ranked the most relevant first
    const TOKEN_BUDGET = 8000;
    let snippetText = '';
    let count = 0;
    for (const e of entries) {
      const line = `[${e.time}] ${e.text}\n`;
      if (snippetText.length + line.length > TOKEN_BUDGET) break;
      snippetText += line;
      count++;
    }

    const totalEvents = getScoped(req, 'SELECT COUNT(*) as c FROM events WHERE org_id = :org_id')?.c || 0;

    // Step 5: Cerebras call — small context = fast (~500ms)
    const summary = await claude(
      `You are PAN, a personal AI memory system. The user asked: "${text}"

Here are ${count} relevant entries from their history (${ftsResults.length} FTS matches out of ${totalEvents} total events):

${snippetText}
Answer in 1-3 sentences, conversational tone. Be specific — mention dates and exact details if present. If the answer isn't in the data, say so.`,
      { maxTokens: 200, timeout: 15000, caller: 'recall' }
    );

    const elapsed = Date.now() - startTime;
    console.log(`[PAN Recall] "${text}" → FTS:${ftsResults.length} + recent:${recentEvents.length} = ${count} sent to Haiku, ${elapsed}ms`);
    res.json({ response_text: summary.trim() });
  } catch (err) {
    console.error('[PAN Recall] Error:', err.message);
    res.json({ response_text: 'I had trouble searching through conversations.' });
  }
});

// Streaming recall — same FTS5 search but SSE stream so phone speaks first sentence immediately
router.post('/recall/stream', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
  };
  const sendKeepalive = () => { try { res.write(': keepalive\n\n'); } catch {} };
  send({ type: 'ping' });

  // Keepalive every 5s — prevents OkHttp 30s readTimeout from firing during slow LLM calls
  const keepaliveInterval = setInterval(sendKeepalive, 5000);

  try {
    // Use searchMemory (FTS5 + vector/semantic RRF) — same engine as router recall.
    // The old hand-rolled FTS-only query missed semantic matches and accumulated
    // false negatives as failed searches got indexed as events (circular contamination).
    const { searchMemory } = await import('../memory-search.js');
    const memHits = await searchMemory(text, { limit: 20, caller: 'recall-stream' });

    const recentEvents = allScoped(req,
      `SELECT id, event_type, data, created_at FROM events
       WHERE event_type NOT IN ('SessionEnd', 'SessionStart') AND org_id = :org_id
       ORDER BY created_at DESC LIMIT 20`
    );

    function extractSnippet(eventRow) {
      if (!eventRow) return null;
      let data = {};
      try { data = JSON.parse(eventRow.data || '{}'); } catch { return null; }
      if (eventRow.event_type === 'RouterCommand') {
        const q = data.text || ''; const a = data.result || data.response_text || '';
        if (q || a) return `Voice: "${q}" → ${a}`;
      } else if (eventRow.event_type === 'UserPromptSubmit') {
        const p = data.prompt || '';
        if (p.length >= 10 && !p.startsWith('{')) return `Terminal: ${p}`;
      } else if (eventRow.event_type === 'Stop') {
        const m = data.last_assistant_message || '';
        if (m.length >= 20) return `Claude: ${m.slice(0, 400)}`;
      } else if (eventRow.event_type === 'PhoneAudio') {
        const t = data.transcript || '';
        const finals = t.match(/Final: (.+?)(?:\[|Heard|$)/g)
          ?.map(m => m.replace(/^Final: /, '').replace(/\[.*$/, '').trim())
          .filter(Boolean).join('; ');
        if (finals) return `Heard: ${finals}`;
      }
      return null;
    }

    const seen = new Set();
    const entries = [];

    // Semantic + FTS hits first (ranked by relevance)
    for (const hit of memHits) {
      if (!hit.event || seen.has(hit.event.id)) continue;
      seen.add(hit.event.id);
      const snippet = extractSnippet(hit.event);
      if (snippet) entries.push({ time: hit.event.created_at, text: snippet.slice(0, 500) });
    }
    // Recent events as fallback context
    for (const e of recentEvents) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const snippet = extractSnippet(e);
      if (snippet) entries.push({ time: e.created_at, text: snippet.slice(0, 500) });
    }

    if (entries.length === 0) {
      send({ type: 'chunk', text: 'No conversation history to search through.' });
      send({ type: 'done', result: {} });
      res.end();
      return;
    }

    const TOKEN_BUDGET = 6000;
    let snippetText = '';
    let count = 0;
    for (const e of entries) {
      const line = `[${e.time}] ${e.text}\n`;
      if (snippetText.length + line.length > TOKEN_BUDGET) break;
      snippetText += line;
      count++;
    }

    const totalEvents = getScoped(req, 'SELECT COUNT(*) as c FROM events WHERE org_id = :org_id')?.c || 0;
    const prompt = `You are PAN, a personal AI memory system. The user asked: "${text}"

Here are ${count} relevant entries from their history (${memHits.length} semantic+FTS matches out of ${totalEvents} total events):

${snippetText}
Answer in 1-3 sentences, conversational tone. Be specific — mention dates and exact details if present. If the answer isn't in the data, say so.`;

    const startTime = Date.now();
    // Use llama3.1-8b for fast recall — no thinking overhead, short lookup task
    const { claude: claudeCall } = await import('../claude.js');
    const fullText = await claudeCall(prompt, { model: 'cerebras:llama3.1-8b', maxTokens: 400, timeout: 15000, caller: 'recall', _skipAnonymize: true }) || '';
    const elapsed = Date.now() - startTime;
    if (fullText.trim()) send({ type: 'chunk', text: fullText.trim() });
    console.log(`[PAN Recall/stream] "${text}" → ${count} entries (${memHits.length} semantic hits), ${elapsed}ms`);
    send({ type: 'done', result: { response_text: fullText } });
    clearInterval(keepaliveInterval);
    res.end();
  } catch (err) {
    console.error('[PAN Recall/stream] Error:', err.message);
    send({ type: 'chunk', text: 'I had trouble searching through conversations.' });
    send({ type: 'done', result: {} });
    clearInterval(keepaliveInterval);
    res.end();
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
      source: device_id ? `phone-${device_id}` : 'phone',
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
            sendToClient(match.device_id, action.type, { text: args.text || args.message || result.response }).catch(() => {});
            break;
          case 'tts_speak': {
            // #496: route through smart speaker picker so the spoken response
            // falls through to another reachable device if the picked one is
            // offline. `match.device_id` is preferred (target) but not required.
            const { speakSomewhere } = await import('../speak-router.js');
            speakSomewhere({
              text: args.text || args.message || result.response,
              target: match.device_id,
              voice: args.voice,
              rate: args.rate,
            }).catch(() => {});
            break;
          }
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
      // #986 Batch 4: surface prosody plan + importance for phone TTS.
      // Phone currently ignores these (see #994); shipping them server-side
      // means the data is already there the moment Piper rate/pitch wiring
      // lands. Additive — existing consumers that don't read these are unaffected.
      prosody: result?.prosody || null,
      importance: typeof result?.importance === 'number' ? result.importance : null,
      actions
    });
  } catch (err) {
    console.error('[PAN] Query error:', err.message);
    res.json({ response_text: 'PAN is having trouble thinking right now. Try again.' });
  }
});

// POST /api/v1/query/stream — SSE streaming voice query
// Yields chunks of the response as they're generated so the phone can start TTS immediately.
// Event format: "data: {type:'chunk',text:'...'}\n\n" then "data: {type:'done',result:{...}}\n\n"
router.post('/query/stream', async (req, res) => {
  const { text, context, intent_hint, sensors } = req.body;
  if (!text) return res.status(400).json({ error: 'missing text' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const sendKeepalive = () => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  };

  // Immediate ping confirms SSE channel is open
  send({ type: 'ping' });

  // Keepalive every 5s — prevents OkHttp 30s readTimeout from firing during slow LLM calls
  const keepaliveInterval = setInterval(sendKeepalive, 5000);

  let parsedSensors = sensors;
  if (typeof sensors === 'string') { try { parsedSensors = JSON.parse(sensors); } catch { parsedSensors = null; } }

  try {
    const { routeStream } = await import('../router.js');
    const deviceId = req.headers['x-device-id'] || req.headers['x-device-name'] || null;
    for await (const event of routeStream(text, {
      source: deviceId ? `phone-${deviceId}` : 'phone',
      device_id: deviceId,
      intent_hint,
      conversation_history: context,
      sensors: parsedSensors,
      org_id: req.org_id,
    })) {
      send(event);
      if (event.type === 'done') break;
    }
  } catch (err) {
    console.error('[query/stream]', err.message);
    send({ type: 'chunk', text: 'Something went wrong.' });
    send({ type: 'done', result: { intent: 'query', response: 'Something went wrong.' } });
  } finally {
    clearInterval(keepaliveInterval);
  }

  if (!res.writableEnded) res.end();
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
