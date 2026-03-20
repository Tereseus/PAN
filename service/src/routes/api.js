import { Router } from 'express';
import { insert, all, get, run } from '../db.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = join(__dirname, '..', 'data', 'photos');
if (!existsSync(PHOTOS_DIR)) mkdirSync(PHOTOS_DIR, { recursive: true });

const router = Router();

// Auto-register phone when it connects
router.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  // Only register non-localhost (phone comes from LAN)
  if (ip !== '127.0.0.1' && ip !== '::1' && !ip.endsWith('127.0.0.1')) {
    const phoneHost = `phone-${ip.replace(/[^0-9.]/g, '')}`;
    const existing = get("SELECT * FROM devices WHERE hostname = :h", { ':h': phoneHost });
    if (!existing) {
      insert(`INSERT INTO devices (hostname, name, device_type, capabilities, last_seen)
        VALUES (:h, :name, 'phone', '["voice","camera","sensors"]', datetime('now'))`, {
        ':h': phoneHost, ':name': 'Phone'
      });
    } else {
      // Update last_seen every 5 minutes max (avoid hammering DB)
      run("UPDATE devices SET last_seen = datetime('now') WHERE hostname = :h", { ':h': phoneHost });
    }
  }
  next();
});

// Utterance aggregation
const MERGE_WINDOW_MS = 8000;
let lastAudioTime = 0;
let lastAudioSessionId = null;
let utteranceBuffer = [];
let flushTimer = null;

function flushUtterance() {
  if (utteranceBuffer.length === 0) return;

  const fullText = utteranceBuffer.join(' ');
  const sid = lastAudioSessionId || `phone-${Date.now()}`;

  insert(`INSERT INTO events (session_id, event_type, data)
    VALUES (:sid, :type, :data)`, {
    ':sid': sid,
    ':type': 'PhoneAudio',
    ':data': JSON.stringify({
      transcript: fullText,
      timestamp: Date.now(),
      duration_ms: 0,
      source: 'phone_mic',
      fragment_count: utteranceBuffer.length
    })
  });

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
  lastAudioTime = now;
  if (!lastAudioSessionId) lastAudioSessionId = `phone-${now}`;

  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushUtterance, MERGE_WINDOW_MS);

  res.json({ ok: true });
});

router.post('/photo', (req, res) => {
  const { jpeg_base64, timestamp, source } = req.body;

  insert(`INSERT INTO events (session_id, event_type, data)
    VALUES (:sid, :type, :data)`, {
    ':sid': `Pandant-${Date.now()}`,
    ':type': 'PandantPhoto',
    ':data': JSON.stringify({ timestamp, source, size: jpeg_base64?.length || 0 })
  });

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

    const description = await claudeVision(prompt, image_base64);
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
    insert(`INSERT INTO events (session_id, event_type, data)
      VALUES (:sid, :type, :data)`, {
      ':sid': photoId,
      ':type': 'VisionAnalysis',
      ':data': JSON.stringify({
        question: prompt,
        description: description.slice(0, 500),
        image_file: photoFilename,
        image_size: image_base64.length,
        timestamp: Date.now()
      })
    });

    res.json({ description });
  } catch (err) {
    console.error('[PAN Vision] Error:', err.message);
    res.status(500).json({ error: 'Vision analysis failed', description: 'I could not analyze the image right now.' });
  }
});

router.post('/sensor', (req, res) => {
  const { sensor_type, values, timestamp } = req.body;

  insert(`INSERT INTO events (session_id, event_type, data)
    VALUES (:sid, :type, :data)`, {
    ':sid': `Pandant-${Date.now()}`,
    ':type': 'SensorData',
    ':data': JSON.stringify({ sensor_type, values, timestamp })
  });

  res.json({ ok: true });
});

// Pending desktop actions queue (for terminal opens, etc.)
// The service queues these; a user-session agent polls and executes them
const pendingActions = [];

router.post('/query', async (req, res) => {
  const { text, context, intent_hint } = req.body;

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
    const result = await route(text, { source: 'phone', intent_hint, _commandId: cmdId, conversation_history: context });

    // Update the command record with results
    if (result.intent === 'terminal' && result.terminalAction) {
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
      action: result.action || null
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
    insert(`INSERT INTO events (session_id, event_type, data)
      VALUES (:sid, :type, :data)`, {
      ':sid': `phone-sync-${Date.now()}`,
      ':type': `PhoneSync_${item.type}`,
      ':data': item.payload
    });
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

export default router;
