import { Router } from 'express';
import { get, run, insert, all } from '../db.js';

const router = Router();

// Store for pending file query results (command_id -> { resolve, reject, timeout })
const pendingQueries = new Map();

// Request file listing from a phone
// POST /api/v1/files/query
// Body: { device_id: number, action: "list"|"search", path?: string, extensions?: string[], query?: string, max_results?: number }
router.post('/query', (req, res) => {
  const { device_id, action, path, extensions, query, max_results } = req.body;

  if (!device_id || !action) {
    return res.status(400).json({ error: 'device_id and action required' });
  }

  // Verify the device exists
  const device = get("SELECT * FROM devices WHERE id = :id", { ':id': device_id });
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const commandType = action === 'search' ? 'search_files' : 'list_files';

  // Create a command for the phone to pick up (using existing command_queue table)
  const commandId = insert(
    `INSERT INTO command_queue (target_device, command_type, command, text, status)
     VALUES (:target, :type, :cmd, :text, 'pending')`,
    {
      ':target': device.hostname,
      ':type': commandType,
      ':cmd': JSON.stringify({ path, extensions, query, max_results: max_results || 100 }),
      ':text': action === 'search' ? `Search files: ${query || ''}` : `List files: ${path || '/'}`
    }
  );

  // Wait up to 30 seconds for the phone to respond
  const timeoutMs = 30000;
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingQueries.delete(String(commandId));
      reject(new Error('Phone did not respond in time'));
    }, timeoutMs);

    pendingQueries.set(String(commandId), { resolve, reject, timeout });
  });

  promise
    .then(result => res.json(result))
    .catch(err => res.status(504).json({ error: err.message }));
});

// Phone posts file results back
// POST /api/v1/files/results
// Body: { command_id: number, files: [...], query?: string, extensions?: string[] }
router.post('/results', (req, res) => {
  const { command_id, files, query: searchQuery, extensions } = req.body;

  if (!command_id) {
    return res.status(400).json({ error: 'command_id required' });
  }

  // Update command status
  run(`UPDATE command_queue SET status = 'completed', result = :result, completed_at = datetime('now','localtime')
    WHERE id = :id`, {
    ':id': command_id,
    ':result': JSON.stringify({ files, query: searchQuery, extensions })
  });

  // Resolve any pending query waiting for this result
  const pending = pendingQueries.get(String(command_id));
  if (pending) {
    clearTimeout(pending.timeout);
    pendingQueries.delete(String(command_id));
    pending.resolve({ files: files || [], query: searchQuery, extensions });
  }

  res.json({ ok: true });
});

// Phone polls for pending file commands
// GET /api/v1/files/commands/pending
// Uses x-device-id header or IP-based hostname to identify the phone
router.get('/commands/pending', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const deviceId = req.headers['x-device-id'];
  const phoneHost = deviceId || `phone-${ip.replace(/[^0-9.]/g, '')}`;
  const device = get("SELECT * FROM devices WHERE hostname = :h", { ':h': phoneHost });
  if (!device) return res.json([]);

  const commands = all(
    `SELECT * FROM command_queue
     WHERE target_device = :h AND status = 'pending'
       AND command_type IN ('list_files', 'search_files')
     ORDER BY created_at ASC`,
    { ':h': device.hostname }
  );
  res.json(commands);
});

export default router;
