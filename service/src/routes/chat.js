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

    -- Add message_type and channel columns (safe to re-run)
  `);

  // Migration: add message_type and channel columns if missing
  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN message_type TEXT DEFAULT 'quick'`);  // quick | composed
  } catch {}
  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN channel TEXT DEFAULT 'pan'`);          // pan | email | slack | discord | telegram | whatsapp | sms
  } catch {}
  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN subject TEXT`);                        // subject line for composed messages
  } catch {}
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_type ON chat_messages(message_type)`);
  } catch {}

  db.exec(`

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

    -- WebRTC call signaling (poll-based)
    CREATE TABLE IF NOT EXISTS chat_call_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT NOT NULL REFERENCES chat_calls(id) ON DELETE CASCADE,
      sender TEXT NOT NULL,                             -- 'initiator' or 'responder'
      signal_type TEXT NOT NULL,                        -- 'offer', 'answer', 'ice-candidate'
      signal_data TEXT NOT NULL,                        -- JSON: SDP or ICE candidate
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      consumed INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_call_signals_call ON chat_call_signals(call_id, consumed);
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

  res.json({ call_id: id });
});

// WebRTC signaling — exchange SDP offers/answers and ICE candidates
router.post('/calls/:callId/signal', (req, res) => {
  const { signal_type, signal_data, sender } = req.body;
  // signal_type: 'offer', 'answer', 'ice-candidate'
  // signal_data: SDP or ICE candidate object
  // sender: 'initiator' or 'responder'

  if (!signal_type || !signal_data) {
    return res.status(400).json({ error: 'signal_type and signal_data required' });
  }

  const call = db.prepare('SELECT * FROM chat_calls WHERE id = ?').get(req.params.callId);
  if (!call) return res.status(404).json({ error: 'Call not found' });

  db.prepare(`
    INSERT INTO chat_call_signals (call_id, sender, signal_type, signal_data, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.params.callId, sender || 'initiator', signal_type, JSON.stringify(signal_data), Date.now());

  // If answer received, mark call as active
  if (signal_type === 'answer' && call.status === 'ringing') {
    db.prepare('UPDATE chat_calls SET status = ?, answered_at = ? WHERE id = ?')
      .run('active', Date.now(), req.params.callId);
  }

  res.json({ ok: true });
});

// Poll for signals addressed to you (the other party sent these)
router.get('/calls/:callId/signals', (req, res) => {
  const { role } = req.query; // 'initiator' or 'responder' — fetch signals NOT from this role
  const otherRole = role === 'initiator' ? 'responder' : 'initiator';
  const sinceId = parseInt(req.query.since_id) || 0;

  const signals = db.prepare(`
    SELECT id, signal_type, signal_data, created_at
    FROM chat_call_signals
    WHERE call_id = ? AND sender = ? AND id > ?
    ORDER BY id ASC
  `).all(req.params.callId, otherRole, sinceId);

  const parsed = signals.map(s => ({
    ...s,
    signal_data: JSON.parse(s.signal_data)
  }));

  res.json(parsed);
});

// Incoming calls (status=ringing, not initiated by self)
// Must be defined BEFORE /:callId to avoid Express matching 'incoming' as a callId param
router.get('/calls/incoming', (req, res) => {
  const calls = db.prepare(`
    SELECT c.*,
      (SELECT display_name FROM contacts WHERE id = (SELECT contact_id FROM chat_thread_members WHERE thread_id = c.thread_id LIMIT 1)) as contact_name
    FROM chat_calls c
    WHERE c.status = 'ringing' AND c.initiator != 'self'
    ORDER BY c.started_at DESC
  `).all();
  res.json(calls);
});

// Get call status
router.get('/calls/:callId', (req, res) => {
  const call = db.prepare('SELECT * FROM chat_calls WHERE id = ?').get(req.params.callId);
  if (!call) return res.status(404).json({ error: 'Call not found' });
  res.json(call);
});

// Answer a call (responder accepts)
router.post('/calls/:callId/answer', (req, res) => {
  const call = db.prepare('SELECT * FROM chat_calls WHERE id = ?').get(req.params.callId);
  if (!call) return res.status(404).json({ error: 'Call not found' });
  if (call.status !== 'ringing') return res.status(400).json({ error: 'Call is not ringing' });

  db.prepare('UPDATE chat_calls SET status = ?, answered_at = ? WHERE id = ?')
    .run('active', Date.now(), req.params.callId);
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

// ─── Inbox / Outbox ───

// Inbox: recent incoming messages (sender_id != 'self')
router.get('/inbox', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const messages = db.prepare(`
    SELECT m.id, m.thread_id, m.sender_id, m.body, m.body_type, m.read_at, m.created_at,
      c.display_name as sender_name, c.avatar_url as sender_avatar
    FROM chat_messages m
    LEFT JOIN contacts c ON c.id = m.sender_id
    WHERE m.sender_id != 'self' AND m.body_type = 'text'
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json(messages.map(m => ({
    ...m,
    body_preview: m.body && m.body.length > 100 ? m.body.substring(0, 100) + '...' : m.body
  })));
});

// Outbox: recent outgoing messages (sender_id = 'self')
router.get('/outbox', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const messages = db.prepare(`
    SELECT m.id, m.thread_id, m.sender_id, m.body, m.body_type, m.read_at, m.created_at,
      (SELECT c.display_name FROM chat_thread_members tm
       JOIN contacts c ON c.id = tm.contact_id
       WHERE tm.thread_id = m.thread_id LIMIT 1) as recipient_name,
      (SELECT c.avatar_url FROM chat_thread_members tm
       JOIN contacts c ON c.id = tm.contact_id
       WHERE tm.thread_id = m.thread_id LIMIT 1) as recipient_avatar
    FROM chat_messages m
    WHERE m.sender_id = 'self' AND m.body_type = 'text'
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json(messages.map(m => ({
    ...m,
    body_preview: m.body && m.body.length > 100 ? m.body.substring(0, 100) + '...' : m.body
  })));
});

// ─── Unified Inbox — merged PAN messages + emails ───

router.get('/unified-inbox', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const filter = req.query.filter || 'all'; // 'all' | 'pan' | 'email'

  const items = [];

  // PAN messages (incoming, sender != self)
  if (filter === 'all' || filter === 'pan') {
    const panMsgs = db.prepare(`
      SELECT m.id, m.thread_id, m.sender_id, m.body, m.body_type, m.read_at, m.created_at,
        c.display_name as from_name, c.avatar_url as from_avatar
      FROM chat_messages m
      LEFT JOIN contacts c ON c.id = m.sender_id
      WHERE m.sender_id != 'self' AND m.body_type = 'text'
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(limit * 2); // fetch extra so we have enough after merging

    for (const m of panMsgs) {
      items.push({
        type: 'pan',
        id: m.id,
        from_name: m.from_name || 'Unknown',
        from_address: null,
        subject: null,
        body_preview: m.body && m.body.length > 100 ? m.body.substring(0, 100) + '...' : (m.body || ''),
        created_at: m.created_at,
        date: m.created_at,
        read: !!m.read_at,
        thread_id: m.thread_id,
        message_id: null,
        sender_id: m.sender_id,
      });
    }
  }

  // Emails from local cache
  if (filter === 'all' || filter === 'email') {
    try {
      const emails = db.prepare(`
        SELECT id, message_id, from_address, from_name, subject, body_text, date, read
        FROM emails
        WHERE folder = 'INBOX'
        ORDER BY date DESC
        LIMIT ?
      `).all(limit * 2);

      for (const e of emails) {
        const bodyText = e.body_text || e.subject || '';
        items.push({
          type: 'email',
          id: 'email_' + e.id,
          from_name: e.from_name || e.from_address || 'Unknown',
          from_address: e.from_address,
          subject: e.subject || '(no subject)',
          body_preview: bodyText.length > 100 ? bodyText.substring(0, 100) + '...' : bodyText,
          created_at: e.date,
          date: e.date,
          read: !!e.read,
          thread_id: null,
          message_id: e.message_id,
          email_db_id: e.id,
        });
      }
    } catch {
      // emails table may not exist if email not set up — that's fine
    }
  }

  // Sort by date DESC, interleaved
  items.sort((a, b) => (b.date || 0) - (a.date || 0));

  // Apply offset + limit
  const paged = items.slice(offset, offset + limit);
  res.json(paged);
});

// ─── Contact search (for unified compose autocomplete) ───

router.get('/contact-search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);

  const contacts = db.prepare(`
    SELECT id, display_name, email, phone, avatar_url
    FROM contacts
    WHERE blocked = 0 AND (
      LOWER(display_name) LIKE ? OR
      LOWER(email) LIKE ?
    )
    ORDER BY display_name ASC
    LIMIT 10
  `).all(`%${q}%`, `%${q}%`);

  res.json(contacts);
});

// Unread count across all threads
router.get('/unread', (req, res) => {
  
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM chat_messages WHERE read_at IS NULL AND sender_id != 'self'
  `).get();
  res.json({ unread: result.count });
});

// ─── Compose: unified send for composed messages ───

router.post('/compose', async (req, res) => {
  const { to_contact_id, to_address, channel, subject, body } = req.body;
  if (!body && !subject) return res.status(400).json({ error: 'body or subject required' });
  if (!channel) return res.status(400).json({ error: 'channel required (pan, email, sms, etc.)' });

  const now = Date.now();
  const msgId = 'cmsg_' + crypto.randomBytes(8).toString('hex');

  try {
    if (channel === 'email') {
      // Send via SMTP
      const emailTo = to_address || (() => {
        if (!to_contact_id) return null;
        const c = db.prepare('SELECT email FROM contacts WHERE id = ?').get(to_contact_id);
        return c?.email;
      })();
      if (!emailTo) return res.status(400).json({ error: 'No email address for this contact' });

      // Check email is configured before attempting send
      const { sendEmail, getEmailSettings } = await import('../email.js');
      const emailSettings = getEmailSettings();
      if (!emailSettings.email_smtp_host || !emailSettings.email_user || !emailSettings.email_password) {
        return res.status(400).json({ error: 'Email not configured — go to Settings to set up SMTP' });
      }
      await sendEmail({ to: emailTo, subject: subject || '(no subject)', body: body || '' });

      // Also store in chat_messages as composed for the unified inbox
      let threadId = null;
      if (to_contact_id) {
        const existing = db.prepare(`
          SELECT t.id FROM chat_threads t
          JOIN chat_thread_members m ON m.thread_id = t.id
          WHERE t.type = 'dm' AND m.contact_id = ?
        `).get(to_contact_id);
        threadId = existing?.id;
        if (!threadId) {
          threadId = 'thread_' + crypto.randomBytes(8).toString('hex');
          db.prepare('INSERT INTO chat_threads (id, type) VALUES (?, ?)').run(threadId, 'dm');
          db.prepare('INSERT INTO chat_thread_members (thread_id, contact_id) VALUES (?, ?)').run(threadId, to_contact_id);
        }
      }
      if (threadId) {
        db.prepare(`
          INSERT INTO chat_messages (id, thread_id, sender_id, body, body_type, message_type, channel, subject, created_at)
          VALUES (?, ?, 'self', ?, 'text', 'composed', 'email', ?, ?)
        `).run(msgId, threadId, body || '', subject || null, now);
      }

      res.json({ ok: true, id: msgId, channel: 'email', to: emailTo });

    } else if (channel === 'pan') {
      // Send via PAN Hub relay
      if (!to_contact_id) return res.status(400).json({ error: 'Contact required for PAN messages' });

      // Find or create thread
      const existing = db.prepare(`
        SELECT t.id FROM chat_threads t
        JOIN chat_thread_members m ON m.thread_id = t.id
        WHERE t.type = 'dm' AND m.contact_id = ?
      `).get(to_contact_id);
      let threadId = existing?.id;
      if (!threadId) {
        threadId = 'thread_' + crypto.randomBytes(8).toString('hex');
        db.prepare('INSERT INTO chat_threads (id, type) VALUES (?, ?)').run(threadId, 'dm');
        db.prepare('INSERT INTO chat_thread_members (thread_id, contact_id) VALUES (?, ?)').run(threadId, to_contact_id);
      }

      const composedBody = subject ? `**${subject}**\n\n${body || ''}` : (body || '');
      db.prepare(`
        INSERT INTO chat_messages (id, thread_id, sender_id, body, body_type, message_type, channel, subject, created_at)
        VALUES (?, ?, 'self', ?, 'text', 'composed', 'pan', ?, ?)
      `).run(msgId, threadId, composedBody, subject || null, now);
      db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(now, threadId);

      // TODO: Relay to recipient's PAN instance via Hub

      res.json({ ok: true, id: msgId, channel: 'pan', thread_id: threadId });

    } else {
      // Other channels (slack, discord, telegram, whatsapp, sms) — store + return deep link
      // These get sent via webview wrapping, so we just store the intent
      let threadId = null;
      if (to_contact_id) {
        const existing = db.prepare(`
          SELECT t.id FROM chat_threads t
          JOIN chat_thread_members m ON m.thread_id = t.id
          WHERE t.type = 'dm' AND m.contact_id = ?
        `).get(to_contact_id);
        threadId = existing?.id;
      }
      if (threadId) {
        db.prepare(`
          INSERT INTO chat_messages (id, thread_id, sender_id, body, body_type, message_type, channel, subject, created_at)
          VALUES (?, ?, 'self', ?, 'text', 'composed', ?, ?, ?)
        `).run(msgId, threadId, body || '', channel, subject || null, now);
      }

      res.json({ ok: true, id: msgId, channel, note: 'Message stored — deliver via webview' });
    }
  } catch (e) {
    console.error('[PAN] Compose send error:', e);
    res.status(500).json({ error: e.message || 'Send failed' });
  }
});

// Get available channels for a contact
router.get('/contact-channels/:contactId', (req, res) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.contactId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const channels = [];
  if (contact.pan_instance_id) channels.push({ id: 'pan', label: 'PAN', icon: '◆' });
  if (contact.email) channels.push({ id: 'email', label: 'Email', icon: '✉', address: contact.email });
  if (contact.phone) channels.push({ id: 'sms', label: 'SMS', icon: '💬', address: contact.phone });
  // Future: check connected apps for slack/discord/etc.

  res.json({ contact_id: contact.id, display_name: contact.display_name, channels });
});

// ─── Mail inbox (composed messages + received emails) ───

router.get('/mail', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const filter = req.query.filter || 'all'; // 'all' | 'pan' | 'email'

  // Composed messages from chat_messages
  let composed = [];
  if (filter === 'all' || filter === 'pan') {
    composed = db.prepare(`
      SELECT cm.id, cm.thread_id, cm.sender_id, cm.body, cm.subject, cm.channel, cm.created_at,
             c.display_name as contact_name, c.email as contact_email
      FROM chat_messages cm
      LEFT JOIN chat_thread_members tm ON tm.thread_id = cm.thread_id
      LEFT JOIN contacts c ON c.id = tm.contact_id
      WHERE cm.message_type = 'composed'
      ${filter === 'pan' ? "AND cm.channel = 'pan'" : ''}
      ORDER BY cm.created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  // Also pull from emails table (IMAP-synced)
  let emails = [];
  if (filter === 'all' || filter === 'email') {
    try {
      emails = db.prepare(`
        SELECT id, message_id, from_address, from_name, to_address, subject, body_text, date, read, starred
        FROM emails
        ORDER BY date DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset);
    } catch {
      // emails table might not exist yet
    }
  }

  // Also include email-channel composed messages
  let composedEmails = [];
  if (filter === 'all' || filter === 'email') {
    try {
      composedEmails = db.prepare(`
        SELECT cm.id, cm.thread_id, cm.sender_id, cm.body, cm.subject, cm.channel, cm.created_at,
               c.display_name as contact_name, c.email as contact_email
        FROM chat_messages cm
        LEFT JOIN chat_thread_members tm ON tm.thread_id = cm.thread_id
        LEFT JOIN contacts c ON c.id = tm.contact_id
        WHERE cm.message_type = 'composed' AND cm.channel = 'email'
        ORDER BY cm.created_at DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset);
    } catch {}
  }

  // Merge + sort by date, dedup composed emails
  const composedIds = new Set(composed.map(m => m.id));
  const allComposed = [...composed, ...composedEmails.filter(m => !composedIds.has(m.id))];

  const merged = [
    ...allComposed.map(m => ({
      id: m.id,
      type: m.channel === 'email' ? 'email' : 'pan',
      direction: m.sender_id === 'self' ? 'sent' : 'received',
      from: m.sender_id === 'self' ? 'You' : (m.contact_name || 'Unknown'),
      to: m.sender_id === 'self' ? (m.contact_name || m.contact_email || 'Unknown') : 'You',
      subject: m.subject || null,
      preview: (m.body || '').replace(/\*\*/g, '').slice(0, 120),
      channel: m.channel,
      date: m.created_at,
      read: true,
      sender_id: m.sender_id,
      sender_name: m.contact_name,
    })),
    ...emails.map(e => ({
      id: `email_${e.id}`,
      email_db_id: e.id,
      type: 'email',
      direction: 'received',
      from: e.from_name || e.from_address || 'Unknown',
      from_name: e.from_name,
      from_address: e.from_address,
      to: e.to_address || 'You',
      subject: e.subject || null,
      preview: (e.body_text || '').slice(0, 120),
      channel: 'email',
      date: e.date,
      read: !!e.read,
      message_id: e.message_id,
    }))
  ].sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, limit);

  const totalComposed = db.prepare(`SELECT COUNT(*) as count FROM chat_messages WHERE message_type = 'composed'`).get().count;
  let totalEmails = 0;
  try { totalEmails = db.prepare('SELECT COUNT(*) as count FROM emails').get().count; } catch {}

  res.json({ messages: merged, total: totalComposed + totalEmails });
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
