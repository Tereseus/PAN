import { Router } from 'express';
import { insert, all, get, run, allScoped, getScoped, runScoped, insertScoped } from '../db.js';
import { hostname } from 'os';

const router = Router();

// Device registry — each PAN instance registers itself
// Devices are identified by their hostname + a user-set friendly name

// #681 NIGHTMARE: phone-duplicate-record root cause.
// Two registration paths exist (middleware in server.js auto-prefixes `phone-`,
// this endpoint historically did not). Different callers with different conventions
// produced two rows for the same phone (e.g. `pixel-10-pro` + `phone-pixel-10-pro`).
// Canonical rule: phone hostnames MUST be `phone-<device_id>`. Server enforces it
// regardless of what callers send. Existing duplicates are merged on register.
function canonicalPhoneHost(rawId) {
  if (!rawId) return null;
  return rawId.startsWith('phone-') ? rawId : `phone-${rawId}`;
}

router.post('/register', (req, res) => {
  // Accept both `name` and `device_name` (Android dto uses device_name).
  const { device_id, name, device_name, device_type, capabilities } = req.body;
  const displayName = name || device_name || null;

  // Canonicalize: phone rows always live at `phone-<id>`. Reject the bare form.
  let deviceHostname;
  if (device_type === 'phone' && device_id) {
    deviceHostname = canonicalPhoneHost(device_id);
  } else {
    // Use device_id from body if provided (non-phone remote devices).
    // Fall back to server hostname only for local self-registration.
    deviceHostname = device_id || hostname();
  }

  // For phones: also look up the bare form. If a phantom row exists at the
  // bare hostname, merge it into the canonical row (or rename it in place).
  if (device_type === 'phone' && device_id) {
    const bareHost = device_id.startsWith('phone-') ? device_id.slice(6) : device_id;
    if (bareHost && bareHost !== deviceHostname) {
      const phantom = getScoped(req, "SELECT * FROM devices WHERE hostname = :h AND org_id = :org_id", { ':h': bareHost });
      if (phantom) {
        const canonical = getScoped(req, "SELECT * FROM devices WHERE hostname = :h AND org_id = :org_id", { ':h': deviceHostname });
        if (canonical) {
          // Both exist — keep canonical, delete phantom. Bring last_seen forward.
          runScoped(req, "UPDATE devices SET last_seen = MAX(:phantom_seen, last_seen) WHERE hostname = :h AND org_id = :org_id",
            { ':phantom_seen': phantom.last_seen, ':h': deviceHostname });
          runScoped(req, "DELETE FROM devices WHERE hostname = :h AND org_id = :org_id", { ':h': bareHost });
          console.log(`[#681] merged duplicate phone row: ${bareHost} → ${deviceHostname}`);
        } else {
          // Only the phantom exists — rename it to the canonical hostname.
          runScoped(req, "UPDATE devices SET hostname = :newH WHERE hostname = :oldH AND org_id = :org_id",
            { ':newH': deviceHostname, ':oldH': bareHost });
          console.log(`[#681] renamed phantom phone row: ${bareHost} → ${deviceHostname}`);
        }
      }
    }
  }

  const existing = getScoped(req, "SELECT * FROM devices WHERE hostname = :h AND org_id = :org_id", { ':h': deviceHostname });

  if (existing) {
    runScoped(req, `UPDATE devices SET
      name = COALESCE(:name, name),
      device_type = COALESCE(:type, device_type),
      capabilities = COALESCE(:caps, capabilities),
      last_seen = datetime('now','localtime')
      WHERE hostname = :h AND org_id = :org_id`, {
      ':name': displayName,
      ':type': device_type || null,
      ':caps': capabilities ? JSON.stringify(capabilities) : null,
      ':h': deviceHostname
    });
  } else {
    insertScoped(req, `INSERT INTO devices (hostname, name, device_type, capabilities, last_seen, org_id)
      VALUES (:h, :name, :type, :caps, datetime('now','localtime'), :org_id)`, {
      ':h': deviceHostname,
      ':name': displayName || deviceHostname,
      ':type': device_type || 'pc',
      ':caps': capabilities ? JSON.stringify(capabilities) : '["terminal","filesystem","claude"]'
    });
  }

  res.json({ ok: true, hostname: deviceHostname });
});

// List all known devices
router.get('/list', (req, res) => {
  const devices = allScoped(req, "SELECT * FROM devices WHERE org_id = :org_id ORDER BY last_seen DESC");
  res.json(devices);
});

// Rename a device by ID
router.patch('/:id/rename', (req, res) => {
  const id = parseInt(req.params.id);
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'Name required' });
  const device = getScoped(req, "SELECT * FROM devices WHERE id = :id AND org_id = :org_id", { ':id': id });
  if (!device) return res.status(404).json({ ok: false, error: 'Device not found' });
  runScoped(req, "UPDATE devices SET name = :name WHERE id = :id AND org_id = :org_id", { ':name': name.trim(), ':id': id });
  res.json({ ok: true, name: name.trim() });
});

// Delete a device by ID
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const device = getScoped(req, "SELECT * FROM devices WHERE id = :id AND org_id = :org_id", { ':id': id });
  if (!device) return res.status(404).json({ ok: false, error: 'Device not found' });
  runScoped(req, "DELETE FROM devices WHERE id = :id AND org_id = :org_id", { ':id': id });
  res.json({ ok: true, deleted: device.name });
});

// Command queue — phone sends commands, devices poll for them
router.post('/command', (req, res) => {
  const { target_device, command_type, command, text } = req.body;

  const id = insertScoped(req, `INSERT INTO command_queue (target_device, command_type, command, text, status, org_id)
    VALUES (:target, :type, :cmd, :text, 'pending', :org_id)`, {
    ':target': target_device || hostname(),
    ':type': command_type || 'system',
    ':cmd': command || '',
    ':text': text || ''
  });

  res.json({ ok: true, command_id: id });
});

// Device polls for pending commands
router.get('/commands/pending', (req, res) => {
  const deviceHostname = hostname();
  const commands = allScoped(req, `SELECT * FROM command_queue
    WHERE target_device = :h AND status = 'pending' AND org_id = :org_id
    ORDER BY created_at ASC`, {
    ':h': deviceHostname
  });

  res.json(commands);
});

// Update command status
router.post('/commands/:id/status', (req, res) => {
  const { status, result } = req.body;
  runScoped(req, `UPDATE command_queue SET status = :status, result = :result, completed_at = datetime('now','localtime')
    WHERE id = :id AND org_id = :org_id`, {
    ':id': parseInt(req.params.id),
    ':status': status,
    ':result': result || ''
  });
  res.json({ ok: true });
});

// Get command history
router.get('/commands/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const commands = allScoped(req, `SELECT * FROM command_queue WHERE org_id = :org_id ORDER BY created_at DESC LIMIT :limit`, {
    ':limit': limit
  });
  res.json(commands);
});

// Get detailed logs for a specific command
router.get('/commands/:id/logs', (req, res) => {
  const logs = allScoped(req, `SELECT * FROM command_logs WHERE command_id = :id AND org_id = :org_id ORDER BY created_at ASC`, {
    ':id': parseInt(req.params.id)
  });
  res.json(logs);
});

export default router;
