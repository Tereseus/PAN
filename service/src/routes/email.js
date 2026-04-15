// PAN Email API routes — IMAP receive + SMTP send
// Mounted at /api/v1/email

import { Router } from 'express';
import { get, all, run } from '../db.js';
import {
  initEmail,
  getEmailSettings,
  connectImap,
  disconnectImap,
  getImapStatus,
  listFolders,
  fetchRecent,
  syncFolder,
  sendEmail,
  getEmails,
  markRead,
  testConnection,
  PROVIDER_PRESETS,
} from '../email.js';

const router = Router();
export { initEmail };

// ─── GET /status — connection status ───
router.get('/status', (req, res) => {
  const status = getImapStatus();
  const settings = getEmailSettings();
  res.json({
    ...status,
    configured: !!(settings.email_imap_host && settings.email_user && settings.email_password),
    provider: settings.email_provider || 'custom',
    user: settings.email_user || null,
  });
});

// ─── GET /config — get current email config (password masked) ───
router.get('/config', (req, res) => {
  const settings = getEmailSettings();
  res.json({
    ...settings,
    email_password: settings.email_password ? '••••••••' : '',
  });
});

// ─── POST /config — save email config ───
router.post('/config', (req, res) => {
  try {
    const body = req.body || {};

    // If a provider preset is selected, auto-fill host/port
    if (body.email_provider && PROVIDER_PRESETS[body.email_provider]) {
      const preset = PROVIDER_PRESETS[body.email_provider];
      body.email_imap_host = body.email_imap_host || preset.imap_host;
      body.email_imap_port = body.email_imap_port || String(preset.imap_port);
      body.email_smtp_host = body.email_smtp_host || preset.smtp_host;
      body.email_smtp_port = body.email_smtp_port || String(preset.smtp_port);
    }

    const allowedKeys = ['email_provider', 'email_imap_host', 'email_imap_port', 'email_smtp_host', 'email_smtp_port', 'email_user', 'email_password', 'email_from'];

    for (const key of allowedKeys) {
      if (body[key] !== undefined && body[key] !== '••••••••') {
        const existing = get("SELECT key FROM settings WHERE key = :k", { ':k': key });
        if (existing) {
          run("UPDATE settings SET value = :v WHERE key = :k", { ':v': body[key], ':k': key });
        } else {
          run("INSERT INTO settings (key, value) VALUES (:k, :v)", { ':k': key, ':v': body[key] });
        }
      }
    }

    // Disconnect IMAP so next operation reconnects with new settings
    disconnectImap().catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /test — test connection with provided settings ───
router.post('/test', async (req, res) => {
  try {
    let settings = req.body || {};

    // Fill from saved settings if fields are missing or masked
    const saved = getEmailSettings();
    for (const key of Object.keys(saved)) {
      if (!settings[key] || settings[key] === '••••••••') {
        settings[key] = saved[key];
      }
    }

    // Apply provider preset if specified
    if (settings.email_provider && PROVIDER_PRESETS[settings.email_provider]) {
      const preset = PROVIDER_PRESETS[settings.email_provider];
      settings.email_imap_host = settings.email_imap_host || preset.imap_host;
      settings.email_imap_port = settings.email_imap_port || String(preset.imap_port);
      settings.email_smtp_host = settings.email_smtp_host || preset.smtp_host;
      settings.email_smtp_port = settings.email_smtp_port || String(preset.smtp_port);
    }

    const result = await testConnection(settings);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [{ type: 'general', error: err.message }] });
  }
});

// ─── GET /folders — list IMAP folders ───
router.get('/folders', async (req, res) => {
  try {
    const folders = await listFolders();
    res.json(folders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /messages — get cached emails ───
router.get('/messages', (req, res) => {
  try {
    const folder = req.query.folder || 'INBOX';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const emails = getEmails(folder, limit, offset);
    res.json(emails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /sync — trigger sync for a folder ───
router.post('/sync', async (req, res) => {
  try {
    const folder = req.body?.folder || 'INBOX';
    const full = req.body?.full === true;

    if (full) {
      const emails = await fetchRecent(folder, 50);
      res.json({ synced: emails.length, folder, mode: 'full' });
    } else {
      const result = await syncFolder(folder);
      res.json({ ...result, mode: 'incremental' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /send — send an email ───
router.post('/send', async (req, res) => {
  try {
    const { to, subject, body, html } = req.body || {};
    if (!to) return res.status(400).json({ error: 'Missing "to" field' });
    if (!subject) return res.status(400).json({ error: 'Missing "subject" field' });

    const result = await sendEmail({ to, subject, body, html });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /mark-read — mark email as read ───
router.post('/mark-read', async (req, res) => {
  try {
    const { message_id } = req.body || {};
    if (!message_id) return res.status(400).json({ error: 'Missing message_id' });
    await markRead(message_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /presets — provider presets ───
router.get('/presets', (req, res) => {
  res.json(PROVIDER_PRESETS);
});

export default router;
