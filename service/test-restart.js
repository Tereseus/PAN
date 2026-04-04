#!/usr/bin/env node
// PAN Restart Test — runs EXTERNAL to the server process
// Tests the full restart cycle: snapshot → restart → verify data survives
//
// Usage: node test-restart.js [port]
// Default port: 7781 (dev server)
//
// This script does NOT run inside the PAN server. It's a standalone test
// that makes HTTP requests from outside, so it survives the server restart.

import http from 'http';

const PORT = parseInt(process.argv[2]) || 7781;
const BASE = `http://127.0.0.1:${PORT}`;

// ==================== HTTP Helpers ====================

function apiGet(path, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`GET ${path} timeout`)), timeoutMs);
    http.get(`${BASE}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function apiPost(path, body = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`POST ${path} timeout`)), timeoutMs);
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// Check if server is responding
async function isServerUp() {
  try {
    await apiGet('/health', 3000);
    return true;
  } catch { return false; }
}

// ==================== Test Steps ====================

const results = [];
let preStats = null;
let preProjects = null;

function log(icon, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`  ${icon} [${ts}] ${msg}`);
}

async function runStep(name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    log('✓', `${name} (${elapsed}ms) — ${result}`);
    results.push({ name, status: 'passed', result, elapsed });
    return true;
  } catch (err) {
    const elapsed = Date.now() - start;
    log('✗', `${name} (${elapsed}ms) — ${err.message}`);
    results.push({ name, status: 'failed', error: err.message, elapsed });
    return false;
  }
}

// ==================== Main Test ====================

async function main() {
  console.log(`\n  PAN Restart Test — targeting port ${PORT}\n`);
  console.log(`  ─────────────────────────────────────────\n`);

  // Step 0: Check server is up
  const up = await isServerUp();
  if (!up) {
    log('✗', `Server not responding on port ${PORT}. Start it first: node dev-server.js ${PORT}`);
    process.exit(1);
  }
  log('●', `Server is up on port ${PORT}\n`);

  // Step 1: Snapshot pre-restart state
  await runStep('Snapshot DB stats', async () => {
    preStats = await apiGet('/dashboard/api/stats');
    if (!preStats || typeof preStats.total_events !== 'number') throw new Error('Invalid stats');
    return `Events: ${preStats.total_events}, Sessions: ${preStats.total_sessions}, Memory: ${preStats.total_memory}`;
  });

  await runStep('Snapshot projects', async () => {
    const data = await apiGet('/dashboard/api/projects');
    preProjects = Array.isArray(data) ? data : (data.projects || []);
    return `${preProjects.length} projects`;
  });

  await runStep('Verify API endpoints', async () => {
    const checks = ['/dashboard/api/stats', '/api/v1/devices', '/api/v1/terminal/sessions'];
    for (const path of checks) {
      await apiGet(path);
    }
    return `${checks.length} endpoints OK`;
  });

  await runStep('Verify context briefing', async () => {
    const data = await apiGet('/api/v1/context-briefing');
    if (!data?.briefing) throw new Error('No briefing returned');
    return `${data.briefing.length} chars`;
  });

  console.log('');

  // Step 2: Trigger restart
  await runStep('Trigger restart', async () => {
    const result = await apiPost('/api/admin/restart');
    if (!result?.ok) throw new Error('Restart not acknowledged: ' + JSON.stringify(result));
    return 'Restart acknowledged';
  });

  // Step 3: Wait for server to go DOWN
  await runStep('Server goes down', async () => {
    await wait(1000);
    let down = false;
    for (let i = 0; i < 15; i++) {
      if (!(await isServerUp())) { down = true; break; }
      await wait(500);
    }
    if (!down) throw new Error('Server never went down after 8s');
    return 'Confirmed down';
  });

  // Step 4: Wait for server to come BACK UP
  await runStep('Server comes back up', async () => {
    let up = false;
    const startTime = Date.now();
    for (let i = 0; i < 30; i++) {
      await wait(1000);
      if (await isServerUp()) { up = true; break; }
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (!up) throw new Error(`Server did not come back after 30s`);
    return `Back up in ${elapsed}s`;
  });

  // Give services a moment to fully initialize
  await wait(2000);

  console.log('');

  // Step 5: Verify everything survived
  await runStep('DB stats intact', async () => {
    const stats = await apiGet('/dashboard/api/stats');
    if (!stats || typeof stats.total_events !== 'number') throw new Error('Stats broken');
    if (stats.total_events < preStats.total_events) {
      throw new Error(`Events LOST: was ${preStats.total_events}, now ${stats.total_events}`);
    }
    if (stats.total_sessions < preStats.total_sessions) {
      throw new Error(`Sessions LOST: was ${preStats.total_sessions}, now ${stats.total_sessions}`);
    }
    return `Events: ${stats.total_events} (was ${preStats.total_events}), Sessions: ${stats.total_sessions}`;
  });

  await runStep('Projects intact', async () => {
    const data = await apiGet('/dashboard/api/projects');
    const projects = Array.isArray(data) ? data : (data.projects || []);
    if (projects.length < preProjects.length) {
      throw new Error(`Projects LOST: was ${preProjects.length}, now ${projects.length}`);
    }
    return `${projects.length} projects`;
  });

  await runStep('API endpoints respond', async () => {
    const checks = [
      '/dashboard/api/stats',
      '/api/v1/devices',
      '/api/v1/terminal/sessions',
      '/dashboard/api/services',
    ];
    for (const path of checks) {
      await apiGet(path);
    }
    return `${checks.length} endpoints OK`;
  });

  await runStep('Context briefing works', async () => {
    const data = await apiGet('/api/v1/context-briefing');
    if (!data?.briefing) throw new Error('No briefing returned');
    if (data.briefing.length < 100) throw new Error(`Briefing too short: ${data.briefing.length} chars`);
    return `${data.briefing.length} chars`;
  });

  await runStep('Services starting', async () => {
    const data = await apiGet('/dashboard/api/services');
    const services = data.services || [];
    const running = services.filter(s => s.status === 'up');
    return `${running.length}/${services.length} services running`;
  });

  // ==================== Report Results ====================

  console.log('\n  ─────────────────────────────────────────\n');

  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const totalTime = results.reduce((sum, r) => sum + r.elapsed, 0);

  if (failed === 0) {
    console.log(`  ✓ ALL ${passed} TESTS PASSED (${(totalTime / 1000).toFixed(1)}s total)\n`);
  } else {
    console.log(`  ✗ ${failed} FAILED, ${passed} passed (${(totalTime / 1000).toFixed(1)}s total)`);
    for (const r of results.filter(r => r.status === 'failed')) {
      console.log(`    - ${r.name}: ${r.error}`);
    }
    console.log('');
  }

  // Also POST results to the dev server so they show in the Tests panel
  try {
    await apiPost('/api/v1/tests/external-result', {
      suite: 'restart',
      results: results.map(r => ({
        id: `restart-ext-${r.name.toLowerCase().replace(/\s+/g, '-')}`,
        name: r.name,
        suiteName: 'Server Restart (External)',
        status: r.status,
        result: r.result || null,
        error: r.error || null,
      })),
      summary: { passed, failed, total: results.length },
    });
  } catch {
    // Server might not have the external-result endpoint yet — that's fine
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
