// service/src/perf/probes.js
//
// Probe implementations — all return { ok, ms, error? } with ok = boolean.
// The engine runs these on the schedule defined in stages.js.
//
// New probe types can be added here; they must match the shape used in
// stages.js `probe.method`. The engine dispatches based on method.
//
// Probes must be cheap, side-effect-free, and bounded by their timeout_ms.
// A probe that hangs is treated as a fail after timeout.

import http from 'http';
import net from 'net';
import { spawn } from 'child_process';
import { existsSync } from 'fs';

// ==================== Primitives ====================

function withTimeout(promise, ms, label = 'probe') {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, ms, error: `timeout (${label} > ${ms}ms)` });
    }, ms);
    promise.then(
      (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); },
      (e) => { if (done) return; done = true; clearTimeout(t); resolve({ ok: false, error: String(e?.message || e) }); },
    );
  });
}

// ==================== HTTP probe ====================
// probe: { method: 'http', port, path, expect_status?, timeout_ms? }
// Special port values:
//   17700 → resolved dynamically to ctx.primaryCraftPort (survives swaps)
//   7777  → resolved dynamically to ctx.carrierPort
function probeHttp(cfg, ctx) {
  const timeout = cfg.timeout_ms || 3000;
  const expect = cfg.expect_status || 200;
  const host = cfg.host || '127.0.0.1';
  let port = cfg.port;
  if (port === 17700 && ctx?.primaryCraftPort) port = ctx.primaryCraftPort;
  else if (port === 7777 && ctx?.carrierPort) port = ctx.carrierPort;
  const t0 = Date.now();
  return withTimeout(
    new Promise((resolve) => {
      const req = http.request(
        { hostname: host, port, path: cfg.path, method: 'GET', timeout },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; if (body.length > 4096) body = body.slice(0, 4096); });
          res.on('end', () => {
            const ms = Date.now() - t0;
            const ok = res.statusCode === expect;
            resolve({
              ok,
              ms,
              error: ok ? undefined : `http ${res.statusCode} (expected ${expect})`,
            });
          });
        },
      );
      req.on('error', (err) => resolve({ ok: false, ms: Date.now() - t0, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: timeout, error: 'http timeout' }); });
      req.end();
    }),
    timeout,
    'http',
  );
}

// ==================== Port-unbound probe ====================
// probe: { method: 'port_unbound', port, timeout_ms? }
// Succeeds if the port is NOT in use — i.e. available for us to bind.
function probePortUnbound(cfg) {
  const timeout = cfg.timeout_ms || 1500;
  const t0 = Date.now();
  return withTimeout(
    new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(timeout);
      sock.on('connect', () => {
        sock.destroy();
        resolve({ ok: false, ms: Date.now() - t0, error: `port ${cfg.port} is in use` });
      });
      sock.on('error', () => {
        // Connection refused = port is unbound, which is what we want.
        resolve({ ok: true, ms: Date.now() - t0 });
      });
      sock.on('timeout', () => {
        sock.destroy();
        // Timeout is ambiguous — treat as "in use" to be safe.
        resolve({ ok: false, ms: timeout, error: `port ${cfg.port} probe timeout` });
      });
      sock.connect(cfg.port, '127.0.0.1');
    }),
    timeout,
    'port_unbound',
  );
}

// ==================== Spawn probe ====================
// probe: { method: 'spawn', cmd, args?, timeout_ms? }
// Runs a command, passes if exit code 0 within timeout.
function probeSpawn(cfg) {
  const timeout = cfg.timeout_ms || 5000;
  const t0 = Date.now();
  return withTimeout(
    new Promise((resolve) => {
      let done = false;
      let proc;
      try {
        proc = spawn(cfg.cmd, cfg.args || [], { windowsHide: true, shell: true });
      } catch (err) {
        resolve({ ok: false, ms: 0, error: 'spawn failed: ' + err.message });
        return;
      }
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { proc.kill(); } catch {}
        resolve({ ok: false, ms: timeout, error: 'spawn timeout' });
      }, timeout);
      proc.on('exit', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
          ok: code === 0,
          ms: Date.now() - t0,
          error: code === 0 ? undefined : `exit code ${code}`,
        });
      });
      proc.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, ms: Date.now() - t0, error: err.message });
      });
    }),
    timeout + 500,
    'spawn',
  );
}

// ==================== PTY echo probe ====================
// probe: { method: 'pty_echo', timeout_ms? }
// Verifies the PTY subsystem is callable. We don't actually spawn a PTY
// (that would be expensive and side-effectful); we just confirm the
// terminalServer module is loaded and can list sessions without throwing.
async function probePtyEcho(cfg, ctx) {
  const t0 = Date.now();
  if (!ctx?.terminalServer) {
    return { ok: false, ms: 0, error: 'no terminalServer in context' };
  }
  try {
    const sessions = ctx.terminalServer.listSessions
      ? ctx.terminalServer.listSessions()
      : null;
    if (!Array.isArray(sessions)) {
      return { ok: false, ms: Date.now() - t0, error: 'listSessions() did not return array' };
    }
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: String(err?.message || err) };
  }
}

// ==================== WebSocket handshake probe ====================
// probe: { method: 'ws_handshake', path, timeout_ms? }
function probeWsHandshake(cfg, ctx) {
  const timeout = cfg.timeout_ms || 2000;
  const t0 = Date.now();
  const port = ctx?.carrierPort || 7777;
  const path = cfg.path || '/terminal';
  return withTimeout(
    new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        timeout,
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, socket) => {
        try { socket.destroy(); } catch {}
        resolve({ ok: res.statusCode === 101, ms: Date.now() - t0 });
      });
      req.on('response', (res) => {
        // Server refused the upgrade
        resolve({ ok: false, ms: Date.now() - t0, error: `ws got http ${res.statusCode} (no upgrade)` });
      });
      req.on('error', (err) => resolve({ ok: false, ms: Date.now() - t0, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: timeout, error: 'ws timeout' }); });
      req.end();
    }),
    timeout,
    'ws_handshake',
  );
}

// ==================== Mark probe ====================
// probe: { method: 'mark', marker }
// Non-probing stage — ready is set manually by the code that owns the stage.
// e.g. "carrier.boot" marks ready when the boot function finishes.
// Engine returns the cached mark state.
function probeMark(cfg, ctx) {
  const hit = ctx?.marks?.[cfg.marker];
  if (hit) {
    return Promise.resolve({ ok: true, ms: hit.ms || 0 });
  }
  return Promise.resolve({ ok: false, ms: 0, error: `marker "${cfg.marker}" not set` });
}

// ==================== Event probe ====================
// probe: { method: 'event', event }
// Populated by client-side events (hot-path metrics). Engine just reads
// the latest recorded event data.
function probeEvent(cfg, ctx) {
  const hit = ctx?.events?.[cfg.event];
  if (hit && typeof hit.ms === 'number') {
    const budget = ctx?.currentBudget;
    const ok = !budget || hit.ms <= budget.hard_ms;
    return Promise.resolve({ ok, ms: hit.ms, error: ok ? undefined : `event ${hit.ms}ms > hard ${budget.hard_ms}ms` });
  }
  return Promise.resolve({ ok: false, ms: 0, error: `no event "${cfg.event}" recorded` });
}

// ==================== Dispatcher ====================
// Given a probe config + engine context, run the right probe.
export async function runProbe(probeCfg, ctx = {}) {
  switch (probeCfg.method) {
    case 'http':          return probeHttp(probeCfg, ctx);
    case 'port_unbound':  return probePortUnbound(probeCfg);
    case 'spawn':         return probeSpawn(probeCfg);
    case 'pty_echo':      return probePtyEcho(probeCfg, ctx);
    case 'ws_handshake':  return probeWsHandshake(probeCfg, ctx);
    case 'mark':          return probeMark(probeCfg, ctx);
    case 'event':         return probeEvent(probeCfg, ctx);
    default:
      return { ok: false, ms: 0, error: `unknown probe method: ${probeCfg.method}` };
  }
}
