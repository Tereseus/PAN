import { ringing } from '../ringing.js';
import express, { Router } from 'express';
import { insert, all, get, run, db, logEvent, anonymize, anonymizeEventData, allScoped, getScoped, runScoped, insertScoped } from '../db.js';
import { logEventScoped } from '../events.js';
import { getActiveOrg, isIncognitoAllowed } from '../org-policy.js';
import { requireOrg } from '../middleware/org-context.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { transcribePcm16, transcribeAnyLanguage, warmHubAsr } from '../hub-asr.js';
import { pauseForTalk, listThings, getThing, writeThingNow } from '../memory/things.js';
import { benchContext } from '../bench-context.js';
import { recordTiming, turnTimings } from '../voice-timing.js';
import { setPhoneTimeZone } from '../intuition/time.js';
import { followUpOf, historyLines } from '../intuition/conversation.js';
import { plainLook, spokenLook } from '../camera-ask.js';
import { noteSaid, dropOwnTail } from '../own-tail.js';
import { scopeFor, may, refusal } from '../people.js';
import { addNote, takeNotesFor, noteSender, maySpeakNow, noteOwnerSpokeOn, notesDevices, SPEAK_PER_MINUTE } from '../phone-notes.js';
import { takeMessagesFor, peopleFor, conversation, sendMessage, peopleHere, ownerMayRead, talkLine, talkFast, talkState, startTalk, endTalk, declineTalk, setCallsBlocked, messageMode, setMessageMode, setNicknames } from '../person-messages.js';
import { recordMet, metFor, forgetMet } from '../met-people.js';
import { groupsHere, addGroup, renameGroup, removeGroup, setInGroup } from '../people-groups.js';
import { shareAnswerInCall } from '../call-share.js';
import { startRoom, leaveRoom, declineRoom, sayInRoom, roomLine, roomLines, roomState, roomFast } from '../group-calls.js';
import { pushVoice, openVoiceStream, voiceFor, setCallDevice } from '../call-voice.js';
import { whoseLine, speechLevel } from '../same-line.js';
import { linkDevice } from '../pan-link-auth.js';
import { getDataDir as notesDataDir } from '../platform.js';
import { createScreenControl } from '../screen-control.js';

const execFilePromise = promisify(execFile);
warmHubAsr();
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
// The phone's own send time (sensors.timestamp) of the newest voice turn seen from each device.
const newestTurnSentAt = new Map();
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
// What a streaming voice turn leaves behind. /query/stream wrote nothing at all, so memory
// search, recaps and Intuition never saw a word said to PAN: its "last heard" was whatever
// he last typed to Claude Code (audit, 2026-11-03). A turn PAN answered becomes a
// RouterCommand event (the shape the old /query route wrote, which recall and recaps read)
// and goes to the conversation state with PAN's reply. A line it let pass (the TV, other
// people) is not stored; it only joins the conversation state's short in-memory buffer as
// overheard, which costs nothing until the next distill.
function recordVoiceTurn(req, { text, result, deviceId, turnId, sensors }) {
  try {
    const intent = result?.intent || 'query';
    const response = String(result?.response || '').trim();
    // A camera hand-off has no reply yet: the phone takes the photo, answers, and posts
    // both to /capture, which records the finished turn. Keep the hub's words for it
    // (Parakeet, not the phone's text) for the /vision call that follows.
    if (result?.camera && !response) { _cameraAsk = { text, at: Date.now() }; return; }
    const answered = intent !== 'ambient' && intent !== 'cancelled' && (!!response && response !== '[AMBIENT]' || !!result?.camera);
    const orgId = req.org_id || 'org_personal';
    if (answered) {
      insertEvent(req, 'RouterCommand', JSON.stringify({
        text, intent, result: response, addressed: result?.addressed ?? null,
        camera: !!result?.camera, device_id: deviceId, turn_id: turnId, source: 'phone-voice',
        place: sensors?.phone?.gps?.address || null,
      }));
    }
    import('../conv-state-watcher.js').then(({ noteUtterance }) => {
      noteUtterance({ orgId, text, isFinal: true, source: answered ? 'him' : 'room', deviceId, distill: answered });
      if (answered && response) noteUtterance({ orgId, text: response, isFinal: true, source: 'pan', deviceId, distill: false });
    }).catch(() => {});
    // The phone had no presence row, so Intuition and the situation line only ever saw his
    // computers. A turn PAN answered means he is talking to it on the phone.
    if (deviceId && answered) {
      import('../intuition/index.js').then(({ upsertDevicePresence }) => upsertDevicePresence({
        device_id: deviceId, user_id: 'owner', activity: 'talking to PAN',
        screen_title: sensors?.phone?.gps?.address || null, confidence: 80, platform: 'android',
      })).catch(() => {});
    }
  } catch (e) { console.warn('[query/stream] recording the voice turn failed:', e.message); }
}

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
  // A person other than the owner has a database of their own, whatever the device asks for:
  // the header could name the owner's.
  if (req.user?.person) scope = scopeFor(req.user) || scope;

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

// Pendant frame ingest.
//
// THIS USED TO DISCARD THE IMAGE. It stored only `size: jpeg_base64?.length`,
// so a pendant streaming all day produced an endless log of "a 38KB photo
// happened" with no picture and no description. The frame is now written to
// disk exactly as /vision does.
//
// Analysis is OPT-IN per frame rather than automatic, and that is deliberate.
// Storing a frame costs ~0.1s; describing one costs seconds. At one frame every
// 5s, describing all of them would pin the box permanently to caption mostly
// ceilings. So: keep everything, describe what is asked for. Pass
// { analyze: true } for the "hey, look at this" path.
router.post('/photo', async (req, res) => {
  const { jpeg_base64, timestamp, source, analyze } = req.body || {};
  if (!jpeg_base64) return res.status(400).json({ ok: false, error: 'missing jpeg_base64' });

  const ts = Number(timestamp) || Date.now();
  const photoId = `pendant-${ts}`;
  const photoFilename = `${photoId}.jpg`;
  let saved = false;
  try {
    writeFileSync(join(PHOTOS_DIR, photoFilename), Buffer.from(jpeg_base64, 'base64'));
    saved = true;
  } catch (e) {
    console.error(`[PAN Pendant] failed to save ${photoFilename}: ${e.message}`);
  }

  // Event type stays 'PandantPhoto' (sic). The typo is load-bearing now that
  // rows exist under it; renaming would orphan the history for no benefit.
  insertEvent(photoId, 'PandantPhoto', JSON.stringify({
    timestamp: ts,
    source: source || 'pendant',
    image_file: saved ? photoFilename : null,
    image_size: jpeg_base64.length,
  }), req.user?.id);

  if (!analyze) {
    return res.json({ ok: true, saved, image_file: saved ? photoFilename : null });
  }

  try {
    const { analyzeImage } = await import('../claude.js');
    const description = await analyzeImage(
      'Describe what is in this scene in one or two short sentences.',
      jpeg_base64,
      { caller: 'vision' },
    );
    // Written as VisionAnalysis, NOT PandantPhoto, because VisionAnalysis is the
    // event type intuition's world_context reads. A description filed under any
    // other type would be searchable but invisible to intuition, which is the
    // exact gap this change exists to close.
    insertEvent(`vision-${Date.now()}`, 'VisionAnalysis', JSON.stringify({
      question: 'pendant frame',
      description: String(description || '').slice(0, 500),
      image_file: saved ? photoFilename : null,
      image_size: jpeg_base64.length,
      source: source || 'pendant',
      timestamp: Date.now(),
    }), req.user?.id);
    res.json({ ok: true, saved, image_file: saved ? photoFilename : null, description });
  } catch (e) {
    console.error(`[PAN Pendant] analyze failed: ${e.message}`);
    // The frame is already stored, so a vision failure must not lose it.
    res.json({ ok: true, saved, image_file: saved ? photoFilename : null, error: 'analysis failed', detail: e.message });
  }
});

// The camera hand-off turn as the hub heard it (set in recordVoiceTurn).
let _cameraAsk = null;

// "Use the camera and look at it" asks nothing: the question was the turn before
// ("what kind of dog is that?"). Handed the bare command, the vision model described the floor.
const BARE_LOOK = /^(?:(?:what|so|ok|okay|well|now|just|then|hey|pan|and|um|uh|please|can you|could you|would you)[\s,]+)*(?:(?:use|open|turn on) (?:the|your) camera(?: and)?(?:\s+(?:look|check)(?: at)? (?:it|this|that))?|(?:look|check)(?: at)? (?:it|this|that)|take a (?:look|picture|photo|pic)(?: (?:at|of) (?:it|this|that))?|have a look(?: at (?:it|this|that))?|check (?:it|this|that) out)(?:\s+(?:now|again|please))?[\s.!?]*$/i;

// The turn before only counts if it points at something to see; otherwise "take a
// picture" after "where do you exist at?" would ask the photo that.
const POINTS_AT = /\b(?:this|that|these|those|it|here|there)\b|\bwhat (?:kind|color|colour|breed|type|brand|make)\b|\bhow many\b|\bread\b/i;

/** The photo is still what the talk is on: it was the last thing he asked, or his questions since
 *  lean back on it ("what brand is it?", then "how much does it cost?"). */
function photoInFocus(history, text) {
  const lastHis = historyLines(history).filter((l) => l.his).pop();
  return /^\[photo\]/i.test(lastHis?.text || '') || !!followUpOf(history, text)?.photo;
}

function visionQuestion(phoneText, buffer = [], now = Date.now()) {
  const fresh = _cameraAsk && now - _cameraAsk.at < 60_000;
  let q = String((fresh ? _cameraAsk.text : phoneText) || '').trim();
  _cameraAsk = null;
  if (!q || BARE_LOOK.test(q)) {
    const prev = buffer
      .filter(u => u.source === 'him' && now - u.at < 120_000 && !BARE_LOOK.test(u.text))
      .pop();
    q = prev && POINTS_AT.test(prev.text) ? prev.text : 'What is in this photo?';
  }
  return q;
}

// The phone reads the answer aloud: no markdown, no lists, two sentences at most, and a word
// read off the photo in capitals ("SHADHAVAR") as a word, not spelled out.
function spokenVision(text) {
  const flat = String(text || '')
    .replace(/[*_`#]+/g, '')
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, '')
    .replace(/^\s*answer:\s*/i, '')
    .replace(/\b([A-Z])([A-Z]{3,})\b/g, (_, a, b) => a + b.toLowerCase())
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = flat.match(/[^.!?]+(?:[.!?]+|$)/g) || [];
  return sentences.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
}

// TWO LOOKS, THEN AN ANSWER. Asked "what kind of horse is this" with "Shadhavar" written over
// it, llava-phi3 said "a pony in a computer image", and asked again, "I don't have a specific
// one" (2026-11-03). moondream reads writing and names what it sees ("a 3D rendering of a white
// unicorn ... the word SHADHAVAR") but answers a question with nothing, so it describes and the
// local text model answers his question from that. A thing the description left out (his dog
// lying behind the desk) gets a second look of its own. Both run on the mini PC: neither the
// photo nor what is in it leaves it.
const PHOTO_DESCRIBER = 'moondream';
const PHOTO_ANSWERER = 'ollama:phi4-mini:3.8b';   // must stay local (ollama:); used when the hub's own model is not a local one
// The hub's one text model (setting ai_model, or job_models['vision-answer']), so a model change is
// one setting. Never a cloud model: what the photo shows stays on the hub.
async function photoAnswerer() {
  try {
    const { getModelForCaller } = await import('../llm.js');
    const m = String(getModelForCaller('vision-answer') || '');
    if (m.startsWith('ollama:')) return m;
  } catch {}
  return PHOTO_ANSWERER;
}
const DESCRIBE_PHOTO = 'Describe this image in detail, including any people or animals and any words written in it.';
const CANT_SPOT = /\b(?:can(?:no|')?t|unable to|don'?t|do not|couldn'?t) (?:spot|see|make out|find)\b|\bno \w+ (?:in|visible)\b/i;
let _lastLook = null;   // { look, at }: what the last photo showed, for a follow-up about it

// "what kind of dog is that" -> "dog": what to look for when the description missed it.
function photoSubject(q) {
  const m = String(q || '').toLowerCase().match(/\b(?:kind|type|breed|sort|colou?r|make|brand|model) of (?:a |an |the )?([a-z]+)|\bwhat (?:breed|colou?r|kind|type) is (?:that|this|the|it) ([a-z]+)|\b(?:is|was) (?:that|this|it) (?:a|an) ([a-z]+)/);
  return m ? (m[1] || m[2] || m[3]) : '';
}

async function answerFromLook(look, asked, askAI) {
  const prompt = [
    'You are PAN, his voice assistant. He just took this photo with his phone camera.',
    `What the photo shows: ${look}`,
    `He asked: "${asked}"`,
    'Answer him in one or two short spoken sentences, no lists, as specifically as the description allows: what it is and what it looks like (colour, kind, what it is doing). If words are written in the photo, add in a few words what they say: they are often its name. Never invent a breed, a name or a brand that is not in the description. Only if the description does not mention the thing at all, say you cannot spot it.',
  ].join('\n\n');
  try {
    return String(await askAI(prompt, { model: await photoAnswerer(), maxTokens: 90, timeout: 20000, caller: 'vision-answer', _skipAnonymize: true }) || '').trim();
  } catch (e) {
    console.warn(`[PAN Vision] answer step failed (${e.message}) - speaking the description`);
    return '';
  }
}

// A plain look ("what am I looking at?") is answered by a short description alone: the first
// sentence or two of moondream's ~110 words (the rest was "paste, paste mode, paste all"), and no
// second model. Measured on the hub 2026-11-08 with a new photo: moondream reads the image as ~750
// tokens in 5.6-9 s whatever its size (it resizes to 378 px), then writes ~32 tokens a second;
// the full path was 12-19 s (19 s live that day). Every description is capped: past the first
// two sentences it only repeated itself.
const PLAIN_LOOK_TOKENS = 64;
const LOOK_TOKENS = 120;

async function lookAndAnswer(image, asked, remember = true) {
  const { analyzeImage, askAI } = await import('../llm.js');
  if (plainLook(asked)) {
    const look = String(await analyzeImage(DESCRIBE_PHOTO, image, { caller: 'vision', model: PHOTO_DESCRIBER, maxTokens: PLAIN_LOOK_TOKENS })
      .catch((e) => { console.warn(`[PAN Vision] plain look failed (${e.message})`); return ''; }) || '').trim();
    const said = spokenLook(look);
    if (said) {
      if (remember) _lastLook = { look, at: Date.now() };
      return said;
    }
  }
  let look = '';
  try {
    look = String(await analyzeImage(DESCRIBE_PHOTO, image, { caller: 'vision', model: PHOTO_DESCRIBER, maxTokens: LOOK_TOKENS }) || '').trim();
  } catch (e) {
    console.warn(`[PAN Vision] ${PHOTO_DESCRIBER} failed (${e.message}) - asking the vision model the question directly`);
  }
  // No description at all: the one-model path, asked the question itself.
  if (!look) return analyzeImage(`Answer the question about this photo in one or two short sentences of plain speech, no lists. Question: ${asked}`, image, { caller: 'vision' });
  let answer = await answerFromLook(look, asked, askAI);
  const subject = photoSubject(asked);
  if (subject && CANT_SPOT.test(answer)) {
    const closer = String(await analyzeImage(`Describe the ${subject} in this image.`, image, { caller: 'vision', model: PHOTO_DESCRIBER, maxTokens: LOOK_TOKENS }).catch(() => '') || '').trim();
    console.log(`[PAN Vision] second look for "${subject}": ${closer.slice(0, 100)}`);
    if (closer) {
      look = `${look} ${closer}`;
      answer = await answerFromLook(look, asked, askAI);
    }
  }
  if (remember) _lastLook = { look, at: Date.now() };
  return answer || look;
}

router.post('/vision', async (req, res) => {
  // bench: a test photo (hub bench, 2026-11-03). Same looks and answer; the question is used
  // as sent, and nothing is saved: no photo file, no VisionAnalysis memory, no follow-up context.
  const { image_base64, question } = req.body;
  // A person other than the owner: the same looks and answer, and like a bench photo nothing is
  // kept (no file, no memory, no follow-up context) and the owner's talk is not read for the question.
  const person = req.user?.person ? req.user : null;
  if (person && !may(person, 'camera')) return res.status(403).json({ error: 'not open to this person', description: refusal('camera') });
  const bench = !!req.body.bench || !!person;

  if (!image_base64) {
    return res.status(400).json({ error: 'missing image_base64' });
  }

  try {
    const { getConversationBuffer } = await import('../conv-state-watcher.js');
    const asked = bench ? String(question || 'What is in this photo?') : visionQuestion(question, getConversationBuffer(req.org_id || 'org_personal'));
    console.log(`[PAN Vision] Analyzing image (${image_base64.length} chars)${bench ? ' [bench]' : ''}, question: "${asked.slice(0, 80)}"${asked !== question ? ` (phone heard "${String(question || '').slice(0, 60)}")` : ''}`);

    const t0 = Date.now();
    const description = spokenVision(await lookAndAnswer(image_base64, asked, !bench));
    console.log(`[PAN Vision] Result (${Date.now() - t0}ms): ${description.slice(0, 100)}`);
    if (bench) return res.json({ description, ...(person ? {} : { bench: true }) });

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
        question: asked,
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

// Capture pipe — the phone's interactive photo (the IMAGE, not just the spoken
// description). Previously the frame was analyzed by /vision and discarded; only
// text survived. Here we PERSIST the image so it reaches the desktop two ways:
//   1. As a real file under public/captures/ — the Claude Code agent can open it.
//   2. As one image message on the Π system thread — it renders in the dashboard.
// The single public/captures location is BOTH the served URL AND the desktop file
// (intentional — no second copy). Best-effort: never 500 the phone; a failed
// capture must not break the voice reply the phone already spoke.
router.post('/capture', async (req, res) => {
  try {
    const { image_base64, caption, question, device_id, on_device } = req.body || {};
    if (!image_base64) return res.status(400).json({ error: 'missing image_base64' });

    // service/src/routes → ../../public/captures = service/public/captures,
    // served at /captures/* by the root express.static in server.js.
    const CAPTURES_DIR = join(__dirname, '..', '..', 'public', 'captures');
    if (!existsSync(CAPTURES_DIR)) mkdirSync(CAPTURES_DIR, { recursive: true });
    const ts = Date.now();
    const filename = `cap_${ts}.jpg`;
    const localPath = join(CAPTURES_DIR, filename);
    const imageUrl = `/captures/${filename}`;
    writeFileSync(localPath, Buffer.from(image_base64, 'base64'));

    // One image message on the Π thread — same INSERT/crypto-id shape as the
    // phone-turn persist in /api/v1/query, but body_type='image' and metadata
    // carries the served URL + on-desktop path so both surfaces can find it.
    try {
      const crypto = await import('crypto');
      const now = Date.now();
      const PAN_THREAD = 'thread-pan-system';
      const msgId = 'cmsg_' + crypto.randomBytes(8).toString('hex');
      const phoneSource = device_id ? `phone-${device_id}` : 'phone';
      db.prepare(`
        INSERT INTO chat_messages (id, thread_id, sender_id, body, body_type, metadata, created_at)
        VALUES (?, ?, 'self', ?, 'image', ?, ?)
      `).run(msgId, PAN_THREAD, (caption && caption.trim()) ? caption : 'Photo', JSON.stringify({
        source: phoneSource,
        imageUrl,
        localPath,
        caption: caption || null,
        question: question || null,
      }), now);
      db.prepare(`UPDATE chat_threads SET updated_at = ? WHERE id = ?`).run(now, PAN_THREAD);
    } catch (e) {
      console.warn('[/api/v1/capture] chat-thread persist failed:', e.message);
    }

    // If the photo was analyzed ON-DEVICE (Nano), /api/v1/vision was never hit,
    // so no VisionAnalysis memory event was written. Write it here — matching the
    // server path — so on-device observations are embedded + recallable, not just
    // spoken and shown. (Server-analyzed photos already logged it in /vision;
    // on_device gates this so we never double-log.)
    if (on_device) {
      try {
        insertEvent(`vision-${ts}`, 'VisionAnalysis', JSON.stringify({
          question: question || null,
          description: (caption || '').slice(0, 500),
          image_file: filename,
          image_url: imageUrl,
          image_size: image_base64.length,
          source: device_id ? `phone-${device_id}` : 'phone',
          analyzed_on_device: true,
          timestamp: ts,
        }), req.user?.id);
      } catch (e) {
        console.warn('[/api/v1/capture] VisionAnalysis event failed:', e.message);
      }
    }

    // The finished camera turn joins his voice history like any other answered turn. The
    // phone answers "what is this" itself, so the hub never saw the question or the reply,
    // and "that had nothing to do with the camera" got silence (2026-11-03).
    if (question && caption) {
      recordVoiceTurn(req, {
        text: String(question), result: { intent: 'query', response: String(caption), camera: true },
        deviceId: device_id || req.headers['x-device-id'] || null, turnId: null, sensors: null,
      });
    }

    console.log(`[PAN Capture] Saved ${filename} (${image_base64.length} b64 chars)`);
    res.json({ ok: true, url: imageUrl, localPath });
  } catch (err) {
    console.warn('[/api/v1/capture] failed:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ── Slack bridge: scoped Slack client <-> phone ──────────────────────────────
// Two narrow relays, BOTH Craft-side (swap-safe, no Carrier restart), reusing the
// existing Carrier client-send relay — no client-manager.js change.
// The bridge device is named by PAN_SLACK_BRIDGE_DEVICE so the deployment's
// machine name stays out of source.
//   /slack/inbound : the scoped Slack client POSTs each new inbound
//     Slack message; we push it to the phone as a `slack_notify` command so the
//     phone raises a native reply notification.
//   /slack/reply   : the phone POSTs a reply; we dispatch ONLY `slack_reply` to the
//     scoped client (which runs slack-reply.js). This route can send NO other
//     command type — the phone can trigger a Slack reply and nothing else.
// Device id of the scoped client that actually talks to Slack. Deployment-specific,
// so it is resolved at call time from env -> settings -> generic default, and never
// baked into source. Read per call (not cached) so changing the setting takes effect
// without a restart.
function slackBridgeDevice() {
  if (process.env.PAN_SLACK_BRIDGE_DEVICE) return process.env.PAN_SLACK_BRIDGE_DEVICE;
  try {
    const row = get("SELECT value FROM settings WHERE key = 'slack_bridge_device'");
    if (row?.value) return row.value;
  } catch { /* settings unavailable — fall through to default */ }
  return 'slack-bridge';
}

function carrierRelay(payload, timeoutMs = 10000) {
  const carrierPort = parseInt(process.env.PAN_CARRIER_INTERNAL_PORT) || 17760;
  return fetch(`http://127.0.0.1:${carrierPort}/api/carrier/client-send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
  });
}
// The phone is NOT a pan-client and has no working push channel (its only live server->phone
// path is polling, same as permissions/intuition). So a note is queued and each device asks for
// its own every few seconds (GET /slack/pending). Who a note is for and which device gets it:
// phone-notes.js. Who sent it is what PAN Link says, never what the note says about itself.
export { noteSender, maySpeakNow };
router.post('/slack/inbound', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || !message.channelId) return res.status(400).json({ ok: false, error: 'missing message.channelId' });
    const note = addNote({
      type: 'slack', channelId: message.channelId, channel: message.channel || null,
      sender: message.sender || 'Slack', text: message.text || '',
      kind: message.kind || null, received: message.received || null,
    }, { from: noteSender(req) });
    console.log(`[/slack/inbound] queued #${note.id} ${note.sender}: ${(note.text || '').slice(0, 50)}`);
    res.json({ ok: true, queued: note.id });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
// Generic PAN notification enqueue — meeting reminders (and anything else that used to
// go to ntfy) POST here with a type. Rendered by type on the device ('slack' = reply
// notification, 'speak' = read aloud + notification, 'meeting'/other = plain notification).
// to: { user, device } — who it is for (the owner unless said) and the one device it answers.
// A device key of the form "person<id>-<link id>" (a person's device, routes/api.js /query/stream)
// names both.
export function enqueuePhoneNote({ type = 'info', title = 'PAN', body = '', data = null } = {}, from = null, to = {}) {
  const limit = type === 'speak' ? 2000 : 500;
  let { user, device } = to || {};
  const theirs = /^person(\d+)-(.+?)(?:-bench)?$/.exec(String(device || ''));
  if (theirs) { user = Number(theirs[1]); device = theirs[2]; }
  const note = addNote({ type: String(type).slice(0, 20), title: String(title).slice(0, 200), body: String(body).slice(0, limit), data },
    { from, toUser: user, toDevice: device });
  console.log(`[notify] queued #${note.id} [${note.type}] from ${from ? `${from.name || 'a device'} (${from.device})` : 'the hub'} for ${note.to_user === 1 ? 'the owner' : `person ${note.to_user}`}${note.to_device ? ` on ${note.to_device}` : ''} ${title}: ${String(body).slice(0, 50)}`);
  return note;
}
router.post('/notify/inbound', (req, res) => {
  try {
    const from = noteSender(req);
    if (String(req.body?.type) === 'speak' && !maySpeakNow(from)) {
      console.warn(`[notify] ${from.name || 'a device'} (${from.device}) is over ${SPEAK_PER_MINUTE} spoken notes a minute: refused`);
      return res.status(429).json({ ok: false, error: 'too many spoken notes, wait a minute' });
    }
    // Who a note is for can be said by the hub and by the owner's own full devices. A device that
    // is limited to sending notes (a work computer) sends to the owner and to nobody else.
    let user;
    if (req.body?.to_user !== undefined && req.body.to_user !== null) {
      const limited = from ? linkDevice(notesDataDir(), from.device)?.limited !== false : false;
      if (limited) return res.status(403).json({ ok: false, error: 'this device may not say who a note is for' });
      const id = req.body.to_user;
      if (!Number.isInteger(id) || !db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(id)) return res.status(400).json({ ok: false, error: 'no such person' });
      user = id;
    }
    const note = enqueuePhoneNote(req.body || {}, from, { user });
    res.json({ ok: true, queued: note.id });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
// A device asks for its notes, every few seconds. It gets the ones for the person it belongs to
// (phone-notes.js): a person's device is known by its PAN Link key alone, the owner's devices
// also by the name they send.
router.get('/slack/pending', (req, res) => {
  const person = req.user?.person ? req.user : null;
  const key = person ? '' : String(req.headers['x-device-id'] || req.query.device_id || '');
  const dev = { key, linkDevice: req.panLinkDevice?.id || '', person };
  // Notes first: it is what records that this device is asking. Then the messages from other
  // people on this hub that wait for its person (person-messages.js keeps those in the database).
  const notifications = takeNotesFor(dev);
  try { notifications.push(...takeMessagesFor(dev)); } catch (e) { console.warn('[/slack/pending] messages:', e.message); }
  // fast: this person is in a call or being called, so the device asks again in a second, not five.
  let fast = false;
  try { fast = talkFast(person ? Number(person.id) : 1) || roomFast(person ? Number(person.id) : 1); } catch {}
  // voice: this device carries its person's call and someone else is on, so it sends its
  // microphone's sound and plays the others' (call-voice.js).
  let voice = false;
  try { voice = voiceFor(person ? Number(person.id) : 1, dev); } catch {}
  // ringing: a timer or alarm goes off on this device (ringing.js). stop_ringing: the person asked
  // PAN to stop it, so the device dismisses it now.
  let stop_ringing = false;
  try {
    stop_ringing = ringing.report(person ? Number(person.id) : 1, key || dev.linkDevice,
      { ringing: req.query.ringing === '1', name: String(req.query.name || req.headers['x-device-name'] || '') });
  } catch {}
  res.json({ ok: true, notifications, fast, voice, ...(stop_ringing ? { stop_ringing } : {}) });
});

// The People tab (person-messages.js): the other people on this hub with the newest message
// from each, one conversation, and a typed message. Each call is held to the caller: the owner
// on his devices, a person on theirs (who that is comes from PAN Link's key). Nobody opens a
// conversation they are not in. The one exception is the owner's call (2026-11-18): the owner
// can read a child's conversations, with ?of=<the child's id>. Only the owner's own devices,
// only a person whose role is child, nothing is marked opened by it, and the child's own list
// says who can read (me.read_by).
const callerId = (req) => (req.user?.person ? Number(req.user.id) : 1);
// The device a request came from, as /slack/pending names it: the one that carries a call's voice.
const callDev = (req) => ({ key: req.user?.person ? '' : String(req.headers['x-device-id'] || req.query.device_id || ''), linkDevice: req.panLinkDevice?.id || '' });
function childToRead(req, res) {
  const of = Number(req.query.of);
  if (!req.user?.person && ownerMayRead(of)) return of;
  res.status(403).json({ ok: false, error: 'not yours to read' });
  return 0;
}
router.get('/people', (req, res) => {
  const me = callerId(req);
  const person = req.user?.person ? req.user : null;
  if (req.query.of !== undefined) {
    const of = childToRead(req, res);
    if (!of) return;
    const child = peopleHere().find((p) => p.id === of);
    return res.json({ ok: true, of: { id: of, name: child.name, role: child.role }, people: peopleFor(of) });
  }
  const self = peopleHere().find((p) => p.id === me);
  const canSend = !person || may(person, 'messages');
  // The groups inside the organization (people-groups.js), and which one each person is in.
  const groups = groupsHere();
  const groupsOfUser = (id) => groups.filter((g) => g.members.includes(id)).map((g) => g.id);
  // groups: every group the person is in. group: the first of them, for apps before 0.5.25.
  const people = (canSend ? peopleFor(me) : []).map((p) => ({ ...p, groups: groupsOfUser(p.id), group: groupsOfUser(p.id)[0] ?? null }));
  const owner = peopleHere().find((p) => p.id === 1);
  // group: what the owner calls the people on this hub ("Family", a company's name); '' until named.
  let group = '';
  try { group = String(get("SELECT value FROM settings WHERE key = 'people_group_name'")?.value || '').replace(/^"|"$/g, '').trim().slice(0, 30); } catch {}
  res.json({ ok: true, group, groups: groups.map((g) => ({ id: g.id, name: g.name })), can_meet: !person || may(person, 'meet'), talk: talkState(me), rooms: roomState(me, Date.now(), { start: !person || (may(person, 'messages') && may(person, 'group_calls')) }),
    me: { id: me, name: self?.name || '', role: self?.role || (person ? person.role : 'owner'), owner: !person, messages: messageMode(me), groups: groupsOfUser(me), group: groupsOfUser(me)[0] ?? null,
      read_by: person && ownerMayRead(me) ? (owner?.first || 'the owner') : null },
    can_send: canSend, people, unread: people.reduce((n, p) => n + p.unread, 0) });
});
router.get('/people/messages', (req, res) => {
  const person = req.user?.person ? req.user : null;
  if (person && !may(person, 'messages')) return res.status(403).json({ ok: false, error: refusal('messages') });
  if (req.query.of !== undefined) {
    const of = childToRead(req, res);
    if (!of) return;
    const theirs = conversation(of, Number(req.query.with), { before: Number(req.query.before) || 0, mark: false });
    if (!theirs) return res.status(404).json({ ok: false, error: 'nobody by that id on this hub' });
    return res.json({ ok: true, of, ...theirs });
  }
  const talk = conversation(callerId(req), Number(req.query.with), { before: Number(req.query.before) || 0 });
  if (!talk) return res.status(404).json({ ok: false, error: 'nobody by that id on this hub' });
  res.json({ ok: true, ...talk });
});
// People with a ΠAN of their own that the caller has met (met-people.js). The phone scans the
// other person's code, checks it, and tells its own hub; the hub hears from nobody else. Each
// person's list is their own.
router.get('/people/met', (req, res) => {
  res.json({ ok: true, met: metFor(callerId(req)) });
});
router.post('/people/met', (req, res) => {
  const person = req.user?.person ? req.user : null;
  if (person && !may(person, 'meet')) return res.status(403).json({ ok: false, error: refusal('meet') });
  const met = recordMet(callerId(req), { name: req.body?.name, key: req.body?.key });
  if (met.error) return res.status(400).json({ ok: false, error: `bad ${met.error}` });
  res.json({ ok: true, met });
});
router.delete('/people/met', (req, res) => {
  res.json({ ok: true, forgotten: forgetMet(callerId(req), Number(req.query.id)) });
});
// Read out or shown only (person-messages.js): a person for themselves unless the owner locked
// it; the owner for anyone ({ user, mode, locked }).
router.put('/people/mode', (req, res) => {
  const person = req.user?.person ? req.user : null;
  const user = person ? Number(person.id) : Number(req.body?.user) || 1;
  const set = setMessageMode(user, { mode: req.body?.mode, locked: person ? undefined : req.body?.locked }, person);
  if (!set.ok) return res.status(set.reason === 'locked' || set.reason === 'not_yours' ? 403 : set.reason === 'nobody' ? 404 : 400).json({ ok: false, error: set.reason });
  res.json({ ok: true, user, mode: set.mode, locked: set.locked });
});
// Groups inside the organization: the owner makes, names, deletes and fills them. Everyone
// sees them in GET /people. A person's device cannot reach these (they are not in PERSON_ALLOW).
const groupRefused = (reason) => (reason === 'group' || reason === 'nobody' ? 404 : reason === 'taken' ? 409 : 400);
const ownerOnly = (req, res) => {
  if (!req.user?.person) return true;
  res.status(403).json({ ok: false, error: 'Only whoever set up this ΠAN changes its groups.' });
  return false;
};
router.post('/people/groups', (req, res) => {
  if (!ownerOnly(req, res)) return;
  const made = addGroup(req.body?.name);
  if (!made.ok) return res.status(groupRefused(made.reason)).json({ ok: false, error: made.reason });
  res.json({ ok: true, group: made.group });
});
router.put('/people/groups/member', (req, res) => {
  if (!ownerOnly(req, res)) return;
  // { user, group, in }: into the group (in: true, the default) or out of it. group null: out of
  // every group. An app before 0.5.25 sends no `in` and means "this group only".
  const only = req.body?.in === undefined && req.body?.group !== null && req.body?.group !== undefined;
  let moved = setInGroup(Number(req.body?.user), req.body?.group ?? null, req.body?.in !== false);
  if (!moved.ok) return res.status(groupRefused(moved.reason)).json({ ok: false, error: moved.reason });
  if (only) for (const g of moved.groups) if (g !== Number(req.body.group)) moved = setInGroup(Number(req.body.user), g, false);
  res.json({ ok: true, user: Number(req.body?.user), groups: moved.groups, group: moved.groups[0] ?? null });
});
router.put('/people/groups/:id', (req, res) => {
  if (!ownerOnly(req, res)) return;
  const named = renameGroup(Number(req.params.id), req.body?.name);
  if (!named.ok) return res.status(groupRefused(named.reason)).json({ ok: false, error: named.reason });
  res.json({ ok: true, group: named.group });
});
router.delete('/people/groups/:id', (req, res) => {
  if (!ownerOnly(req, res)) return;
  const gone = removeGroup(Number(req.params.id));
  if (!gone.ok) return res.status(groupRefused(gone.reason)).json({ ok: false, error: gone.reason });
  res.json({ ok: true });
});
// Other names a person goes by, for a name the speech model cannot spell: { user?, names: [] }.
// A person sets their own; the owner sets anyone's.
router.put('/people/names', (req, res) => {
  const person = req.user?.person ? req.user : null;
  const user = person ? Number(req.body?.user) || Number(person.id) : Number(req.body?.user) || 1;
  const set = setNicknames(user, req.body?.names, person);
  if (!set.ok) return res.status(set.reason === 'not_yours' ? 403 : set.reason === 'nobody' ? 404 : set.reason === 'taken' ? 409 : 400).json({ ok: false, error: set.reason });
  res.json({ ok: true, user, names: set.names });
});
// A call, opened or closed from the app (the same thing as "PAN, talk to Maria" and "PAN, hang up").
router.post('/people/talk', (req, res) => {
  const person = req.user?.person ? req.user : null;
  if (person && !may(person, 'messages')) return res.status(403).json({ ok: false, error: refusal('messages') });
  const started = startTalk(person, Number(req.body?.with));
  if (!started.ok) return res.status(started.reason === 'not_taking' ? 409 : 404).json({ ok: false, error: started.reason, name: started.name });
  setCallDevice(callerId(req), callDev(req));
  res.json({ ok: true, joined: started.joined, talk: talkState(callerId(req)) });
});
router.delete('/people/talk', (req, res) => {
  endTalk(req.user?.person ? req.user : null);
  res.json({ ok: true, talk: talkState(callerId(req)) });
});
// A call with a whole group (group-calls.js), from the app: the same thing as "PAN, call the
// Kids", "PAN, answer" and "PAN, hang up". { room }: 'all' or 'g<group id>'. Opening one that
// is going on comes on to it. Each call is held to the caller and to the groups they are in.
router.post('/people/room', (req, res) => {
  const person = req.user?.person ? req.user : null;
  const got = startRoom(person, String(req.body?.room || ''));
  if (!got.ok) {
    const status = got.reason === 'limit' || got.reason === 'not_in' ? 403 : got.reason === 'group' ? 404 : 409;
    return res.status(status).json({ ok: false, error: got.reason === 'limit' ? refusal('group_calls') : got.reason, name: got.name });
  }
  setCallDevice(callerId(req), callDev(req));
  res.json({ ok: true, started: got.started, rooms: roomState(callerId(req)), talk: talkState(callerId(req)) });
});
// The voice itself in a call (call-voice.js). A device sends its microphone's sound in short
// pieces (16 kHz mu-law, the request's body) and holds one stream open for what the others say.
// The hub passes it on and keeps none of it. Only someone on a call others have joined, and
// only from the device that opened or answered it.
// One path, one method, both ways: with ?listen the answer is the stream of the others' sound
// (listen=2: the device plays Opus too); without it the body is a piece of this device's own
// (c=1: Opus). (One rule on the person allow list.)
router.post('/people/voice', (req, res, next) => {
  if (!req.query.listen) return next();
  res.status(200).set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  const got = openVoiceStream(req.user?.person ? req.user : null, res, callDev(req), Date.now(), String(req.query.listen) === '2');
  if (!got.ok) { res.status(409).type('json').end(JSON.stringify({ ok: false, error: got.reason })); return; }
  res.flushHeaders();
  req.socket?.setNoDelay?.(true);
}, express.raw({ type: 'application/octet-stream', limit: '64kb' }), (req, res) => {
  const opus = String(req.query.c) === '1';
  const got = pushVoice(req.user?.person ? req.user : null, req.body, callDev(req), Date.now(), opus ? 1 : 0);
  if (!got.ok) return res.status(got.reason === 'no_call' || got.reason === 'not_this_device' ? 409 : 400).json({ ok: false, error: got.reason });
  // Several of these a second over someone's mobile data: an Opus piece that everyone can play
  // gets the shortest answer there is.
  if (opus && got.opus) { res.removeHeader('X-Powered-By'); return res.status(204).end(); }
  res.json({ ok: true, to: got.to, opus: got.opus });
});
router.delete('/people/room', (req, res) => {
  leaveRoom(req.user?.person ? req.user : null);
  res.json({ ok: true, rooms: roomState(callerId(req)) });
});
router.post('/people/room/decline', (req, res) => {
  const name = declineRoom(req.user?.person ? req.user : null, String(req.body?.room || ''));
  res.json({ ok: true, declined: !!name, rooms: roomState(callerId(req)) });
});
// A typed line from someone who is on: it goes to the others who are on, as a spoken one does.
router.post('/people/room/say', (req, res) => {
  const said = sayInRoom(req.user?.person ? req.user : null, req.body?.text);
  if (!said.ok) return res.status(said.reason === 'limit' ? 403 : said.reason === 'too_many' ? 429 : 409).json({ ok: false, error: said.reason });
  res.json({ ok: true, id: said.id });
});
// The lines of one group's calls that the caller said or heard: ?room=&before=.
router.get('/people/room/lines', (req, res) => {
  const out = roomLines(callerId(req), String(req.query.room || ''), { before: Number(req.query.before) || 0 });
  if (!out) return res.status(404).json({ ok: false, error: 'not yours to read' });
  res.json({ ok: true, ...out });
});
// Take calls from one person or not: { from, take }. Each person's own choice.
router.put('/people/calls', (req, res) => {
  const set = setCallsBlocked(callerId(req), Number(req.body?.from), req.body?.take === false);
  if (!set.ok) return res.status(set.reason === 'nobody' ? 404 : 403).json({ ok: false, error: set.reason });
  res.json({ ok: true, from: Number(req.body?.from), take: !set.blocked });
});
// The person being called says no: { from }. The caller is told and their side closes.
router.post('/people/talk/decline', (req, res) => {
  const who = declineTalk(req.user?.person ? req.user : null, Number(req.body?.from));
  res.json({ ok: true, declined: !!who, talk: talkState(callerId(req)) });
});
router.post('/people/messages', (req, res) => {
  const person = req.user?.person ? req.user : null;
  if (person && !may(person, 'messages')) return res.status(403).json({ ok: false, error: refusal('messages') });
  const sent = sendMessage({ from: person, to: { id: Number(req.body?.to) }, kind: 'says', body: req.body?.body, how: 'typed' });
  if (!sent.ok) {
    return res.status(sent.reason === 'too_many' ? 429 : sent.reason === 'nobody' ? 404 : 400).json({ ok: false, error: sent.reason });
  }
  res.json({ ok: true, id: sent.id, reachable: sent.reachable });
});
// Which of the owner's devices his notes go to (phone-notes.js). Not open to a person's device.
router.get('/notify/devices', (req, res) => {
  res.json({ ok: true, ...notesDevices() });
});
router.post('/slack/reply', async (req, res) => {
  try {
    const { channelId, text } = req.body || {};
    if (!channelId || !text) return res.status(400).json({ ok: false, error: 'missing channelId or text' });
    const relay = await carrierRelay({ device_id: slackBridgeDevice(), type: 'slack_reply', channelId, text, timeout_ms: 90000 }, 95000);
    const data = await relay.json().catch(() => ({}));
    if (relay.ok && data.ok) return res.json({ ok: true, result: data.result || null });
    return res.status(relay.status === 404 ? 503 : 500).json({ ok: false, error: data.error || `slack client unreachable (${relay.status})` });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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

  // Client-disconnect cleanup: without this the keepalive interval keeps
  // firing forever and the socket sits in CLOSE_WAIT on Craft's side
  // (caused 39+ leaked sockets and event-loop pressure in field testing).
  // We listen on `res` (not `req`) per the comment on the /chat/stream
  // handler above — `req.on('close')` fires too eagerly.
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      clearInterval(keepaliveInterval);
    }
  });

  try {
    // Use searchMemory (FTS5 + vector/semantic RRF) — same engine as router recall.
    // The old hand-rolled FTS-only query missed semantic matches and accumulated
    // false negatives as failed searches got indexed as events (circular contamination).
    const { searchMemory } = await import('../memory-search.js');
    // Explicit recall endpoint — vectors stay on. FTS-only returns the hook
    // JSON scaffolding rather than what was said; see the routeStream recall
    // branch for the measurement. The every-turn pre-gates remain FTS-only.
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
      // His note on a thing the question names (memory/things.js) goes first, as it is.
      if (!hit.event && hit.hit === 'note') { entries.unshift({ time: 'his note', text: hit.preview.slice(0, 500) }); continue; }
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
    // No model named: the 'recall' caller's model applies (job_models, else ai_model)
    const { claude: claudeCall } = await import('../claude.js');
    const fullText = await claudeCall(prompt, { maxTokens: 400, timeout: 15000, caller: 'recall', _skipAnonymize: true }) || '';
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
// Every command waits for the ONE device it is meant for (screen-control.js): the app names its
// device when it asks, and a command names its device or goes to the only one that is on.
const screenControl = createScreenControl();
const pendingA11yResults = new Map();

router.get('/accessibility/commands', (req, res) => {
  res.json(screenControl.poll(req.query.device || req.headers['x-device-id'], req.headers['x-device-name']));
});

// Which devices have the service on right now.
router.get('/accessibility/devices', (req, res) => {
  res.json({ devices: screenControl.devices() });
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
  const { action, device, ...params } = req.body;
  if (!action) return res.status(400).json({ error: 'missing action' });

  const id = `a11y-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const queued = screenControl.add({ id, action, ...params }, device);
  if (queued.error) return res.json({ ok: false, error: queued.error });

  const timeout = setTimeout(() => {
    pendingA11yResults.delete(id);
    res.json({ ok: false, device: queued.device, error: 'The device did not answer in 15 seconds.' });
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
    // The phone's zone is his clock (intuition/time.js); a bench turn's is not.
    if (parsedSensors?.tz && !req.body?.bench) setPhoneTimeZone(parsedSensors.tz);

    // Conversation-memory guarantee (server-side). The phone SHOULD send `context`,
    // but the plain voice path sends null → cold prompt: PAN forgets its own last
    // reply and contradicts itself a turn later. This is the SAME failure /chat hit
    // and fixed (see the conversation_history builder above); the phone /query path
    // never got it. Fix at the source, not the client: if no usable history came in,
    // rebuild it from the last turns on the Π thread (where every phone turn is
    // persisted). Device-agnostic — the pendant gets conversation memory for free,
    // and it's one continuous thread across phone/pendant/desktop. 30-min recency
    // window so an ongoing chat stays connected but a genuinely new one starts fresh.
    let conversation_history = context;
    if (!conversation_history || String(conversation_history).trim().length < 10) {
      try {
        const since = Date.now() - 30 * 60 * 1000;
        const rows = db.prepare(`
          SELECT sender_id, body FROM chat_messages
          WHERE thread_id = 'thread-pan-system' AND body_type = 'text' AND created_at > ?
          ORDER BY created_at DESC LIMIT 16
        `).all(since);
        if (rows.length > 0) {
          conversation_history = rows.reverse().map(r => {
            const who = r.sender_id === 'self' ? 'You' : 'PAN';
            return `${who}: ${String(r.body || '').slice(0, 400)}`;
          }).join('\n');
        }
      } catch (e) { console.warn('[/query] conversation-history fallback failed:', e?.message); }
    }

    const result = await route(text, {
      source: device_id ? `phone-${device_id}` : 'phone',
      device_id,
      intent_hint,
      _commandId: cmdId,
      conversation_history,
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

    // Persist phone turn to chat_messages on the Π system thread so the
    // conversation is VISIBLE on the desktop (Π thread, comms popup,
    // LiveCallPanel widget). Before this, phone calls only showed up in
    // command_queue + VoiceCommand events — invisible to every dashboard
    // surface. Same shape as /api/v1/chat does when thread_id is set,
    // including the debug-metadata payload so the chip + intuition trace
    // render the same way as desktop voice calls.
    //
    // Skip persistence for ambient classifications since they're not part
    // of the conversation — same rule the dashboard popup follows.
    try {
      if (result.intent !== 'ambient' && result.response && result.response !== 'No response') {
        const crypto = await import('crypto');
        const now = Date.now();
        const PAN_THREAD = 'thread-pan-system';
        const userMsgId = 'cmsg_' + crypto.randomBytes(8).toString('hex');
        const panMsgId  = 'cmsg_pan_' + now + '_' + crypto.randomBytes(4).toString('hex');
        const phoneSource = device_id ? `phone-${device_id}` : 'phone';
        db.prepare(`
          INSERT INTO chat_messages (id, thread_id, sender_id, body, body_type, metadata, created_at)
          VALUES (?, ?, 'self', ?, 'text', ?, ?)
        `).run(userMsgId, PAN_THREAD, text, JSON.stringify({
          source: phoneSource,
          device_id,
          speaker_id: req.body.speaker_id || null,
        }), now);
        db.prepare(`
          INSERT INTO chat_messages (id, thread_id, sender_id, body, body_type, metadata, created_at)
          VALUES (?, ?, 'contact-pan-system', ?, 'text', ?, ?)
        `).run(panMsgId, PAN_THREAD, result.response, JSON.stringify({
          intent: result.intent || null,
          source: phoneSource,
          debug: result._debug || null,
        }), now + 1);
        db.prepare(`UPDATE chat_threads SET updated_at = ? WHERE id = ?`).run(now + 1, PAN_THREAD);
      }
    } catch (e) {
      console.warn('[/api/v1/query] phone-to-chat-thread persist failed:', e.message);
    }

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

// Same server-side conversation-memory guarantee as /query (see there): rebuild the thread from
// the Π thread when the client sends no usable history, so the streaming voice path is never a
// cold prompt either.
function voiceHistory(context) {
  if (context && String(context).trim().length >= 10) return context;
  try {
    const since = Date.now() - 30 * 60 * 1000;
    const rows = db.prepare(`
      SELECT sender_id, body FROM chat_messages
      WHERE thread_id = 'thread-pan-system' AND body_type = 'text' AND created_at > ?
      ORDER BY created_at DESC LIMIT 16
    `).all(since);
    if (rows.length > 0) {
      return rows.reverse().map(r => {
        const who = r.sender_id === 'self' ? 'You' : 'PAN';
        return `${who}: ${String(r.body || '').slice(0, 400)}`;
      }).join('\n');
    }
  } catch (e) { console.warn('[/query/stream] conversation-history fallback failed:', e?.message); }
  return context;
}

// POST /api/v1/voice/warm — his turn is coming: PAN's reply just ended, or he started talking.
// Nobody waits on it. The phone sends the history it will send with the turn.
router.post('/voice/warm', async (req, res) => {
  res.json({ ok: true });
  // The read ahead is the owner's talk and situation: a person's device warms nothing.
  if (req.user?.person) return;
  try {
    const { warmStudent } = await import('../router.js');
    // org and sensors: the turn's situation line is built from them, and the read has to match it.
    let sensors = req.body.sensors;
    if (typeof sensors === 'string') { try { sensors = JSON.parse(sensors); } catch { sensors = undefined; } }
    warmStudent(req.body.bench ? req.body.context : voiceHistory(req.body.context),
      { org_id: req.org_id || 'org_personal', sensors });
  } catch (e) { console.warn('[/voice/warm]', e?.message); }
});

// POST /api/v1/reading — how a line in another script is said, in Latin letters, word by word
// with a short meaning for each (reading.js). The phone asks after it has spoken an interpreted
// line, so nothing waits on this. { text, lang } -> { ok, romaji, words } or { ok: false } for a
// language there is no reader for yet.
router.post('/reading', async (req, res) => {
  try {
    const text = String(req.body?.text || '').slice(0, 600);
    const lang = String(req.body?.lang || '').toLowerCase().slice(0, 5);
    if (!text.trim()) return res.json({ ok: false });
    const { readLine } = await import('../reading.js');
    const r = await readLine(text, lang);
    res.json(r ? { ok: true, lang, ...r } : { ok: false });
  } catch (e) {
    console.warn('[/reading]', e?.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/v1/query/stream — SSE streaming voice query
// Yields chunks of the response as they're generated so the phone can start TTS immediately.
// Event format: "data: {type:'chunk',text:'...'}\n\n" then "data: {type:'done',result:{...}}\n\n"
// His voice profile for voice-id.js: how many lines it has learned, and a way to start again.
// His notes on things (memory/things.js): GET lists them (q filters by name), GET /things/:name
// reads one, POST /things/write writes one now ({ name, dry }: dry returns it without saving).
router.get('/things', (req, res) => {
  try { res.json({ things: listThings({ q: req.query.q || '', limit: req.query.limit, withNotes: req.query.all !== '1' }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/things/:name', (req, res) => {
  try { const t = getThing(req.params.name); t ? res.json(t) : res.status(404).json({ error: 'no such thing' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/things/write', async (req, res) => {
  try { res.json(await writeThingNow(req.body?.name, { dry: !!req.body?.dry })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// The brief (intuition/brief.js): what the voice model should already know before he talks,
// about 500 tokens. The phone pulls it to keep its own copy for its on-device model.
router.get('/brief', async (req, res) => {
  try { res.json((await import('../router.js')).briefNow({ org_id: req.query.org || 'org_personal' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/voice/profile', async (req, res) => {
  try { res.json((await import('../voice-id.js')).profileState()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/voice/profile', async (req, res) => {
  try { const v = await import('../voice-id.js'); v.resetProfile(); res.json(v.profileState()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/query/stream', async (req, res) => {
  // App 0.4.106+: the turn's audio as G.711 mu-law (half the bytes of PCM16; on his 4G hotspot the
  // upload was most of the wait, Nov 14). Back to PCM16 here, so everything after is unchanged.
  if (req.body.audio_ulaw && !req.body.audio) {
    try {
      const u = Buffer.from(String(req.body.audio_ulaw), 'base64');
      const pcm = Buffer.alloc(u.length * 2);
      for (let i = 0; i < u.length; i++) {
        const v = ~u[i] & 0xff, exp = (v >> 4) & 7, x = ((((v & 0x0f) << 3) + 0x84) << exp) - 0x84;
        pcm.writeInt16LE(v & 0x80 ? -x : x, i * 2);
      }
      req.body.audio = pcm.toString('base64');
    } catch (e) { console.warn('[/query/stream] mu-law audio unreadable:', e.message); }
  }
  const { text: phoneText, context, intent_hint, sensors, can_camera, audio, bench } = req.body;
  if (!phoneText) return res.status(400).json({ error: 'missing text' });
  // Someone other than the owner (people.js). Their device is named by its PAN Link key, never by
  // a header it sends: a header could name the owner's phone, and with it cancel his turns or
  // pick up his standing instruction. Nothing of the owner's is read for the turn and nothing of
  // it is stored (router.js personTurn).
  const person = req.user?.person ? req.user : null;
  const deviceName = person ? `person${person.id}-${String(req.panLinkDevice?.id || 'device')}`
    : (req.headers['x-device-id'] || req.headers['x-device-name'] || null);
  let text = phoneText;
  // One id per turn so this handler's timings and the router's line up in voice-timing.jsonl.
  const turnId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const turnStart = Date.now();

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

  // Before the transcription, not after it: the superseded turn's model was still
  // generating on the hub CPU while this turn's Parakeet ran (voicebench, 2026-11-02).
  // Task #460 — cancel the in-flight turn when a new STT Final arrives.
  //
  // This endpoint previously passed NO signal to routeStream, so nothing could
  // stop a turn once it started. When one stalled, the phone re-sent and the
  // server ran every copy to completion: that is the triple-send. The
  // 2026-07-15 searchMemory timeout removed the usual TRIGGER for the stall but
  // not the ability to pile up, which is why this stayed open.
  //
  // Keyed by DEVICE rather than a random id, because the thing that should
  // cancel a turn is the same phone saying something new. Reuses the existing
  // streamControllers registry so /cancel and the TTL sweeper keep working
  // instead of needing a second parallel mechanism.
  const streamKey = `phone:${deviceName || 'unknown'}`;
  // Turns are ordered by when the phone SENT them, not by when they got here. On a slow link the upload
  // of an older sentence can land after a newer one. The phone had already dropped that older turn, yet
  // here it cancelled the newer one: the real question got "Sorry, I ran into a problem" and the answer
  // to the line he had moved on from was spoken to nobody (car on a 4G hotspot, 2026-11-17). The gap is
  // capped so a phone whose clock was set back is not shut out.
  let sentAt = 0;
  try { sentAt = Number((typeof sensors === 'string' ? JSON.parse(sensors) : sensors)?.timestamp) || 0; } catch {}
  const newestSent = newestTurnSentAt.get(streamKey) || 0;
  if (sentAt && sentAt < newestSent && newestSent - sentAt < 120_000) {
    console.log(`[/query/stream] older turn for ${streamKey} arrived late (sent ${newestSent - sentAt} ms before the newest) - dropped`);
    clearInterval(keepaliveInterval);
    send({ type: 'done', result: { intent: 'cancelled', response: '' } });
    return res.end();
  }
  if (sentAt) newestTurnSentAt.set(streamKey, sentAt);
  const superseded = streamControllers.get(streamKey);
  if (superseded) {
    try { superseded.controller.abort(); } catch {}
    streamControllers.delete(streamKey);
    console.log(`[/query/stream] superseded in-flight turn for ${streamKey}`);
  }
  const controller = new AbortController();
  registerStream(streamKey, controller);

  // Client-disconnect cleanup — same fix as /recall/stream above. Without
  // this the keepalive interval leaked forever and the underlying socket
  // stayed in CLOSE_WAIT on Craft's side, piling up until Craft's HTTP
  // server stopped accepting new connections.
  res.on('close', () => {
    if (!res.writableEnded) {
      clearInterval(keepaliveInterval);
      // Abort too: a phone that hung up should not leave the model generating
      // into a socket nobody is reading.
      try { controller.abort(); } catch {}
    }
  });

  // App 0.4.43+ sends the turn's audio (16kHz PCM16, base64). The phone's streaming model
  // decided when the turn ended; Parakeet on the hub decides what was said (hub-asr.js).
  // 'heard' tells the phone the corrected words for its own history.
  let heardLang = null;   // the language the interpreting model heard, when it says
  // The device's standing-instruction key: the deviceId routeStream gets, below.
  const { interpretingFor, learnInterpretingLanguage } = await import('../router.js');
  const realId = deviceName;
  const key = bench ? `${realId || 'phone'}-bench` : realId;
  // Background model jobs (the nightly benchmark) wait while he is talking: on Nov 14 it fired a
  // prompt every 10 to 30 s during his talk, the voice reader timed out and turns took 8 to 11 s.
  if (!bench) globalThis.__panLastVoiceAt = Date.now();
  const interp = interpretingFor(key);
  // Interpreting: the phone speaks this reply's English in its Android voice, which starts in
  // ~0.2 s, not Supertonic, which synthesizes the whole line first (app 0.4.69+; older apps
  // ignore the event).
  if (interp) send({ type: 'interpreting' });
  // Whose voice (voice-id.js): his, someone else's, or can't tell. Loaded here, not at the top,
  // so a missing model or package can never stop the server from booting.
  let voice = null;
  let voiceWearer;
  let voiceWho = null;
  let voicePrintNow = null;
  if (audio && !bench && !person) {
    try {
      voice = await import('../voice-id.js');
      const print = voice.voicePrint(audio);
      const who = voice.whoseVoice(print);
      voicePrintNow = print;   // a module namespace is not extensible: voice.print threw on every turn (Nov 14)
      voiceWearer = who.wearer;
      voiceWho = who;
      if (who.likeness !== null) console.log(`[voice-id] likeness ${who.likeness.toFixed(2)} -> ${who.verdict === undefined ? 'unsure' : who.verdict ? 'his voice' : 'someone else'} (gate ${voice.gateMode()})`);
    } catch (e) { console.warn('[voice-id] skipped:', e.message); voice = null; }
  }
  // A person's device takes its own person's voice and nobody else's (person-voices.js; the
  // owner, 2026-11-18, with his phone and another person's side by side: that person's ΠAN must
  // not pick up what he says). Clearly the owner's voice, or another known person's, or clearly
  // not this device's person once it knows them: dropped before transcription. Unsure goes on
  // to the room check below (same-line.js).
  let personVoice = null;      // { print, who, owner, pan } on a person's device
  if (audio && !bench && person) {
    try {
      const v = await import('../voice-id.js');
      const pv = await import('../person-voices.js');
      const print = v.voicePrint(audio);
      const owner = print ? v.whoseVoice(print).likeness : null;
      const who = pv.whoseOnDevice(person.id, print, { owner });
      personVoice = { print, who, owner, pan: !!print && (v.panVoiceLikeness(print)?.likeness ?? 0) >= v.PAN_SELF };
      if (print) console.log(`[voice-id] on person ${person.id}'s device: theirs ${who.mine?.toFixed(2) ?? '-'} owner ${owner?.toFixed(2) ?? '-'} -> ${who.verdict}${who.verdict === 'other' ? `, dropped${who.by ? ` (person ${who.by}'s voice)` : ''}` : who.leans ? `, leans to person ${who.leans}` : ''}`);
      if (who.verdict === 'other') {
        recordTiming({ turn: turnId, stage: 'other_voice_on_person_device', ms: Date.now() - turnStart });
        send({ type: 'done', result: { intent: 'ambient', response: '', reason: 'other_voice' } });
        clearInterval(keepaliveInterval);
        if (streamControllers.get(streamKey)?.controller === controller) clearStream(streamKey);
        if (!res.writableEnded) res.end();
        return;
      }
    } catch (e) { console.warn('[voice-id] person device check skipped:', e.message); }
  }
  // PAN's own voice coming back through the mic (voice-id.js, Nov 15): drop the turn before
  // transcription, unless it is clearly his voice too (he talked over PAN).
  if (voice && voicePrintNow) {
    const self = voice.panVoiceLikeness(voicePrintNow);
    // A line that names PAN is his: PAN does not say its own name.
    const drop = !!self && self.likeness >= voice.PAN_SELF && voiceWho?.verdict !== true && !/\b(pan|pam|pann)\b/i.test(String(phoneText)) && voice.panSelfGateOn();
    // One line per turn: separate lines went missing from carrier.log (Nov 15).
    if (self) console.log(`[voice-id] self ${self.likeness.toFixed(2)} his ${voiceWho?.likeness?.toFixed(2) ?? '-'} -> ${drop ? 'DROPPED, PAN heard itself' : 'kept'}: ${JSON.stringify(String(phoneText).slice(0, 60))}`);
    if (drop) {
      recordTiming({ turn: turnId, stage: 'pan_own_voice', ms: Date.now() - turnStart });
      send({ type: 'done', result: { intent: 'ambient', response: '', reason: 'pan_own_voice' } });
      clearInterval(keepaliveInterval);
      if (streamControllers.get(streamKey)?.controller === controller) clearStream(streamKey);
      if (!res.writableEnded) res.end();
      return;
    }
  }
  // A note being written in the background (memory/things.js) stops now, before his audio is
  // read: with one running, the hub's speech recognizer took 56.6 s on one line (2026-11-23).
  try { pauseForTalk(); } catch {}
  if (audio) {
    const t0 = Date.now();
    // Interpreting, the other person speaks another language: the model for that language
    // (hub-asr.js) hears it, and says which language when it can. His own English from Whisper
    // still goes to Parakeet v2: on a short line Whisper says it again and again ("Stop
    // translating. Stop translating. Stop translating...", 2026-11-03). SenseVoice's stands: it
    // heard 6 of his 7 live lines as well as Parakeet (one stray "you"), and running Parakeet
    // after it cost 0.2 to 0.35 s on every line (2026-11-05).
    const any = interp ? await transcribeAnyLanguage(audio, interp.code) : null;
    heardLang = any?.lang || null;
    if (any && !interp.code) learnInterpretingLanguage(key, any.lang, any.text);
    const better = any && (any.lang !== 'en' || any.model === 'sensevoice') ? any.text : await transcribePcm16(audio);
    if (any) console.log(`[hub-asr] interpreting ${interp.code || '?'}: ${any.model} heard ${any.lang || '(no tag)'} ${JSON.stringify(any.text.slice(0, 60))}`);
    if (better) {
      console.log(`[hub-asr] ${Date.now() - t0}ms phone=${JSON.stringify(String(phoneText).slice(0, 80))} hub=${JSON.stringify(better.slice(0, 80))}`);
      text = better;
      send({ type: 'heard', text });
    }
    recordTiming({ turn: turnId, stage: 'asr', ms: Date.now() - t0, bench: !!bench || undefined });
    // The device's ear wrote no words for this sound and sent it anyway (app 0.5.52+, words_unheard,
    // text is a placeholder). If the hub hears no words either, nothing was said: end quietly.
    if (req.body.words_unheard && !String(better || '').trim()) {
      console.log(`[hub-asr] no words in ${Math.round(Buffer.byteLength(String(audio), 'base64') / 32)} ms of sound the device could not write down either`);
      send({ type: 'done', result: { intent: 'ambient', response: '', reason: 'nothing_heard' } });
      clearInterval(keepaliveInterval);
      if (streamControllers.get(streamKey)?.controller === controller) clearStream(streamKey);
      if (!res.writableEnded) res.end();
      return;
    }
  }

  // One line heard by two ΠANs in one room (same-line.js): the same words at the same moment on
  // two people's devices are one person's, by voice when a print says so, else the device that
  // heard it louder. The other device's turn ends here as room talk.
  if (audio && !bench && !interp) {
    try {
      const sure = person ? personVoice?.who?.verdict === 'theirs' : voiceWho?.verdict === true;
      const leans = person ? (sure ? Number(person.id) : personVoice?.who?.leans ?? null) : (sure ? 1 : null);
      const line = await whoseLine({ user: person ? Number(person.id) : 1, device: deviceName, text, level: speechLevel(audio), leans, sure });
      if (line.waited) recordTiming({ turn: turnId, stage: 'same_line_wait', ms: line.waited });
      if (!line.mine) {
        recordTiming({ turn: turnId, stage: 'heard_on_another_device', ms: Date.now() - turnStart });
        send({ type: 'done', result: { intent: 'ambient', response: '', reason: 'heard_elsewhere' } });
        clearInterval(keepaliveInterval);
        if (streamControllers.get(streamKey)?.controller === controller) clearStream(streamKey);
        if (!res.writableEnded) res.end();
        return;
      }
      // The line is this person's: their device learns their voice from it.
      if (person && personVoice?.print) {
        const pv = await import('../person-voices.js');
        pv.learnPersonVoice(person.id, personVoice.print, { owner: personVoice.owner, pan: personVoice.pan });
      }
    } catch (e) { console.warn('[same-line] skipped:', e.message); }
  }

  // The end of PAN's own last reply at the head of his line (own-tail.js). When his line began is
  // worked out from how long ago PAN stopped and how long the turn's audio is (16 kHz, 16 bit).
  const tailKey = bench ? `${streamKey}-bench` : streamKey;
  {
    const sincePan = Number(req.body.since_pan_ms);
    const audioMs = audio ? Math.round(Buffer.byteLength(String(audio), 'base64') / 32) : null;
    const began = Number.isFinite(sincePan) && audioMs !== null ? sincePan - audioMs : undefined;
    const own = dropOwnTail(tailKey, text, { began_ms: began });
    if (own !== text) {
      console.log(`[own-tail] took PAN's own words off the head (began ${began ?? '?'} ms after it stopped): ${JSON.stringify(String(text).slice(0, 60))} -> ${JSON.stringify(own.slice(0, 60))}`);
      text = own;
      send({ type: 'heard', text });
    }
  }

  let parsedSensors = sensors;
  if (typeof sensors === 'string') { try { parsedSensors = JSON.parse(sensors); } catch { parsedSensors = null; } }
  if (parsedSensors?.tz && !bench && !person) setPhoneTimeZone(parsedSensors.tz);

  // In a call with someone on this hub (person-messages.js): a line that does not name ΠAN is
  // this person's words to the other one. It is passed on as heard and ΠAN answers nothing.
  // Never for a test turn, and never while interpreting.
  if (!bench && !interp) {
    let passed = null;
    try { passed = talkLine(text, { person, wearer: person ? undefined : voiceWearer }); }
    catch (e) { console.warn('[/query/stream] call line:', e.message); }
    // The same for a call with a whole group (group-calls.js): to everyone who is on.
    if (!passed) {
      try { passed = roomLine(text, { person, wearer: person ? undefined : voiceWearer }); }
      catch (e) { console.warn('[/query/stream] group call line:', e.message); }
    }
    if (passed) {
      recordTiming({ turn: turnId, stage: 'call_line', ms: Date.now() - turnStart });
      // "Hang up" inside the call: it is over, and that is said back.
      const over = !passed.ended ? '' : passed.room ? `You left the call with ${passed.name || 'them'}.` : `Call with ${passed.name || 'them'} ended.`;
      if (over) send({ type: 'chunk', text: over });
      send({ type: 'done', result: { intent: 'talk', response: over, talk_with: passed.to, talk_room: passed.room, sent: passed.sent, reason: passed.reason, ended: !!passed.ended, addressed: passed.ended ? 1 : undefined } });
      clearInterval(keepaliveInterval);
      if (streamControllers.get(streamKey)?.controller === controller) clearStream(streamKey);
      if (!res.writableEnded) res.end();
      return;
    }
  }

  try {
    const { routeStream } = await import('../router.js');
    // A benchmark turn gets its own device key, so a test's standing instruction or
    // dialog state can never leak into his real conversation (bench-context.js).
    const realDeviceId = deviceName;
    const deviceId = bench ? `${realDeviceId || 'phone'}-bench` : realDeviceId;

    // Not for a benchmark turn: its scenario starts with an empty history on purpose,
    // and pulling his real thread in would make the run depend on his day.
    let convoHistory = bench || person ? context : voiceHistory(context);
    // A follow-up about the photo just taken ("yeah, what kind of pony?"): the phone's history
    // has only the one or two sentences PAN said, so the student also gets what the photo showed.
    // Only while the photo is still what the talk is on: added under "how far is the sun from the
    // earth", it made "how long would it take to get there?" about the photo (2026-11-08).
    if (!bench && !person && _lastLook && Date.now() - _lastLook.at < 180_000 && POINTS_AT.test(String(text || '')) && photoInFocus(convoHistory, text)) {
      convoHistory = `${convoHistory ? `${String(convoHistory).trim()}\n` : ''}PAN (what the photo showed): ${_lastLook.look.slice(0, 600)}`;
    }

    const runTurn = async () => {
      let firstChunkSent = false;
      for await (const event of routeStream(text, {
        source: deviceId ? `phone-${deviceId}` : 'phone',
        device_id: deviceId,
        person,
        // The turn came in through PAN Link (server.js, pan-link-auth.js): asked, PAN can say so.
        via_link: !!req.panLinkDevice,
        intent_hint,
        conversation_history: convoHistory,
        sensors: parsedSensors,
        signal: controller.signal,
        org_id: req.org_id,
        // App 0.4.42+ with the camera on: a camera:true done event makes it take the photo.
        canCamera: !!can_camera,
        // App 0.4.55+: he stopped mid-sentence and the phone's wait for the rest ran out.
        unfinished: !!req.body.unfinished,
        // App 0.4.105+: the assistant button (car steering wheel) was pressed, this line is for PAN.
        addressed_now: !!req.body.addressed_now,
        // App 0.4.106+: music is playing on that device's speakers (the car, Nov 14: PAN answered the lyrics).
        media_playing: !!req.body.media_playing,
        // App 0.4.73+: how long ago PAN last stopped talking. The bench records no turns, so
        // this is the only thing that tells a talk from a stray line there.
        since_pan_ms: Number.isFinite(req.body.since_pan_ms) ? req.body.since_pan_ms : undefined,
        // Voice ID (2026-11-12): true = his voice, false = someone else's; left out when unknown.
        wearer: person ? undefined : typeof req.body.wearer === 'boolean' ? req.body.wearer : voiceWearer,
        // What voice ID thinks even while its gate only watches: true his, false someone else's (router.js aloneWithPan).
        voice_his: person ? undefined : typeof req.body.voice_his === 'boolean' ? req.body.voice_his : (typeof voiceWho?.verdict === 'boolean' ? voiceWho.verdict : undefined),
        turn_id: turnId,
        heard_lang: heardLang,
      })) {
        if (event.type === 'chunk' && !firstChunkSent) {
          firstChunkSent = true;
          recordTiming({ turn: turnId, stage: 'first_chunk_sent', ms: Date.now() - turnStart });
        }
        // After the reply, so the line that sets interpreting up counts: the phone takes it over
        // when it has the models (InterpreterLoop.kt). '?' is on, with no language named yet.
        if (event.type === 'done') {
          const now = interpretingFor(key);
          send({ type: 'interpreter', lang: now ? (now.code || '?') : '' });
        }
        // Where this turn's time went, for the phone: hearing (asr), building the prompt (setup),
        // the model's own first word, the first word leaving the hub, the whole turn, and which
        // path and model answered. Times are ms; first_chunk_sent and total count from the
        // moment his line arrived.
        if (event.type === 'done' && event.result) {
          try { event.result.timing = { ...turnTimings(turnId), total_ms: Date.now() - turnStart }; } catch {}
        }
        send(event);
        if (event.type === 'done') {
          {
            const spoken = String(event.result?.response || '').trim();
            if (spoken && !spoken.startsWith('[') && !['ambient', 'cancelled'].includes(event.result?.intent)) noteSaid(tailKey, spoken);
          }
          if (!bench && !person) recordVoiceTurn(req, { text, result: event.result, deviceId, turnId, sensors: parsedSensors });
          // A call opened or answered by voice: this is the device that carries its sound.
          if (!bench && event.result?.intent === 'talk' && (event.result?.talk_with || event.result?.talk_room)) {
            try { setCallDevice(person ? Number(person.id) : 1, callDev(req)); } catch {}
          }
          // In a call, a plain answer that is not personal is read out to the other person too
          // (call-share.js). After the asker's own answer has gone out; nothing waits on it.
          if (!bench && !interp && event.result?.intent === 'query') {
            shareAnswerInCall({ person, question: text, answer: event.result?.response, intent: event.result?.intent })
              .catch((e) => console.warn('[call-share] failed:', e.message));
          }
          // His notes follow him to the device he is talking to PAN on (phone-notes.js).
          if (!bench && !person && String(event.result?.response || '').trim() && !['ambient', 'cancelled'].includes(event.result?.intent)) noteOwnerSpokeOn(deviceName);
          // The situational state program's turn book: what it saw, what PAN did; the next
          // turn labels this one (intuition/turn-book.js). Not from a test device: its test lines
          // ("what is seven times eight zebrafinch") were labeling PAN as if he had said them (Nov 22).
          if (!bench && !person && !voiceTestDevice(realId)) {
            const r = event.result || {};
            const said = String(r.response || '').trim();
            // The line's surprise and the shadow p_for_pan (v1, and v2 as p_for_pan2) go in with it
            // (intuition/surprise.js, for-pan.js): worked out after the turn, so nothing PAN says waits on them.
            const sincePan = Number.isFinite(req.body.since_pan_ms) ? req.body.since_pan_ms : null;
            Promise.all([import('../intuition/turn-book.js'), import('../intuition/surprise.js'), import('../intuition/for-pan.js')])
              .then(async ([{ noteTurn }, { lineSurprise }, { forPan, FOR_PAN_V, forPanV2 }]) => {
                const full = await lineSurprise(convoHistory, text).catch(() => null);
                const pFor = forPan({ pPan: r.p_pan, pRoom: r.p_room, sincePanMs: sincePan, surprise: full });
                const pFor2 = forPanV2({ pPan: r.p_pan, pRoom: r.p_room, sincePanMs: sincePan, surprise: full });
                const { mid, ...surprise } = full || {};   // the 576 number reading is not kept
                noteTurn({
                  orgId: req.org_id || 'org_personal', text, history: convoHistory, lang: heardLang,
                  seen: { place: r.participation || null, since_pan_ms: sincePan,
                    voice: voiceWho?.verdict === true ? 'his' : voiceWho?.verdict === false ? 'other' : null,
                    likeness: voiceWho?.likeness ?? null, p_pan: r.p_pan ?? null, p_room: r.p_room ?? null, named_other: r.reason === 'named_other', device: realId || null,
                    surprise: full ? surprise : null, p_for_pan: pFor, for_pan_v: pFor == null ? null : FOR_PAN_V, p_for_pan2: pFor2 },
                  did: { spoke: !['ambient', 'cancelled'].includes(r.intent) && !!said && said.toUpperCase() !== '[AMBIENT]',
                    reason: r.reason || null, held: !!r.hold_ms, response: said.slice(0, 300) },
                });
              }).catch(() => {});
          }
          // Not from a test bench device (setting voice_test_devices, default the OnePlus Pad):
          // its speaker tests taught his voice profile other voices (Nov 15).
          if (voicePrintNow && !voiceTestDevice(realId)) {
            const r = event.result || {};
            try { voice.learnWearer(voicePrintNow, text, r.intent !== 'ambient' && !!String(r.response || '').trim()); } catch {}
          }
          break;
        }
      }
    };
    // bench: the phone is playing recorded test speech (evals/voicebench). Same loop,
    // nothing persisted.
    if (bench) await benchContext.run({ bench: true }, runTurn);
    else await runTurn();
  } catch (err) {
    // An abort is not a failure: it means a newer utterance superseded this
    // turn. Saying "Something went wrong" there would speak an error at the
    // user for doing the normal thing of talking again.
    if (controller.signal.aborted) {
      console.log('[query/stream] turn aborted (superseded or client gone)');
      send({ type: 'done', result: { intent: 'cancelled', response: '' } });
    } else {
      console.error('[query/stream]', err.message);
      send({ type: 'chunk', text: 'Something went wrong.' });
      send({ type: 'done', result: { intent: 'query', response: 'Something went wrong.' } });
    }
  } finally {
    clearInterval(keepaliveInterval);
    // Only clear if this request still owns the slot. A newer turn may have
    // already replaced it, and deleting blindly would unregister THAT one,
    // making the next utterance unable to cancel it.
    if (streamControllers.get(streamKey)?.controller === controller) clearStream(streamKey);
    recordTiming({ turn: turnId, stage: 'total', ms: Date.now() - turnStart, bench: !!bench || undefined });
  }

  if (!res.writableEnded) res.end();
});

// Devices whose turns never teach his voice profile: test benches that play other voices.
function voiceTestDevice(id) {
  if (!id) return false;
  let list = 'opd2403';
  try { list = String(get("SELECT value FROM settings WHERE key = 'voice_test_devices'")?.value || list).replace(/^"|"$/g, ''); } catch {}
  return list.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).includes(String(id).toLowerCase());
}

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
    // The words go in `data`: events has no transcript/response columns, so every turn the
    // phone sent failed with "no such column: transcript" and nothing survived an app
    // restart (audit, 2026-11-03).
    insertScoped(req, `INSERT INTO events (event_type, session_id, data, created_at, org_id)
      VALUES ('conversation_turn', :session_id, :data, datetime('now','localtime'), :org_id)`, {
      ':session_id': device_id || 'phone',
      ':data': JSON.stringify({ role, device_id, text: String(text).slice(0, 2000) }),
      ':org_id': req.org_id || 'org_personal',
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
      SELECT data, created_at FROM events
      WHERE event_type = 'conversation_turn'
        AND session_id = :session_id
        AND org_id = :org_id
        AND created_at > datetime('now', 'localtime', '-30 minutes')
      ORDER BY created_at DESC
      LIMIT :limit
    `, { ':session_id': session_id, ':org_id': req.org_id || 'org_personal', ':limit': parseInt(limit) });

    const turns = rows.reverse().flatMap(r => {
      let d = null;
      try { d = JSON.parse(r.data); } catch {}
      return d?.text && (d.role === 'user' || d.role === 'assistant')
        ? [{ role: d.role, text: d.text, created_at: r.created_at }] : [];
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
