#!/usr/bin/env node

// PAN MCP Server — exposes PAN's API as native Claude Code tools
// Transport: stdio (Claude Code spawns this as a child process)
//
// Architecture: 6 core tools + 1 router + resources
// - Core tools: always in context, high-frequency or safety-critical
// - Router (pan): single dispatch tool for 18+ actions, saves ~4000 tokens/turn
// - Resources: pull-based, zero cost until referenced with @

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PAN = 'http://127.0.0.1:7777';

async function panFetch(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${PAN}${path}`, opts);
  if (!res.ok) throw new Error(`PAN ${res.status}: ${await res.text()}`);
  return res.json();
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(e) {
  const msg = e.cause?.code === 'ECONNREFUSED'
    ? 'PAN server not running (127.0.0.1:7777 refused)'
    : `PAN error: ${e.message}`;
  return { content: [{ type: 'text', text: msg }], isError: true };
}

const server = new McpServer({ name: 'pan', version: '2.0.0' });

// ==================== CORE TOOLS (always in context) ====================

server.tool(
  'pan_search',
  'Full-text search across all PAN events (conversations, commands, voice, system). Returns ranked results.',
  { q: z.string(), limit: z.number().optional(), type: z.string().optional() },
  async ({ q, limit, type }) => {
    try {
      let path = `/dashboard/api/events?q=${encodeURIComponent(q)}&limit=${limit || 50}`;
      if (type) path += `&event_type=${encodeURIComponent(type)}`;
      return ok(await panFetch(path));
    } catch (e) { return err(e); }
  }
);

server.tool(
  'pan_memory',
  'Read classified memory items (tasks, decisions, facts, preferences) from PAN database.',
  {},
  async () => {
    try { return ok(await panFetch('/dashboard/api/memory')); }
    catch (e) { return err(e); }
  }
);

server.tool(
  'pan_restart',
  'Restart PAN server. ONLY safe way to restart — never use Bash to run node pan.js or server.js.',
  {},
  async () => {
    try { return ok(await panFetch('/api/admin/restart', { method: 'POST' })); }
    catch (e) { return err(e); }
  }
);

server.tool(
  'pan_dev',
  'Start dev server on port 7781 and open it in a new window. Safe alongside production.',
  { action: z.enum(['status', 'sessions', 'start']).optional() },
  async ({ action }) => {
    try {
      if (action === 'sessions') return ok(await panFetch('/api/v1/terminal/sessions'));
      if (action === 'start') {
        const dev = await panFetch('/api/v1/dev/start', { method: 'POST' });
        const devPort = dev.port || 7781;
        try { await panFetch('/api/v1/ui-commands', { method: 'POST', body: { type: 'open_window', url: `http://localhost:${devPort}/v2/terminal` } }); } catch {}
        return ok({ devServer: `http://localhost:${devPort}/v2/terminal`, port: devPort });
      }
      const sessions = await panFetch('/api/v1/terminal/sessions');
      return ok({ sessions: sessions.sessions });
    } catch (e) { return err(e); }
  }
);

server.tool(
  'pan_terminal_send',
  'Send text to an active terminal session.',
  { text: z.string(), session_id: z.string().optional() },
  async ({ text, session_id }) => {
    try {
      const body = { text };
      if (session_id) body.session_id = session_id;
      return ok(await panFetch('/api/v1/terminal/send', { method: 'POST', body }));
    } catch (e) { return err(e); }
  }
);

server.tool(
  'pan_browser',
  'Control browser: list_tabs, navigate, click, type, screenshot.',
  { action: z.string(), url: z.string().optional(), query: z.string().optional(), text: z.string().optional() },
  async (params) => {
    try { return ok(await panFetch('/api/v1/browser', { method: 'POST', body: params })); }
    catch (e) { return err(e); }
  }
);

server.tool(
  'pan_guardian',
  'Guardian Guillotine — query security scan decisions, stats, or manually test content.',
  {
    action: z.enum(['status', 'decisions', 'scan', 'config']).describe('status=overview, decisions=audit log, scan=test content, config=update settings'),
    content: z.string().optional().describe('Content to scan (for action=scan)'),
    limit: z.number().optional(),
    decision: z.enum(['allowed', 'warned', 'blocked']).optional(),
    enabled: z.boolean().optional(),
    mode: z.enum(['off', 'warn', 'block']).optional(),
  },
  async ({ action, content, limit, decision, enabled, mode }) => {
    try {
      if (action === 'status') return ok(await panFetch('/api/v1/guardian/status'));
      if (action === 'decisions') {
        let path = `/api/v1/guardian/decisions?limit=${limit || 20}`;
        if (decision) path += `&decision=${decision}`;
        return ok(await panFetch(path));
      }
      if (action === 'scan') {
        if (!content) return err('content required for scan');
        return ok(await panFetch('/api/v1/guardian/scan', { method: 'POST', body: { content } }));
      }
      if (action === 'config') {
        const body = {};
        if (enabled !== undefined) body.enabled = enabled;
        if (mode) body.mode = mode;
        return ok(await panFetch('/api/v1/guardian/config', { method: 'POST', body }));
      }
      return err('Unknown action');
    } catch (e) { return err(e); }
  }
);

// ==================== ROUTER (single tool for 18+ actions) ====================
// This replaces 18 separate tool definitions, saving ~4000 tokens/turn.
// Use @pan://actions resource to see all available actions and their parameters.

server.tool(
  'pan',
  `PAN router — single dispatch for all PAN actions. Use @pan://actions to see full action list with parameters.

Actions: conversations, projects, tasks, services, devices, stats, sessions, sensors, photos, scout, alerts, recording, windows, settings, logs, runner, library, context, processes, carrier`,
  {
    action: z.string().describe('Action name (see @pan://actions for full list)'),
    params: z.record(z.any()).optional().describe('Action parameters as key-value pairs')
  },
  async ({ action, params = {} }) => {
    try {
      switch (action) {
        // --- Data queries ---
        case 'conversations': {
          let path = `/dashboard/api/conversations?limit=${params.limit || 50}`;
          if (params.q) path += `&q=${encodeURIComponent(params.q)}`;
          if (params.filter) path += `&filter=${encodeURIComponent(params.filter)}`;
          return ok(await panFetch(path));
        }
        case 'projects':
          return ok(await panFetch('/dashboard/api/progress'));
        case 'tasks': {
          if (params.task_action === 'create') {
            return ok(await panFetch(`/dashboard/api/projects/${params.project_id}/tasks`, {
              method: 'POST', body: { title: params.title, description: params.description, milestone_id: params.milestone_id, status: params.status || 'todo', priority: params.priority || 0 }
            }));
          }
          if (params.task_action === 'update') {
            const body = {};
            if (params.title !== undefined) body.title = params.title;
            if (params.description !== undefined) body.description = params.description;
            if (params.status !== undefined) body.status = params.status;
            if (params.milestone_id !== undefined) body.milestone_id = params.milestone_id;
            if (params.priority !== undefined) body.priority = params.priority;
            return ok(await panFetch(`/dashboard/api/tasks/${params.task_id}`, { method: 'PUT', body }));
          }
          return ok(await panFetch(`/dashboard/api/projects/${params.project_id}/tasks`));
        }
        case 'services':
          return ok(await panFetch('/dashboard/api/services'));
        case 'devices': {
          if (params.device_action === 'command') {
            return ok(await panFetch('/api/v1/devices/command', {
              method: 'POST', body: { target_device: params.target_device, type: params.command_type, command: params.command, text: params.text }
            }));
          }
          return ok(await panFetch('/api/v1/devices/list'));
        }
        case 'stats':
          return ok(await panFetch('/dashboard/api/stats'));
        case 'sessions':
          return ok(await panFetch('/api/v1/terminal/sessions'));
        case 'sensors':
          return ok(await panFetch('/api/sensors/'));
        case 'photos':
          return ok(await panFetch('/dashboard/api/photos'));
        case 'scout': {
          let path = '/dashboard/api/scout';
          if (params.status) path += `?status=${encodeURIComponent(params.status)}`;
          return ok(await panFetch(path));
        }

        // --- Alerts ---
        case 'alerts': {
          const sub = params.alert_action || 'list';
          if (sub === 'types') return ok(await panFetch('/dashboard/api/alerts/types'));
          if (sub === 'count') return ok(await panFetch('/dashboard/api/alerts/count'));
          if (sub === 'get') return ok(await panFetch(`/dashboard/api/alerts/${params.id}`));
          if (sub === 'acknowledge') return ok(await panFetch(`/dashboard/api/alerts/${params.id}`, { method: 'PATCH', body: { status: 'acknowledged' } }));
          if (sub === 'resolve') return ok(await panFetch(`/dashboard/api/alerts/${params.id}`, { method: 'PATCH', body: { status: 'resolved', resolution: params.resolution || '', resolved_by: 'claude' } }));
          if (sub === 'dismiss') return ok(await panFetch(`/dashboard/api/alerts/${params.id}`, { method: 'PATCH', body: { status: 'dismissed' } }));
          if (sub === 'reopen') return ok(await panFetch(`/dashboard/api/alerts/${params.id}`, { method: 'PATCH', body: { status: 'open' } }));
          // list
          let path = `/dashboard/api/alerts?limit=${params.limit || 50}`;
          if (params.status) path += `&status=${encodeURIComponent(params.status)}`;
          if (params.type) path += `&type=${encodeURIComponent(params.type)}`;
          return ok(await panFetch(path));
        }

        // --- Recording ---
        case 'recording': {
          const sub = params.recording_action || 'status';
          if (sub === 'start') return ok(await panFetch('/api/v1/recording/start', { method: 'POST' }));
          if (sub === 'stop') return ok(await panFetch('/api/v1/recording/stop', { method: 'POST' }));
          if (sub === 'list') return ok(await panFetch('/api/v1/recording/list'));
          return ok(await panFetch('/api/v1/recording/status'));
        }

        // --- Windows ---
        case 'windows': {
          const sub = params.window_action || 'list';
          if (sub === 'open') return ok(await panFetch('/api/v1/windows/open', { method: 'POST', body: { url: params.url, label: params.label } }));
          if (sub === 'focus') return ok(await panFetch('/api/v1/windows/focus', { method: 'POST', body: { title: params.title, label: params.label } }));
          if (sub === 'close') return ok(await panFetch('/api/v1/windows/close', { method: 'POST', body: { title: params.title, label: params.label } }));
          return ok(await panFetch('/api/v1/windows'));
        }

        // --- Settings ---
        case 'settings': {
          if (params.settings_action === 'set') return ok(await panFetch('/api/v1/settings', { method: 'PUT', body: params.values }));
          return ok(await panFetch('/api/v1/settings'));
        }

        // --- Logs ---
        case 'logs': {
          if (params.log_action === 'summary') return ok(await panFetch('/api/v1/logs/summary'));
          let path = `/api/v1/logs?limit=${params.limit || 50}`;
          if (params.device_id) path += `&device_id=${encodeURIComponent(params.device_id)}`;
          if (params.level) path += `&level=${encodeURIComponent(params.level)}`;
          if (params.source) path += `&source=${encodeURIComponent(params.source)}`;
          return ok(await panFetch(path));
        }

        // --- Runner ---
        case 'runner': {
          const sub = params.runner_action || 'projects';
          if (sub === 'projects') return ok(await panFetch('/api/v1/runner/projects'));
          if (sub === 'running') return ok(await panFetch('/api/v1/runner/running'));
          if (sub === 'status') return ok(await panFetch(`/api/v1/runner/project?path=${encodeURIComponent(params.path)}`));
          if (sub === 'start') return ok(await panFetch('/api/v1/runner/start', { method: 'POST', body: { path: params.path, service: params.service } }));
          if (sub === 'stop') return ok(await panFetch('/api/v1/runner/stop', { method: 'POST', body: { path: params.path, service: params.service } }));
          if (sub === 'stop_all') return ok(await panFetch('/api/v1/runner/stop-all', { method: 'POST', body: { path: params.path } }));
          if (sub === 'logs') {
            let p = `/api/v1/runner/logs?path=${encodeURIComponent(params.path)}`;
            if (params.service) p += `&service=${encodeURIComponent(params.service)}`;
            return ok(await panFetch(p));
          }
          return ok(await panFetch('/api/v1/runner/projects'));
        }

        // --- Library ---
        case 'library': {
          if (params.file) return ok(await panFetch(`/api/v1/library/view?file=${encodeURIComponent(params.file)}`));
          return ok(await panFetch('/api/v1/library'));
        }

        // --- Processes ---
        case 'processes':
          return ok(await panFetch('/api/v1/processes'));

        // --- Carrier / Crucible ---
        case 'carrier': {
          const sub = params.carrier_action || 'status';
          if (sub === 'status') return ok(await panFetch('/api/carrier/status'));
          if (sub === 'swap') return ok(await panFetch('/api/carrier/swap', { method: 'POST' }));
          if (sub === 'shadow_start') return ok(await panFetch('/api/carrier/shadow', { method: 'POST' }));
          if (sub === 'shadow_stop') return ok(await panFetch('/api/carrier/shadow', { method: 'DELETE' }));
          if (sub === 'shadow_promote') return ok(await panFetch('/api/carrier/shadow/promote', { method: 'POST' }));
          if (sub === 'shadow_stats') return ok(await panFetch('/api/carrier/shadow/stats'));
          if (sub === 'crucible') return ok(await panFetch(`/api/carrier/crucible?limit=${params.limit || 100}${params.mismatches ? '&mismatches=1' : ''}`));
          if (sub === 'open_crucible') {
            await panFetch('/api/v1/ui-commands', { method: 'POST', body: { type: 'open_window', url: 'http://localhost:7777/v2/crucible', title: 'Crucible', width: 1200, height: 800 } });
            return ok({ opened: 'crucible' });
          }
          if (sub === 'rollback') return ok(await panFetch('/lifeboat/rollback', { method: 'POST' }));
          if (sub === 'confirm') return ok(await panFetch('/lifeboat/confirm', { method: 'POST' }));
          if (sub === 'lifeboat') return ok(await panFetch('/lifeboat/status'));
          return err(new Error(`Unknown carrier_action: "${sub}". Options: status, swap, shadow_start, shadow_stop, shadow_promote, shadow_stats, crucible, open_crucible, rollback, confirm, lifeboat`));
        }

        // --- Voice / TTS ---
        case 'voice': {
          const sub = params.voice_action || 'profiles';
          if (sub === 'profiles') return ok(await panFetch('/api/v1/voice/profiles'));
          if (sub === 'pregenerate') return ok(await panFetch(`/api/v1/voice/pregenerate/${encodeURIComponent(params.name)}`, { method: 'POST' }));
          if (sub === 'pack') return ok(await panFetch(`/api/v1/voice/pack/${encodeURIComponent(params.name)}`));
          return err(new Error(`Unknown voice_action: "${sub}". Options: profiles, pregenerate, pack`));
        }

        // --- Context ---
        case 'context': {
          if (params.context_action === 'inject') return ok(await panFetch('/api/v1/inject-context', { method: 'POST', body: { cwd: params.cwd || 'C:\\Users\\tzuri\\Desktop\\PAN' } }));
          return ok(await panFetch('/api/v1/context-briefing'));
        }

        default:
          return err(new Error(`Unknown action: "${action}". Use @pan://actions to see all available actions.`));
      }
    } catch (e) { return err(e); }
  }
);

// ==================== RESOURCES (pull-based, zero cost until referenced) ====================

server.resource(
  'actions',
  'pan://actions',
  { mimeType: 'text/markdown' },
  async () => ({
    contents: [{
      uri: 'pan://actions',
      mimeType: 'text/markdown',
      text: `# PAN Router Actions

Use with: \`pan\` tool, \`action\` parameter + \`params\` object.

## Data Queries
| Action | Description | Params |
|--------|-------------|--------|
| conversations | Search past conversations | q?, filter?(all/voice/commands/photos/sensors/system), limit? |
| projects | List projects with progress/milestones | (none) |
| tasks | List/create/update project tasks | project_id, task_action?(list/create/update), task_id?, title?, description?, status?(todo/in_progress/done/backlog), milestone_id?, priority? |
| services | Service status (steward, devices) | (none) |
| devices | List devices or send command | device_action?(list/command), target_device?, command_type?, command?, text? |
| stats | Database statistics | (none) |
| sessions | Active terminal sessions | (none) |
| sensors | 22 sensor definitions | (none) |
| photos | Photo library | (none) |
| scout | Tool Scout findings | status?(new/reviewed/installed/dismissed) |

## Alerts
| Action | Description | Params |
|--------|-------------|--------|
| alerts | Manage system alerts | alert_action?(list/count/types/get/acknowledge/resolve/dismiss/reopen), id?, status?, type?, resolution?, limit? |

Alert types: orphan_processes, service_crash, uncaught_exception, unhandled_rejection, pty_crash, claude_cli_exit, health_check_fail, startup_error, transcript_error
Status lifecycle: open → acknowledged → resolved (with notes) or dismissed

## System Control
| Action | Description | Params |
|--------|-------------|--------|
| recording | Screen recording | recording_action?(start/stop/status/list) |
| windows | Desktop window control | window_action?(list/open/focus/close), url?, title?, label? |
| settings | Read/write PAN config | settings_action?(get/set), values?(object for set) |
| logs | System logs | log_action?(query/summary), device_id?, level?, source?, limit? |
| runner | Project service management | runner_action?(projects/running/status/start/stop/stop_all/logs), path?, service? |
| library | Docs and knowledge files | file?(path to view specific file) |
| context | Session context/briefing | context_action?(briefing/inject), cwd? |
| processes | All PIDs spawned by PAN (PTY, Claude CLI, agent-sdk) | (none) — returns alive/dead with uptime, type, session |

## Carrier / Crucible (AutoDev)
| Action | Description | Params |
|--------|-------------|--------|
| carrier | Carrier runtime control + shadow traffic + crucible | carrier_action?(status/swap/shadow_start/shadow_stop/shadow_promote/shadow_stats/crucible/open_crucible/rollback/confirm/lifeboat), limit?, mismatches? |

Carrier actions:
- **status** — Carrier + Craft health, shadow status
- **swap** — Hot-swap: spawn new Craft, health-check, switch proxy
- **shadow_start** — Launch shadow Craft for canary testing (mirrors traffic)
- **shadow_stop** — Kill shadow Craft (reject variant)
- **shadow_promote** — Promote shadow to primary (with 30s rollback)
- **shadow_stats** — Mirrored count, error rate, match rate, latency comparison
- **crucible** — Get comparison results (primary vs shadow). limit?, mismatches?(bool, filter to mismatches only)
- **open_crucible** — Open Crucible dashboard in Tauri window
- **rollback** — Rollback to previous Craft (during 30s window)
- **confirm** — Confirm current swap (kill old Craft)
- **lifeboat** — Lifeboat status (minimal, always works even if Craft is hung)|
`
    }]
  })
);

server.resource(
  'alert-types',
  'pan://alert-types',
  { mimeType: 'application/json' },
  async () => {
    try {
      const types = await panFetch('/dashboard/api/alerts/types');
      return { contents: [{ uri: 'pan://alert-types', mimeType: 'application/json', text: JSON.stringify(types, null, 2) }] };
    } catch {
      return { contents: [{ uri: 'pan://alert-types', mimeType: 'text/plain', text: 'PAN server not reachable' }] };
    }
  }
);

server.resource(
  'services',
  'pan://services',
  { mimeType: 'application/json' },
  async () => {
    try {
      const data = await panFetch('/dashboard/api/services');
      return { contents: [{ uri: 'pan://services', mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    } catch {
      return { contents: [{ uri: 'pan://services', mimeType: 'text/plain', text: 'PAN server not reachable' }] };
    }
  }
);

server.resource(
  'stats',
  'pan://stats',
  { mimeType: 'application/json' },
  async () => {
    try {
      const data = await panFetch('/dashboard/api/stats');
      return { contents: [{ uri: 'pan://stats', mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    } catch {
      return { contents: [{ uri: 'pan://stats', mimeType: 'text/plain', text: 'PAN server not reachable' }] };
    }
  }
);

// ==================== START ====================

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[PAN MCP] Server started (v2 — 7 tools + router + resources)');
