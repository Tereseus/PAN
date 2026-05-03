/**
 * Playwright MCP Bridge for PAN
 *
 * Spawns `npx @anthropic-ai/mcp-server-playwright` (or `npx @playwright/mcp`)
 * as a child process with stdio JSON-RPC transport.
 * Provides high-level browser automation functions.
 */

import { spawn } from 'child_process';

let mcpProcess = null;
let requestId = 0;
let pendingRequests = new Map(); // id -> { resolve, reject, timeout }
let initialized = false;
let buffer = '';

// ── Lifecycle ──────────────────────────────────────────────────

async function start() {
  if (mcpProcess && !mcpProcess.killed) return true;

  return new Promise((resolve) => {
    try {
      // Try the official Playwright MCP server
      mcpProcess = spawn('npx', ['-y', '@playwright/mcp@latest', '--headless', '--isolated'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
      });

      buffer = '';

      mcpProcess.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        // JSON-RPC messages are newline-delimited
        let lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete last line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            handleMessage(msg);
          } catch {}
        }
      });

      mcpProcess.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) console.log('[Playwright MCP stderr]', text);
      });

      mcpProcess.on('error', (err) => {
        console.error('[Playwright MCP] spawn error:', err.message);
        mcpProcess = null;
        initialized = false;
        resolve(false);
      });

      mcpProcess.on('exit', (code) => {
        console.log('[Playwright MCP] exited with code', code);
        mcpProcess = null;
        initialized = false;
        // Reject all pending
        for (const [id, p] of pendingRequests) {
          clearTimeout(p.timeout);
          p.reject(new Error('MCP process exited'));
        }
        pendingRequests.clear();
      });

      // Send initialize handshake
      setTimeout(async () => {
        try {
          const initResult = await rpcCall('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'pan', version: '1.0.0' }
          }, 10000);
          // Send initialized notification
          sendMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
          initialized = true;
          console.log('[Playwright MCP] initialized, tools:', initResult?.capabilities?.tools ? 'yes' : 'unknown');
          resolve(true);
        } catch (e) {
          console.error('[Playwright MCP] init failed:', e.message);
          stop();
          resolve(false);
        }
      }, 1000); // give npx a moment to start

    } catch (e) {
      console.error('[Playwright MCP] failed to spawn:', e.message);
      resolve(false);
    }
  });
}

function stop() {
  if (mcpProcess && !mcpProcess.killed) {
    mcpProcess.kill();
  }
  mcpProcess = null;
  initialized = false;
  pendingRequests.clear();
}

// ── JSON-RPC Transport ─────────────────────────────────────────

function sendMessage(msg) {
  if (!mcpProcess || mcpProcess.killed) throw new Error('MCP not running');
  mcpProcess.stdin.write(JSON.stringify(msg) + '\n');
}

function rpcCall(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timeout });
    sendMessage({ jsonrpc: '2.0', id, method, params });
  });
}

function handleMessage(msg) {
  if (msg.id != null && pendingRequests.has(msg.id)) {
    const p = pendingRequests.get(msg.id);
    clearTimeout(p.timeout);
    pendingRequests.delete(msg.id);
    if (msg.error) {
      p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      p.resolve(msg.result);
    }
  }
}

// ── MCP Tool Calls ─────────────────────────────────────────────

async function callTool(name, args = {}, timeoutMs = 15000) {
  if (!initialized) {
    const ok = await start();
    if (!ok) throw new Error('Playwright MCP not available');
  }
  const result = await rpcCall('tools/call', { name, arguments: args }, timeoutMs);
  // MCP tool results come as { content: [{ type, text }] }
  if (result?.content) {
    const texts = result.content.filter(c => c.type === 'text').map(c => c.text);
    return texts.join('\n');
  }
  return JSON.stringify(result);
}

/** Is the MCP process alive and initialized? */
export function isRunning() {
  return initialized && mcpProcess && !mcpProcess.killed;
}

// ── Public API ─────────────────────────────────────────────────

export async function isAvailable() {
  try {
    if (initialized && mcpProcess && !mcpProcess.killed) return true;
    return await start();
  } catch {
    return false;
  }
}

export async function navigateTo(url) {
  const result = await callTool('browser_navigate', { url });
  return { ok: true, text: result };
}

export async function clickElement(selector) {
  // Playwright MCP uses element descriptions or coordinates
  // Try the snapshot-based click first
  const result = await callTool('browser_click', { element: selector, ref: selector });
  return { ok: true, text: result };
}

export async function typeText(selector, text) {
  const result = await callTool('browser_type', { element: selector, ref: selector, text });
  return { ok: true, text: result };
}

export async function readPage() {
  const result = await callTool('browser_snapshot', {});
  return { ok: true, text: result };
}

export async function screenshot() {
  const result = await callTool('browser_take_screenshot', {});
  return { ok: true, text: result };
}

export async function listTabs() {
  try {
    const result = await callTool('browser_tab_list', {});
    // Parse tab list from the text response
    let tabs = [];
    try {
      // The MCP might return structured text — try to parse it
      const lines = result.split('\n').filter(l => l.trim());
      tabs = lines.map((line, i) => ({ id: i, title: line.trim() }));
    } catch {
      tabs = [{ id: 0, title: result }];
    }
    return { ok: true, tabs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function newTab(url) {
  const result = await callTool('browser_tab_create', { url });
  return { ok: true, text: result };
}

export async function closeTab() {
  const result = await callTool('browser_tab_close', {});
  return { ok: true, text: result };
}

/**
 * Generic passthrough — call any Playwright MCP tool by name.
 * Used by the router for actions we haven't wrapped yet.
 */
export async function raw(toolName, args = {}, timeoutMs = 15000) {
  const result = await callTool(toolName, args, timeoutMs);
  return { ok: true, text: result };
}

export { start, stop };
