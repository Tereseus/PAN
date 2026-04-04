// Project Runner API routes
// Manages starting/stopping project services and serving the runner UI

import { Router } from 'express';
import { runner } from '../project-runner.js';
import { all } from '../db.js';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const router = Router();

// GET /api/v1/runner/projects — list all projects with their service definitions
router.get('/projects', (req, res) => {
  const projects = all('SELECT * FROM projects ORDER BY name');
  const result = projects.map(p => {
    const panFile = join(p.path, '.pan');
    let pan = null;
    try { pan = JSON.parse(readFileSync(panFile, 'utf-8')); } catch {}
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      hasServices: !!(pan?.services?.length),
      serviceCount: pan?.services?.length || 0,
      runner: pan?.runner || null,
      status: runner.getProjectStatus(p.path)
    };
  });
  res.json(result);
});

// GET /api/v1/runner/project?path=... — status of a specific project
router.get('/project', (req, res) => {
  const projectPath = req.query.path;
  if (!projectPath) return res.status(400).json({ error: 'path required' });
  if (!existsSync(join(projectPath, '.pan'))) return res.status(404).json({ error: '.pan not found' });

  res.json(runner.getProjectStatus(projectPath));
});

// POST /api/v1/runner/start — start a service
router.post('/start', async (req, res) => {
  const { path: projectPath, service } = req.body;
  if (!projectPath || !service) return res.status(400).json({ error: 'path and service required' });

  try {
    const result = await runner.startService(projectPath, service);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/runner/stop — stop a service
router.post('/stop', (req, res) => {
  const { path: projectPath, service } = req.body;
  if (!projectPath || !service) return res.status(400).json({ error: 'path and service required' });

  try {
    const result = runner.stopService(projectPath, service);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/runner/stop-all — stop all services for a project
router.post('/stop-all', (req, res) => {
  const { path: projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'path required' });

  runner.stopAll(projectPath);
  res.json({ status: 'stopped' });
});

// GET /api/v1/runner/running — all currently running projects
router.get('/running', (req, res) => {
  res.json(runner.getAllRunning());
});

// GET /api/v1/runner/logs?path=...&service=... — get recent logs for a service
router.get('/logs', (req, res) => {
  const { path: projectPath, service } = req.query;
  if (!projectPath || !service) return res.status(400).json({ error: 'path and service required' });

  const status = runner.getProjectStatus(projectPath);
  const svc = status.services.find(s => s.name === service);
  if (!svc) return res.status(404).json({ error: 'service not found' });

  res.json({ logs: svc.logs });
});

export default router;
