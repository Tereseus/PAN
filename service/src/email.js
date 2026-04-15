// PAN Email — universal IMAP/SMTP integration
// Works with Gmail, Outlook, and any standard email provider.
// Uses imapflow for IMAP and nodemailer for SMTP.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let ImapFlow, nodemailer;
try { ({ ImapFlow } = require('imapflow')); } catch { ImapFlow = null; }
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }

import { db, get, all, run } from './db.js';

// ─── Provider presets ───
export const PROVIDER_PRESETS = {
  gmail: { imap_host: 'imap.gmail.com', imap_port: 993, smtp_host: 'smtp.gmail.com', smtp_port: 587 },
  outlook: { imap_host: 'outlook.office365.com', imap_port: 993, smtp_host: 'smtp.office365.com', smtp_port: 587 },
};

// ─── State ───
let _imapClient = null;
let _imapConnecting = false;
let _imapError = null;
let _lastImapSettings = null;

// ─── Schema ───
export function initEmail(database) {
  const d = database || db;
  d.exec(`
    CREATE TABLE IF NOT EXISTS emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE,
      folder TEXT NOT NULL DEFAULT 'INBOX',
      from_address TEXT,
      from_name TEXT,
      to_address TEXT,
      subject TEXT,
      body_text TEXT,
      body_html TEXT,
      date INTEGER,
      read INTEGER DEFAULT 0,
      starred INTEGER DEFAULT 0,
      attachments_json TEXT,
      fetched_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder, date DESC);
    CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
  `);
}

// ─── Settings helpers ───
export function getEmailSettings() {
  const keys = ['email_provider', 'email_imap_host', 'email_imap_port', 'email_smtp_host', 'email_smtp_port', 'email_user', 'email_password', 'email_from'];
  const settings = {};
  for (const key of keys) {
    const row = get("SELECT value FROM settings WHERE key = :k", { ':k': key });
    settings[key] = row ? row.value : '';
  }
  return settings;
}

function isConfigured(settings) {
  return settings.email_imap_host && settings.email_user && settings.email_password;
}

// ─── IMAP ───
export async function connectImap(settings) {
  if (!ImapFlow) throw new Error('imapflow not installed — run: npm install imapflow');
  settings = settings || getEmailSettings();
  if (!isConfigured(settings)) throw new Error('Email not configured');

  // Disconnect existing if settings changed
  if (_imapClient) {
    const key = `${settings.email_imap_host}:${settings.email_imap_port}:${settings.email_user}`;
    if (_lastImapSettings !== key) {
      await disconnectImap();
    } else if (_imapClient.usable) {
      return _imapClient;
    }
  }

  if (_imapConnecting) throw new Error('IMAP connection already in progress');

  _imapConnecting = true;
  _imapError = null;
  try {
    const client = new ImapFlow({
      host: settings.email_imap_host,
      port: parseInt(settings.email_imap_port) || 993,
      secure: (parseInt(settings.email_imap_port) || 993) === 993,
      auth: {
        user: settings.email_user,
        pass: settings.email_password,
      },
      logger: false,
    });

    await client.connect();
    _imapClient = client;
    _lastImapSettings = `${settings.email_imap_host}:${settings.email_imap_port}:${settings.email_user}`;

    // Handle disconnects
    client.on('close', () => {
      _imapClient = null;
      _lastImapSettings = null;
    });
    client.on('error', (err) => {
      _imapError = err.message;
      console.error('[PAN Email] IMAP error:', err.message);
    });

    return client;
  } catch (err) {
    _imapError = err.message;
    throw err;
  } finally {
    _imapConnecting = false;
  }
}

export async function disconnectImap() {
  if (_imapClient) {
    try { await _imapClient.logout(); } catch {}
    _imapClient = null;
    _lastImapSettings = null;
  }
}

export function getImapStatus() {
  if (_imapConnecting) return { status: 'connecting' };
  if (_imapClient?.usable) return { status: 'connected' };
  if (_imapError) return { status: 'error', error: _imapError };
  return { status: 'disconnected' };
}

// ─── List folders ───
export async function listFolders() {
  const client = await connectImap();
  const folders = await client.list();
  return folders.map(f => ({
    path: f.path,
    name: f.name,
    delimiter: f.delimiter,
    specialUse: f.specialUse || null,
    flags: f.flags ? [...f.flags] : [],
  }));
}

// ─── Fetch recent emails ───
export async function fetchRecent(folder = 'INBOX', limit = 50) {
  const client = await connectImap();
  const emails = [];

  const lock = await client.getMailboxLock(folder);
  try {
    // Fetch the latest N messages by sequence number
    const total = client.mailbox.exists;
    if (total === 0) return [];
    const start = Math.max(1, total - limit + 1);

    for await (const message of client.fetch(`${start}:*`, {
      envelope: true,
      bodyStructure: true,
      source: { maxBytes: 256 * 1024 }, // limit to 256KB per message
      flags: true,
    })) {
      const env = message.envelope;
      const fromAddr = env.from?.[0]?.address || '';
      const fromName = env.from?.[0]?.name || '';
      const toAddr = env.to?.map(t => t.address).join(', ') || '';
      const messageId = env.messageId || `gen-${message.uid}`;
      const date = env.date ? new Date(env.date).getTime() : Date.now();
      const isRead = message.flags?.has('\\Seen') ? 1 : 0;
      const isStarred = message.flags?.has('\\Flagged') ? 1 : 0;

      // Parse body text from source
      let bodyText = '';
      let bodyHtml = '';
      if (message.source) {
        const src = message.source.toString('utf-8');
        // Simple extraction — full MIME parsing is complex; extract text content
        const textMatch = src.match(/Content-Type: text\/plain[^\r\n]*\r?\n(?:Content-Transfer-Encoding:[^\r\n]*\r?\n)?(?:\r?\n)([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i);
        if (textMatch) bodyText = textMatch[1].substring(0, 10000);
        const htmlMatch = src.match(/Content-Type: text\/html[^\r\n]*\r?\n(?:Content-Transfer-Encoding:[^\r\n]*\r?\n)?(?:\r?\n)([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i);
        if (htmlMatch) bodyHtml = htmlMatch[1].substring(0, 50000);
        // If no MIME parts, the whole source might be the body
        if (!bodyText && !bodyHtml && !src.includes('Content-Type: multipart/')) {
          const bodyStart = src.indexOf('\r\n\r\n');
          if (bodyStart > 0) bodyText = src.substring(bodyStart + 4, bodyStart + 10004);
        }
      }

      // Attachments info from bodyStructure
      const attachments = [];
      if (message.bodyStructure?.childNodes) {
        for (const part of message.bodyStructure.childNodes) {
          if (part.disposition === 'attachment' || (part.type && !part.type.startsWith('text/'))) {
            attachments.push({
              filename: part.dispositionParameters?.filename || part.parameters?.name || 'unnamed',
              type: part.type || 'application/octet-stream',
              size: part.size || 0,
            });
          }
        }
      }

      emails.push({
        message_id: messageId,
        folder,
        from_address: fromAddr,
        from_name: fromName,
        to_address: toAddr,
        subject: env.subject || '(no subject)',
        body_text: bodyText,
        body_html: bodyHtml,
        date,
        read: isRead,
        starred: isStarred,
        attachments_json: attachments.length > 0 ? JSON.stringify(attachments) : null,
      });
    }
  } finally {
    lock.release();
  }

  // Upsert into local cache
  const stmt = db.prepare(`
    INSERT INTO emails (message_id, folder, from_address, from_name, to_address, subject, body_text, body_html, date, read, starred, attachments_json, fetched_at)
    VALUES (:message_id, :folder, :from_address, :from_name, :to_address, :subject, :body_text, :body_html, :date, :read, :starred, :attachments_json, :fetched_at)
    ON CONFLICT(message_id) DO UPDATE SET
      read = excluded.read,
      starred = excluded.starred,
      fetched_at = excluded.fetched_at
  `);
  const now = Date.now();
  for (const e of emails) {
    stmt.run({
      ':message_id': e.message_id,
      ':folder': e.folder,
      ':from_address': e.from_address,
      ':from_name': e.from_name,
      ':to_address': e.to_address,
      ':subject': e.subject,
      ':body_text': e.body_text,
      ':body_html': e.body_html,
      ':date': e.date,
      ':read': e.read,
      ':starred': e.starred,
      ':attachments_json': e.attachments_json,
      ':fetched_at': now,
    });
  }

  return emails;
}

// ─── Sync folder (incremental — only new messages since last fetch) ───
export async function syncFolder(folder = 'INBOX') {
  // Find the latest date we have for this folder
  const latest = get("SELECT MAX(date) as max_date FROM emails WHERE folder = :f", { ':f': folder });
  const sinceDate = latest?.max_date ? new Date(latest.max_date) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const client = await connectImap();
  const emails = [];

  const lock = await client.getMailboxLock(folder);
  try {
    // Search for messages since the last known date
    const uids = await client.search({ since: sinceDate }, { uid: true });
    if (!uids || uids.length === 0) return { synced: 0, folder };

    for await (const message of client.fetch(uids, {
      envelope: true,
      bodyStructure: true,
      source: { maxBytes: 256 * 1024 },
      flags: true,
      uid: true,
    })) {
      const env = message.envelope;
      const messageId = env.messageId || `gen-${message.uid}`;

      // Skip if we already have it
      const exists = get("SELECT id FROM emails WHERE message_id = :mid", { ':mid': messageId });
      if (exists) continue;

      const fromAddr = env.from?.[0]?.address || '';
      const fromName = env.from?.[0]?.name || '';
      const toAddr = env.to?.map(t => t.address).join(', ') || '';
      const date = env.date ? new Date(env.date).getTime() : Date.now();
      const isRead = message.flags?.has('\\Seen') ? 1 : 0;
      const isStarred = message.flags?.has('\\Flagged') ? 1 : 0;

      let bodyText = '';
      let bodyHtml = '';
      if (message.source) {
        const src = message.source.toString('utf-8');
        const textMatch = src.match(/Content-Type: text\/plain[^\r\n]*\r?\n(?:Content-Transfer-Encoding:[^\r\n]*\r?\n)?(?:\r?\n)([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i);
        if (textMatch) bodyText = textMatch[1].substring(0, 10000);
        const htmlMatch = src.match(/Content-Type: text\/html[^\r\n]*\r?\n(?:Content-Transfer-Encoding:[^\r\n]*\r?\n)?(?:\r?\n)([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i);
        if (htmlMatch) bodyHtml = htmlMatch[1].substring(0, 50000);
        if (!bodyText && !bodyHtml && !src.includes('Content-Type: multipart/')) {
          const bodyStart = src.indexOf('\r\n\r\n');
          if (bodyStart > 0) bodyText = src.substring(bodyStart + 4, bodyStart + 10004);
        }
      }

      const attachments = [];
      if (message.bodyStructure?.childNodes) {
        for (const part of message.bodyStructure.childNodes) {
          if (part.disposition === 'attachment' || (part.type && !part.type.startsWith('text/'))) {
            attachments.push({
              filename: part.dispositionParameters?.filename || part.parameters?.name || 'unnamed',
              type: part.type || 'application/octet-stream',
              size: part.size || 0,
            });
          }
        }
      }

      emails.push({
        message_id: messageId,
        folder,
        from_address: fromAddr,
        from_name: fromName,
        to_address: toAddr,
        subject: env.subject || '(no subject)',
        body_text: bodyText,
        body_html: bodyHtml,
        date,
        read: isRead,
        starred: isStarred,
        attachments_json: attachments.length > 0 ? JSON.stringify(attachments) : null,
      });
    }
  } finally {
    lock.release();
  }

  // Insert new emails
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO emails (message_id, folder, from_address, from_name, to_address, subject, body_text, body_html, date, read, starred, attachments_json, fetched_at)
    VALUES (:message_id, :folder, :from_address, :from_name, :to_address, :subject, :body_text, :body_html, :date, :read, :starred, :attachments_json, :fetched_at)
  `);
  const now = Date.now();
  for (const e of emails) {
    stmt.run({
      ':message_id': e.message_id,
      ':folder': e.folder,
      ':from_address': e.from_address,
      ':from_name': e.from_name,
      ':to_address': e.to_address,
      ':subject': e.subject,
      ':body_text': e.body_text,
      ':body_html': e.body_html,
      ':date': e.date,
      ':read': e.read,
      ':starred': e.starred,
      ':attachments_json': e.attachments_json,
      ':fetched_at': now,
    });
  }

  return { synced: emails.length, folder };
}

// ─── Send email via SMTP ───
export async function sendEmail({ to, subject, body, html }) {
  if (!nodemailer) throw new Error('nodemailer not installed — run: npm install nodemailer');
  const settings = getEmailSettings();
  if (!settings.email_smtp_host || !settings.email_user || !settings.email_password) {
    throw new Error('SMTP not configured');
  }

  const transporter = nodemailer.createTransport({
    host: settings.email_smtp_host,
    port: parseInt(settings.email_smtp_port) || 587,
    secure: (parseInt(settings.email_smtp_port) || 587) === 465,
    auth: {
      user: settings.email_user,
      pass: settings.email_password,
    },
  });

  const from = settings.email_from || settings.email_user;
  const result = await transporter.sendMail({
    from,
    to,
    subject,
    text: body || '',
    html: html || undefined,
  });

  transporter.close();
  return { messageId: result.messageId, accepted: result.accepted };
}

// ─── Read from local cache ───
export function getEmails(folder = 'INBOX', limit = 50, offset = 0) {
  return all(
    "SELECT * FROM emails WHERE folder = :f ORDER BY date DESC LIMIT :l OFFSET :o",
    { ':f': folder, ':l': limit, ':o': offset }
  );
}

// ─── Mark as read ───
export async function markRead(messageId) {
  run("UPDATE emails SET read = 1 WHERE message_id = :mid", { ':mid': messageId });

  // Also mark on IMAP server if connected
  try {
    const email = get("SELECT folder FROM emails WHERE message_id = :mid", { ':mid': messageId });
    if (email && _imapClient?.usable) {
      const lock = await _imapClient.getMailboxLock(email.folder);
      try {
        // Find UID by message-id header
        const uids = await _imapClient.search({ header: { 'message-id': messageId } }, { uid: true });
        if (uids?.length > 0) {
          await _imapClient.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
        }
      } finally {
        lock.release();
      }
    }
  } catch (err) {
    console.warn('[PAN Email] Failed to mark read on IMAP:', err.message);
  }
}

// ─── Test connection ───
export async function testConnection(settings) {
  if (!ImapFlow) throw new Error('imapflow not installed — run: npm install imapflow');
  const errors = [];

  // Test IMAP
  try {
    const client = new ImapFlow({
      host: settings.email_imap_host,
      port: parseInt(settings.email_imap_port) || 993,
      secure: (parseInt(settings.email_imap_port) || 993) === 993,
      auth: { user: settings.email_user, pass: settings.email_password },
      logger: false,
    });
    await client.connect();
    await client.logout();
  } catch (err) {
    errors.push({ type: 'imap', error: err.message });
  }

  // Test SMTP
  if (nodemailer && settings.email_smtp_host) {
    try {
      const transporter = nodemailer.createTransport({
        host: settings.email_smtp_host,
        port: parseInt(settings.email_smtp_port) || 587,
        secure: (parseInt(settings.email_smtp_port) || 587) === 465,
        auth: { user: settings.email_user, pass: settings.email_password },
      });
      await transporter.verify();
      transporter.close();
    } catch (err) {
      errors.push({ type: 'smtp', error: err.message });
    }
  }

  return { ok: errors.length === 0, errors };
}
