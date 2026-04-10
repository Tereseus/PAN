import { Router } from 'express';
import { insert, all, get, run } from '../db.js';
import { hostname } from 'os';

const router = Router();

// Device registry — each PAN instance registers itself
// Devices are identified by their hostname + a user-set friendly name

router.post('/register', (req, res) => {
  const { name, device_type, capabilities } = req.body;
  const deviceHostname = hostname();

  const existing = get("SELECT * FROM devices WHERE hostname = :h", { ':h': deviceHostname });

  if (existing) {
    run(`UPDATE devices SET
      name = COALESCE(:name, name),
      device_type = COALESCE(:type, device_type),
      capabilities = COALESCE(:caps, capabilities),
      last_seen = datetime('now','localtime')
      WHERE hostname = :h`, {
      ':name': name || null,
      ':type': device_type || null,
      ':caps': capabilities ? JSON.stringify(capabilities) : null,
      ':h': deviceHostname
    });
  } else {
    insert(`INSERT INTO devices (hostname, name, device_type, capabilities, last_seen)
      VALUES (:h, :name, :type, :caps, datetime('now','localtime'))`, {
      ':h': deviceHostname,
      ':name': name || deviceHostname,
      ':type': device_type || 'pc',
      ':caps': capabilities ? JSON.stringify(capabilities) : '["terminal","filesystem","claude"]'
    });
  }

  res.json({ ok: true, hostname: deviceHostname });
});

// List all known devices
router.get('/list', (req, res) => {
  const devices = all("SELECT * FROM devices ORDER BY last_seen DESC");
  res.json(devices);
});

// Delete a device by ID
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const device = get("SELECT * FROM devices WHERE id = :id", { ':id': id });
  if (!device) return res.status(404).json({ ok: false, error: 'Device not found' });
  run("DELETE FROM devices WHERE id = :id", { ':id': id });
  res.json({ ok: true, deleted: device.name });
});

// Command queue — phone sends commands, devices poll for them
router.post('/command', (req, res) => {
  const { target_device, command_type, command, text } = req.body;

  const id = insert(`INSERT INTO command_queue (target_device, command_type, command, text, status)
    VALUES (:target, :type, :cmd, :text, 'pending')`, {
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
  const commands = all(`SELECT * FROM command_queue
    WHERE target_device = :h AND status = 'pending'
    ORDER BY created_at ASC`, {
    ':h': deviceHostname
  });

  res.json(commands);
});

// Update command status
router.post('/commands/:id/status', (req, res) => {
  const { status, result } = req.body;
  run(`UPDATE command_queue SET status = :status, result = :result, completed_at = datetime('now','localtime')
    WHERE id = :id`, {
    ':id': parseInt(req.params.id),
    ':status': status,
    ':result': result || ''
  });
  res.json({ ok: true });
});

// Get command history
router.get('/commands/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const commands = all(`SELECT * FROM command_queue ORDER BY created_at DESC LIMIT :limit`, {
    ':limit': limit
  });
  res.json(commands);
});

// Get detailed logs for a specific command
router.get('/commands/:id/logs', (req, res) => {
  const logs = all(`SELECT * FROM command_logs WHERE command_id = :id ORDER BY created_at ASC`, {
    ':id': parseInt(req.params.id)
  });
  res.json(logs);
});

export default router;
