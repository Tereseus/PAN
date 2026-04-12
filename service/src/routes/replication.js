// Tier 0 Phase 6 — Replication Foundation
//
// Lightweight backup infrastructure. NOT full Litestream — just manual
// SQLite backup API + status reporting. Single-server only for now.
//
// Routes:
//   GET  /api/v1/replication/status   — DB file size, last modified, WAL size
//   POST /api/v1/replication/backup   — trigger manual backup via SQLite backup API
//   GET  /api/v1/replication/backups  — list available backups with sizes and dates
//   DELETE /api/v1/replication/backups/:name — delete a specific backup
//   POST /api/v1/replication/restore  — restore from a specific backup (admin only)

import { Router } from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3-multiple-ciphers');
import { db, DB_PATH } from '../db.js';
import { getDataDir } from '../platform.js';
import { auditLog } from '../middleware/org-context.js';
import { existsSync, statSync, mkdirSync, readdirSync, unlinkSync, copyFileSync, readFileSync } from 'fs';
import { join, basename } from 'path';

const router = Router();
const BACKUP_DIR = join(getDataDir(), 'backups');

// Ensure backup directory exists
if (!existsSync(BACKUP_DIR)) {
  mkdirSync(BACKUP_DIR, { recursive: true });
}

// GET /status — DB file size, last modified, WAL size
router.get('/status', (req, res) => {
  try {
    const dbStat = existsSync(DB_PATH) ? statSync(DB_PATH) : null;
    const walPath = DB_PATH + '-wal';
    const walStat = existsSync(walPath) ? statSync(walPath) : null;

    // Count existing backups
    let backupCount = 0;
    let latestBackup = null;
    if (existsSync(BACKUP_DIR)) {
      const files = readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db'));
      backupCount = files.length;
      if (files.length > 0) {
        const sorted = files.sort().reverse();
        const latestPath = join(BACKUP_DIR, sorted[0]);
        const latestStat = statSync(latestPath);
        latestBackup = {
          name: sorted[0],
          size: latestStat.size,
          created: latestStat.mtimeMs,
        };
      }
    }

    res.json({
      db_path: DB_PATH,
      db_size: dbStat?.size || 0,
      db_modified: dbStat?.mtimeMs || null,
      wal_size: walStat?.size || 0,
      backup_dir: BACKUP_DIR,
      backup_count: backupCount,
      latest_backup: latestBackup,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /backup — trigger manual backup using SQLite backup API
router.post('/backup', async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const backupName = `pan-${timestamp}.db`;
    const backupPath = join(BACKUP_DIR, backupName);

    if (existsSync(backupPath)) {
      return res.status(409).json({ error: 'backup already exists for this timestamp', name: backupName });
    }

    // Use better-sqlite3's backup() method — safe, non-blocking, consistent snapshot
    const startMs = performance.now();
    await db.backup(backupPath);
    const durationMs = +(performance.now() - startMs).toFixed(1);

    const stat = statSync(backupPath);
    console.log(`[Replication] Backup created: ${backupName} (${(stat.size / 1024 / 1024).toFixed(1)} MB, ${durationMs}ms)`);

    // Audit the backup
    try {
      auditLog(req, 'db.backup', backupName, { size: stat.size, duration_ms: durationMs });
    } catch {}

    res.json({
      ok: true,
      name: backupName,
      path: backupPath,
      size: stat.size,
      duration_ms: durationMs,
    });
  } catch (e) {
    console.error(`[Replication] Backup failed:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /backups — list available backups with sizes and dates
router.get('/backups', (req, res) => {
  try {
    if (!existsSync(BACKUP_DIR)) {
      return res.json({ backups: [], total: 0 });
    }

    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db'))
      .sort()
      .reverse(); // newest first

    const backups = files.map(f => {
      const fPath = join(BACKUP_DIR, f);
      const stat = statSync(fPath);
      return {
        name: f,
        size: stat.size,
        size_mb: +(stat.size / 1024 / 1024).toFixed(2),
        created: stat.mtimeMs,
      };
    });

    res.json({ backups, total: backups.length, backup_dir: BACKUP_DIR });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /backups/:name — delete a specific backup
router.delete('/backups/:name', (req, res) => {
  try {
    const name = basename(req.params.name); // prevent path traversal
    if (!name.endsWith('.db')) {
      return res.status(400).json({ error: 'invalid backup name' });
    }
    const fPath = join(BACKUP_DIR, name);
    if (!existsSync(fPath)) {
      return res.status(404).json({ error: 'backup not found' });
    }
    unlinkSync(fPath);
    console.log(`[Replication] Deleted backup: ${name}`);
    res.json({ ok: true, deleted: name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /restore — restore from a specific backup
// Requires confirmation via { name: "backup-name.db", confirm: true }
// This creates a pre-restore backup first, then replaces the live DB.
// WARNING: This will restart the server process after restore.
router.post('/restore', async (req, res) => {
  try {
    const { name, confirm } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required (the backup filename to restore from)' });
    }

    const safeName = basename(name); // prevent path traversal
    if (!safeName.endsWith('.db')) {
      return res.status(400).json({ error: 'invalid backup name — must end in .db' });
    }

    const backupPath = join(BACKUP_DIR, safeName);
    if (!existsSync(backupPath)) {
      return res.status(404).json({ error: 'backup not found', name: safeName });
    }

    const backupStat = statSync(backupPath);

    // Without confirm, return info about what would happen
    if (!confirm) {
      return res.json({
        ok: false,
        message: 'Restore requires confirmation. Send { name, confirm: true } to proceed.',
        backup: {
          name: safeName,
          size: backupStat.size,
          size_mb: +(backupStat.size / 1024 / 1024).toFixed(2),
          created: backupStat.mtimeMs,
        },
        warning: 'This will replace the current database. A pre-restore backup will be created first. The server will restart after restore.',
      });
    }

    // 1. Create a pre-restore backup of current DB
    const preRestoreName = `pan-pre-restore-${Date.now()}.db`;
    const preRestorePath = join(BACKUP_DIR, preRestoreName);
    await db.backup(preRestorePath);
    console.log(`[Replication] Pre-restore backup created: ${preRestoreName}`);

    // Audit the restore attempt (before we replace the DB)
    try {
      auditLog(req, 'db.restore', safeName, {
        backup_size: backupStat.size,
        pre_restore_backup: preRestoreName,
      });
    } catch {}

    // 2. Open the backup DB to verify it's valid
    const KEY_PATH = join(getDataDir(), 'pan.key');
    let dbKey = null;
    try {
      dbKey = readFileSync(KEY_PATH, 'utf-8').trim();
    } catch {
      return res.status(500).json({ error: 'cannot read encryption key — restore aborted' });
    }

    let testDb;
    try {
      testDb = new Database(backupPath);
      testDb.pragma("cipher = 'sqlcipher'");
      testDb.pragma(`key = '${dbKey}'`);
      const tableCount = testDb.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'").get()?.c || 0;
      testDb.close();
      if (tableCount === 0) {
        return res.status(400).json({ error: 'backup appears empty or unreadable (0 tables)' });
      }
    } catch (e) {
      try { testDb?.close(); } catch {}
      return res.status(400).json({ error: `backup is not a valid database: ${e.message}` });
    }

    // 3. Copy backup over the live DB path
    //    We need to close WAL first via checkpoint
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {}

    copyFileSync(backupPath, DB_PATH);
    // Remove stale WAL/SHM from the restored copy
    try { unlinkSync(DB_PATH + '-wal'); } catch {}
    try { unlinkSync(DB_PATH + '-shm'); } catch {}

    console.log(`[Replication] Database restored from ${safeName}. Server will restart.`);

    res.json({
      ok: true,
      restored_from: safeName,
      pre_restore_backup: preRestoreName,
      message: 'Database restored. Server is restarting...',
    });

    // 4. Exit with non-zero code so pan-loop.bat restarts the server
    setTimeout(() => process.exit(1), 500);
  } catch (e) {
    console.error(`[Replication] Restore failed:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
