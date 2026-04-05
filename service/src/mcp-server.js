#!/usr/bin/env node

// PAN MCP Server — exposes PAN's API as native Claude Code tools
// Transport: stdio (Claude Code spawns this as a child process)

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

const server = new McpServer({ name: 'pan', version: '1.0.0' });

// ==================== HIGH PRIORITY ====================

server.tool(
  'pan_search',
  'Full-text search across all PAN events (conversations, commands, voice transcripts, system events). Returns matching events ranked by relevance.',
  { q: z.string().describe('Search query'), limit: z.number().optional().describe('Max results (default 50)'), type: z.string().optional().describe('Filter by event type (e.g. UserPromptSubmit, AssistantMessage, RouterCommand)') },
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
  'Read classified memory items from PAN database. Memory items include tasks, decisions, design decisions, feature requests, facts, insights, and preferences.',
  {},
  async () => {
    try { return ok(await panFetch('/dashboard/api/memory')); }
    catch (e) { return err(e); }
  }
);

server.tool(
  'pan_conversations',
  'Search past conversations and interactions. Supports full-text search and filtering by type.',
  { q: z.string().optional().describe('Search query'), filter: z.string().optional().describe('Filter: all, voice, commands, photos, sensors, system'), limit: z.number().optional().describe('Max results (default 50)') },
  async ({ q, filter, limit }) => {
    try {
      let path = `/dashboard/api/conversations?limit=${limit || 50}`;
      if (q) path += `&q=${encodeURIComponent(q)}`;
      if (filter) path += `&filter=${encodeURIComponent(filter)}`;
      return ok(await panFetch(path));
    } catch (e) { return err(e); }
  }
);

server.tool(
  'pan_projects',
  'List all PAN projects with task completion percentages, milestones, and session counts.',
  {},
  async () => {
    try { return ok(await panFetch('/dashboard/api/progress')); }
    catch (e) { return err(e); }
  }
);

server.tool(
  'pan_tasks',
  'List, create, or update tasks for a PAN project.',
  {
    action: z.enum(['list', 'create', 'update']).describe('Action to perform'),
    project_id: z.number().describe('Project ID'),
    title: z.string().optional().describe('Task title (for create)'),
    description: z.string().optional().describe('Task description (for create/update)'),
    status: z.enum(['todo', 'in_progress', 'done', 'backlog']).optional().describe('Task status'),
    milestone_id: z.number().optional().describe('Milestone ID'),
    task_id: z.number().optional().describe('Task ID (required for update)'),
    priority: z.number().optional().describe('Priority (0=normal, 1+=bug/important)')
  },
  async ({ action, project_id, title, description, status, milestone_id, task_id, priority }) => {
    try {
      if (action === 'list') {
        return ok(await panFetch(`/dashboard/api/projects/${project_id}/tasks`));
      } else if (action === 'create') {
        return ok(await panFetch(`/dashboard/api/projects/${project_id}/tasks`, {
          method: 'POST', body: { title, description, milestone_id, status: status || 'todo', priority: priority || 0 }
        }));
      } else if (action === 'update') {
        if (!task_id) return err(new Error('task_id required for update'));
        const body = {};
        if (title !== undefined) body.title = title;
        if (description !== undefined) body.description = description;
        if (status !== undefined) body.status = status;
        if (milestone_id !== undefined) body.milestone_id = milestone_id;
        if (priority !== undefined) body.priority = priority;
        return ok(await panFetch(`/dashboard/api/tasks/${task_id}`, { method: 'PUT', body }));
      }
    } catch (e) { return err(e); }
  }
);

server.tool(
  'pan_services',
  'Get status of all PAN services (server, steward, dream, scout, intuition) and connected devices (PC, phone, pendant). Shows green/red status and last-seen times.',
  {},
  async () => {
    try { return ok(await panFetch('/dashboard/api/services')); }
    catch (e) { return err(e); }
  }
);

server.tool(
  'pan_devices',
  'List registered devices or send a command to a device.',
  {
    action: z.enum(['list', 'command']).optional().describe('Action (default: list)'),
    target_device: z.string().optional().describe('Device hostname (for command)'),
    command_type: z.string().optional().describe('Command type: terminal, command, ui_automation'),
    command: z.string().optional().describe('Command to execute'),
    text: z.string().optional().describe('Text to send')
  },
  async ({ action, target_device, command_type, command, text }) => {
    try {
      if (!action || action === 'list') {
        return ok(await panFetch('/api/v1/devices/list'));
      } else {
        return ok(await panFetch('/api/v1/devices/command', {
          method: 'POST', body: { target_device, type: command_type, command, text }
        }));
      }
    } catch (e) { return err(e); }
  }
);

// ==================== MEDIUM PRIORITY ====================

server.tool(
  'pan_stats',
  'Get PAN database statistics: total events, memory items, sessions, projects, devices, DB size, and event type breakdown.',
  {},
  async () => {
    try { return ok(await panFetch('/dashboard/api/stats')); }
    catch (e) { return err(e); }
  }
);

server.tool(
  'pan_sessions',
  'List active terminal sessions managed by PAN (Claude Code sessions, project terminals).',
  {},
  async () => {
    try { return ok(await panFetch('/api/v1/terminal/sessions')); }
    catch (e) { return err(e); }
  }
);

server.tool(
  'pan_sensors',
  'Get all 22 PAN sensor definitions across phone, PC, and pendant devices (microphone, camera, GPS, thermal, gas, etc.).',
  {},
  async () => {
    try { return ok(await panFetch('/api/sensors/')); }
    catch (e) { return err(e); }
  }
);

server.tool(
  'pan_photos',
  'List photos captured by PAN devices with AI-generated descriptions, timestamps, and file sizes.',
  {},
  async () => {
    try { return ok(await panFetch('/dashboard/api/photos')); }
    catch (e) { return err(e); }
  }
);

server.tool(
  'pan_scout',
  'Get Tool Scout findings — AI tools and CLIs discovered by automated scanning.',
  { status: z.string().optional().describe('Filter: new, reviewed, installed, dismissed') },
  async ({ status }) => {
    try {
      let path = '/dashboard/api/scout';
      if (status) path += `?status=${encodeURIComponent(status)}`;
      return ok(await panFetch(path));
    } catch (e) { return err(e); }
  }
);

// ==================== LOW PRIORITY ====================

server.tool(
  'pan_terminal_send',
  'Send text to an active terminal session. Types commands or messages into a running Claude Code session.',
  { text: z.string().describe('Text to send'), session_id: z.string().optional().describe('Target session ID') },
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
  'Control browser via PAN. Actions: list_tabs, navigate, click, type, screenshot.',
  { action: z.string().describe('Browser action'), url: z.string().optional(), query: z.string().optional(), text: z.string().optional() },
  async (params) => {
    try {
      return ok(await panFetch('/api/v1/browser', { method: 'POST', body: params }));
    } catch (e) { return err(e); }
  }
);

server.tool(
  'pan_restart',
  'Restart PAN server — full process restart that reloads all code from disk. The wrapper automatically revives the process. This will briefly kill all connections (including this MCP session).',
  {},
  async () => {
    try { return ok(await panFetch('/api/admin/restart', { method: 'POST' })); }
    catch (e) { return err(e); }
  }
);

// ==================== DEVELOPMENT & TESTING ====================

server.tool(
  'pan_dev',
  `Dashboard development info. IMPORTANT: Before deploying ANY UI change to Prod, test on Dev first.

HOW TO TEST UI CHANGES:
1. Edit Svelte source in service/dashboard/src/
2. Run: cd service/dashboard && npm run dev  (starts Vite on port 5173+)
3. Dev instance uses isolated session IDs (dev-dash-*) so it won't affect Prod
4. Dev server proxies API/WebSocket calls to PAN server (port 7777)
5. Verify changes work, THEN: npm run build (deploys to public/v2/)
6. Refresh Prod dashboard

KEY FILES:
- Terminal page: dashboard/src/routes/terminal/+page.svelte
- API helper: dashboard/src/lib/api.js
- Stores: dashboard/src/lib/stores.svelte.js
- Server terminal mgmt: src/terminal.js
- Server routes: src/server.js
- Electron app: electron/main.cjs

SESSION LIFECYCLE:
- Session IDs are deterministic: dash-<project> (or dev-dash-<project> on Dev)
- PTY stays alive when WebSocket disconnects (line 194-199 in terminal.js)
- Reconnect: onMount checks /api/v1/terminal/sessions, then localStorage fallback
- Auto-launch Claude: ONLY if PTY has no existing buffer (hasExistingBuffer check)
- Never use isReconnect as sole guard — buffer presence is the real signal

TESTING CHECKLIST:
- [ ] Check /api/v1/terminal/sessions before and after refresh
- [ ] Verify session count doesn't increase on refresh
- [ ] Verify chat messages persist in localStorage
- [ ] Verify Claude doesn't re-launch on reconnect`,
  { action: z.enum(['status', 'sessions', 'start']).optional().describe('status: check dev server, sessions: list all terminal sessions, start: find dev server port') },
  async ({ action }) => {
    try {
      if (action === 'sessions') {
        return ok(await panFetch('/api/v1/terminal/sessions'));
      }
      if (action === 'start') {
        return ok(await panFetch('/api/v1/dev/start', { method: 'POST' }));
      }
      // Default: status overview
      const sessions = await panFetch('/api/v1/terminal/sessions');
      let devPort = null;
      try {
        const dev = await panFetch('/api/v1/dev/start', { method: 'POST' });
        devPort = dev.port || null;
      } catch {}
      return ok({
        sessions: sessions.sessions,
        devServer: devPort ? `http://localhost:${devPort}/v2/terminal` : 'Not running',
        testingGuide: 'Use pan_dev tool description for full testing workflow'
      });
    } catch (e) { return err(e); }
  }
);

// ==================== START ====================

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[PAN MCP] Server started');
