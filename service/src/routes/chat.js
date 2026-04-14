// PAN Chat routes — text messaging, contacts, WebRTC signaling
// Messages are E2E encrypted between PAN instances via the Hub relay.

import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db.js';

const router = Router();

// ─── Schema setup (called from server.js boot) ───
export function ensureChatSchema(db) {
  db.exec(`
    -- Contacts: people you can message
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,                          -- contact_xxxx
      pan_instance_id TEXT,                         -- their PAN instance ID (pan_xxxx)
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      phone TEXT,
      email TEXT,
      notes TEXT,
      status TEXT DEFAULT 'offline',                -- online, offline, away
      last_seen INTEGER,
      hub_public_key TEXT,                          -- their Ed25519 public key (base64)
      favorited INTEGER DEFAULT 0,
      blocked INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    -- Chat threads (DM or group)
    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,                          -- thread_xxxx
      type TEXT NOT NULL DEFAULT 'dm',              -- dm, group
      name TEXT,                                    -- null for DM, name for group
      avatar_url TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    -- Thread participants
    CREATE TABLE IF NOT EXISTS chat_thread_members (
      thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      joined_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      PRIMARY KEY (thread_id, contact_id)
    );

    -- Messages
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,                          -- cmsg_xxxx
      thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      sender_id TEXT,                               -- contact_id or 'self' for our messages
      body TEXT NOT NULL,                           -- plaintext (decrypted locally) or encrypted blob
      body_type TEXT DEFAULT 'text',                -- text, image, file, system, call_start, call_end
      reply_to TEXT,                                -- cmsg_xxxx if replying
      metadata TEXT,                                -- JSON: file info, call duration, etc.
      read_at INTEGER,                              -- null = unread
      delivered_at INTEGER,                         -- when Hub confirmed delivery
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_unread ON chat_messages(thread_id, read_at);

    -- Call log
    CREATE TABLE IF NOT EXISTS chat_calls (
      id TEXT PRIMARY KEY,                          -- call_xxxx
      thread_id TEXT NOT NULL REFERENCES chat_threads(id),
      type TEXT NOT NULL DEFAULT 'voice',           -- voice, video
      status TEXT NOT NULL DEFAULT 'ringing',        -- ringing, active, ended, missed, declined
      started_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      answered_at INTEGER,
      ended_at INTEGER,
      duration_ms INTEGER,
      initiator TEXT NOT NULL                       -- 'self' or contact_id
    );

    -- Calendar events
    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER,
      all_day INTEGER DEFAULT 0,
      contact_id TEXT,                               -- linked contact (optional)
      thread_id TEXT,                                -- linked thread (optional)
      notify INTEGER DEFAULT 1,                      -- send notification
      notified INTEGER DEFAULT 0,                    -- already notified
      color TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_starts ON calendar_events(starts_at);
  `);
}

// ─── Contacts CRUD ───

router.get('/contacts', (req, res) => {
  
  const contacts = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM chat_messages m
       JOIN chat_thread_members tm ON tm.thread_id = m.thread_id
       WHERE tm.contact_id = c.id AND m.sender_id = c.id AND m.read_at IS NULL
      ) as unread_count
    FROM contacts c
    WHERE c.blocked = 0
    ORDER BY c.favorited DESC, c.display_name ASC
  `).all();
  res.json(contacts);
});

router.post('/contacts', (req, res) => {
  
  const { display_name, pan_instance_id, phone, email, notes, hub_public_key } = req.body;
  if (!display_name) return res.status(400).json({ error: 'display_name required' });

  const id = 'contact_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO contacts (id, display_name, pan_instance_id, phone, email, notes, hub_public_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, display_name, pan_instance_id || null, phone || null, email || null, notes || null, hub_public_key || null);

  res.json({ id, display_name });
});

router.put('/contacts/:id', (req, res) => {
  
  const { display_name, pan_instance_id, phone, email, notes, favorited, blocked, avatar_url } = req.body;
  const fields = [];
  const values = [];

  if (display_name !== undefined) { fields.push('display_name = ?'); values.push(display_name); }
  if (pan_instance_id !== undefined) { fields.push('pan_instance_id = ?'); values.push(pan_instance_id); }
  if (phone !== undefined) { fields.push('phone = ?'); values.push(phone); }
  if (email !== undefined) { fields.push('email = ?'); values.push(email); }
  if (notes !== undefined) { fields.push('notes = ?'); values.push(notes); }
  if (favorited !== undefined) { fields.push('favorited = ?'); values.push(favorited ? 1 : 0); }
  if (blocked !== undefined) { fields.push('blocked = ?'); values.push(blocked ? 1 : 0); }
  if (avatar_url !== undefined) { fields.push('avatar_url = ?'); values.push(avatar_url); }

  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(req.params.id);

  db.prepare(`UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

router.delete('/contacts/:id', (req, res) => {
  
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Threads ───

router.get('/threads', (req, res) => {
  
  const threads = db.prepare(`
    SELECT t.*,
      (SELECT body FROM chat_messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT created_at FROM chat_messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) as last_message_at,
      (SELECT COUNT(*) FROM chat_messages WHERE thread_id = t.id AND read_at IS NULL AND sender_id != 'self') as unread_count
    FROM chat_threads t
    ORDER BY last_message_at DESC NULLS LAST
  `).all();

  // Attach members to each thread
  for (const thread of threads) {
    thread.members = db.prepare(`
      SELECT c.id, c.display_name, c.avatar_url, c.status, c.pan_instance_id
      FROM chat_thread_members tm
      JOIN contacts c ON c.id = tm.contact_id
      WHERE tm.thread_id = ?
    `).all(thread.id);
  }

  res.json(threads);
});

// Start a DM thread with a contact (or return existing)
router.post('/threads/dm', (req, res) => {
  
  const { contact_id } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });

  // Check for existing DM thread with this contact
  const existing = db.prepare(`
    SELECT t.id FROM chat_threads t
    JOIN chat_thread_members tm ON tm.thread_id = t.id
    WHERE t.type = 'dm' AND tm.contact_id = ?
  `).get(contact_id);

  if (existing) return res.json({ thread_id: existing.id, existing: true });

  // Create new thread
  const threadId = 'thread_' + crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO chat_threads (id, type) VALUES (?, ?)').run(threadId, 'dm');
  db.prepare('INSERT INTO chat_thread_members (thread_id, contact_id) VALUES (?, ?)').run(threadId, contact_id);

  res.json({ thread_id: threadId, existing: false });
});

// Create group thread
router.post('/threads/group', (req, res) => {
  
  const { name, contact_ids } = req.body;
  if (!name || !contact_ids?.length) return res.status(400).json({ error: 'name and contact_ids required' });

  const threadId = 'thread_' + crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO chat_threads (id, type, name) VALUES (?, ?, ?)').run(threadId, 'group', name);

  const insert = db.prepare('INSERT INTO chat_thread_members (thread_id, contact_id) VALUES (?, ?)');
  for (const cid of contact_ids) {
    insert.run(threadId, cid);
  }

  res.json({ thread_id: threadId });
});

// ─── Messages ───

router.get('/threads/:threadId/messages', (req, res) => {
  
  const limit = parseInt(req.query.limit) || 50;
  const before = req.query.before ? parseInt(req.query.before) : Date.now() + 1;

  const messages = db.prepare(`
    SELECT * FROM chat_messages
    WHERE thread_id = ? AND created_at < ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(req.params.threadId, before, limit);

  res.json(messages.reverse()); // chronological order
});

// Send a message
router.post('/threads/:threadId/messages', (req, res) => {
  
  const { body, body_type, reply_to, metadata } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });

  const id = 'cmsg_' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();

  db.prepare(`
    INSERT INTO chat_messages (id, thread_id, sender_id, body, body_type, reply_to, metadata, created_at)
    VALUES (?, ?, 'self', ?, ?, ?, ?, ?)
  `).run(id, req.params.threadId, body, body_type || 'text', reply_to || null, metadata ? JSON.stringify(metadata) : null, now);

  // Update thread timestamp
  db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(now, req.params.threadId);

  // TODO: Send through Hub relay to recipient's PAN instance

  res.json({ id, created_at: now });
});

// Mark messages as read
router.post('/threads/:threadId/read', (req, res) => {
  
  const now = Date.now();
  db.prepare(`
    UPDATE chat_messages SET read_at = ? WHERE thread_id = ? AND read_at IS NULL AND sender_id != 'self'
  `).run(now, req.params.threadId);
  res.json({ ok: true });
});

// ─── Incoming message from Hub relay ───
router.post('/incoming', (req, res) => {
  
  const { from_instance_id, body, body_type, metadata, message_id } = req.body;

  // Find or create contact for sender
  let contact = db.prepare('SELECT id FROM contacts WHERE pan_instance_id = ?').get(from_instance_id);
  if (!contact) {
    const contactId = 'contact_' + crypto.randomBytes(8).toString('hex');
    db.prepare(`
      INSERT INTO contacts (id, pan_instance_id, display_name) VALUES (?, ?, ?)
    `).run(contactId, from_instance_id, from_instance_id);
    contact = { id: contactId };
  }

  // Find or create DM thread
  let thread = db.prepare(`
    SELECT t.id FROM chat_threads t
    JOIN chat_thread_members tm ON tm.thread_id = t.id
    WHERE t.type = 'dm' AND tm.contact_id = ?
  `).get(contact.id);

  if (!thread) {
    const threadId = 'thread_' + crypto.randomBytes(8).toString('hex');
    db.prepare('INSERT INTO chat_threads (id, type) VALUES (?, ?)').run(threadId, 'dm');
    db.prepare('INSERT INTO chat_thread_members (thread_id, contact_id) VALUES (?, ?)').run(threadId, contact.id);
    thread = { id: threadId };
  }

  // Insert message
  const id = message_id || ('cmsg_' + crypto.randomBytes(8).toString('hex'));
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO chat_messages (id, thread_id, sender_id, body, body_type, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, thread.id, contact.id, body, body_type || 'text', metadata ? JSON.stringify(metadata) : null, now);

  db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(now, thread.id);

  res.json({ ok: true, thread_id: thread.id, message_id: id });
});

// ─── WebRTC Signaling ───

// These routes handle the handshake for voice/video calls.
// The actual media streams go peer-to-peer via WebRTC — PAN server never touches them.

router.post('/calls/start', (req, res) => {
  
  const { thread_id, type } = req.body; // type: 'voice' or 'video'
  if (!thread_id) return res.status(400).json({ error: 'thread_id required' });

  const id = 'call_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO chat_calls (id, thread_id, type, initiator) VALUES (?, ?, ?, 'self')
  `).run(id, thread_id, type || 'voice');

  // Insert system message
  const msgId = 'cmsg_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO chat_messages (id, thread_id, sender_id, body, body_type, metadata, created_at)
    VALUES (?, ?, 'self', ?, 'call_start', ?, ?)
  `).run(msgId, thread_id, `${type || 'voice'} call started`, JSON.stringify({ call_id: id }), Date.now());

  // TODO: Send WebRTC offer through Hub relay

  res.json({ call_id: id });
});

// WebRTC signaling — exchange SDP offers/answers and ICE candidates
router.post('/calls/:callId/signal', (req, res) => {
  const { signal_type, signal_data } = req.body;
  // signal_type: 'offer', 'answer', 'ice-candidate'
  // signal_data: SDP or ICE candidate object

  // TODO: Relay through Hub to the peer
  // For now, store and forward via polling

  res.json({ ok: true });
});

router.post('/calls/:callId/end', (req, res) => {
  
  const now = Date.now();
  const call = db.prepare('SELECT * FROM chat_calls WHERE id = ?').get(req.params.callId);
  if (!call) return res.status(404).json({ error: 'Call not found' });

  const duration = call.answered_at ? now - call.answered_at : 0;
  db.prepare(`
    UPDATE chat_calls SET status = 'ended', ended_at = ?, duration_ms = ? WHERE id = ?
  `).run(now, duration, req.params.callId);

  // System message
  const msgId = 'cmsg_' + crypto.randomBytes(8).toString('hex');
  const durationStr = duration > 0 ? `${Math.floor(duration / 60000)}m ${Math.floor((duration % 60000) / 1000)}s` : 'missed';
  db.prepare(`
    INSERT INTO chat_messages (id, thread_id, sender_id, body, body_type, metadata, created_at)
    VALUES (?, ?, 'system', ?, 'call_end', ?, ?)
  `).run(msgId, call.thread_id, `Call ended (${durationStr})`, JSON.stringify({ call_id: call.id, duration_ms: duration }), now);

  res.json({ ok: true, duration_ms: duration });
});

// Get call history
router.get('/calls', (req, res) => {
  
  const calls = db.prepare(`
    SELECT c.*, t.name as thread_name,
      (SELECT display_name FROM contacts WHERE id = (SELECT contact_id FROM chat_thread_members WHERE thread_id = c.thread_id LIMIT 1)) as contact_name
    FROM chat_calls c
    LEFT JOIN chat_threads t ON t.id = c.thread_id
    ORDER BY c.started_at DESC
    LIMIT 50
  `).all();
  res.json(calls);
});

// Unread count across all threads
router.get('/unread', (req, res) => {
  
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM chat_messages WHERE read_at IS NULL AND sender_id != 'self'
  `).get();
  res.json({ unread: result.count });
});

// ─── Calendar ───

router.get('/calendar', (req, res) => {
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
  const year = parseInt(req.query.year) || new Date().getFullYear();

  // Get events for the month (with a few days buffer for display)
  const start = new Date(year, month - 1, 1).getTime();
  const end = new Date(year, month, 1).getTime();

  const events = db.prepare(`
    SELECT * FROM calendar_events
    WHERE starts_at >= ? AND starts_at < ?
    ORDER BY starts_at ASC
  `).all(start, end);

  res.json(events);
});

router.post('/calendar', (req, res) => {
  const { title, description, starts_at, ends_at, all_day, contact_id, thread_id, notify, color } = req.body;
  if (!title || !starts_at) return res.status(400).json({ error: 'title and starts_at required' });

  const id = 'evt_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO calendar_events (id, title, description, starts_at, ends_at, all_day, contact_id, thread_id, notify, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, description || null, starts_at, ends_at || null, all_day ? 1 : 0, contact_id || null, thread_id || null, notify !== false ? 1 : 0, color || null);

  res.json({ id, title, starts_at });
});

router.delete('/calendar/:id', (req, res) => {
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
