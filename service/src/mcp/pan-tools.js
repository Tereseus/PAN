// PAN MCP — shared tool registrations.
//
// Used by both transports so the tool surface stays identical across clients:
//   - mcp-server.js          stdio, for the Claude CLI (.mcp.json)
//   - routes/mcp-pan.js      Streamable HTTP, for the Claude desktop app /
//                            Claude in Chrome / Claude.ai / Cowork via
//                            "Add custom connector → Remote MCP server URL"
//
// Every tool proxies to PAN's HTTP API on the same machine. That keeps the
// data layer in one place (the SQLCipher-encrypted DB) and the tools stateless.
//
// Includes the Paean Records quality_log tools (originally /mcp/quality-log)
// so a single connector URL reaches everything in PAN: past conversations,
// commands, decisions, sessions, AND song/art/mechanic scoring.

import { z } from 'zod';

// Server-level instructions surfaced to the connecting Claude on initialize.
// The key nudge: non-CLI surfaces don't auto-capture, so logging exchanges is
// how they contribute to the user's persistent memory.
export const PAN_MCP_INSTRUCTIONS =
  'PAN is the user\'s persistent memory across every Claude and device. ' +
  'Use pan_search whenever the user refers to something from the past ("what did we decide", "the thing I mentioned", "last time") — their full history lives here. ' +
  'IMPORTANT: this surface is NOT auto-captured. When a conversation reaches something worth remembering (a decision, an answer the user will want later, a finished task), call pan_log_exchange with a concise summary so it joins the user\'s searchable memory. Reuse one session_id across a conversation.';

export function registerPanTools(server, { panBaseUrl }) {
  async function panFetch(path, { method = 'GET', body } = {}) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${panBaseUrl}${path}`, opts);
    if (!res.ok) throw new Error(`PAN ${res.status}: ${await res.text()}`);
    return res.json();
  }

  function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  function err(e) {
    const msg = e.cause?.code === 'ECONNREFUSED'
      ? `PAN server not reachable at ${panBaseUrl}`
      : `PAN error: ${e.message || e}`;
    return { content: [{ type: 'text', text: msg }], isError: true };
  }

  // ==================== CORE TOOLS (always in context) ====================

  server.tool(
    'pan_search',
    'Full-text search across all PAN events (conversations, commands, voice, system). Returns ranked results. THE primary tool for "I don\'t remember — what did I do / say / decide?" — searches every chat message, every Claude session, every voice utterance, every command across history.',
    { q: z.string(), limit: z.number().optional(), type: z.string().optional() },
    async ({ q, limit, type }) => {
      try {
        let path = `/dashboard/api/events?q=${encodeURIComponent(q)}&limit=${limit || 50}`;
        if (type) path += `&event_type=${encodeURIComponent(type)}`;
        return ok(await panFetch(path));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    'pan_log_exchange',
    'Save this conversation exchange to PAN so it is remembered and searchable forever — across every Claude, every device. PAN auto-captures the Claude Code CLI, but the desktop app / Claude.ai / Cowork do NOT write back on their own — calling this is how those surfaces feed PAN. Call it at the end of a meaningful exchange (a question answered, a decision made, a task done) with a CONCISE summary of what the user wanted and what you concluded — not a verbatim dump. Reuse the same session_id across one conversation so its turns group together.',
    {
      user_message: z.string().describe('What the user asked or wanted — their message or a concise summary.'),
      assistant_message: z.string().describe('Your response or a concise summary of your conclusion / what you did.'),
      topic: z.string().optional().describe('Short topic label for recall later, e.g. "PAN profiles", "song mix feedback".'),
      client: z.string().optional().describe('Which surface this is: "desktop-app" | "claude.ai" | "cowork" | "chrome". Defaults to cloud-claude.'),
      session_id: z.string().optional().describe('Stable id grouping one conversation. Reuse it across the conversation\'s turns.'),
    },
    async (args) => {
      try { return ok(await panFetch('/api/v1/exchange', { method: 'POST', body: args })); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    'pan_memory',
    'Read classified memory items (tasks, decisions, facts, preferences) from PAN database.',
    {},
    async () => {
      try { return ok(await panFetch('/dashboard/api/memory')); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    'pan_thoughts',
    'Read PAN\'s own stream of consciousness — first-person reasoning trace from intuition, screen-watcher, router, scout, etc. Use this to remember "what was I just doing/thinking?" across the last few minutes/hours. Returns thoughts newest-first. Can also write a new thought (e.g. an explicit interjection deliberation) via {write:{...}}.',
    {
      limit:    z.number().optional().describe('Max thoughts to return (default 20, max 200)'),
      source:   z.string().optional().describe('Filter to one source: intuition | screen | scout | router | interjection | dream | manual'),
      since_ms: z.number().optional().describe('Only return thoughts newer than this many ms ago (e.g. 3600000 = last hour)'),
      write:    z.object({
        source: z.string(),
        thought: z.string(),
        refs: z.record(z.string(), z.any()).optional(),
        importance: z.number().optional(),
      }).optional().describe('Write a new thought instead of (or in addition to) reading. First-person sentence, <=240 chars.'),
    },
    async ({ limit, source, since_ms, write }) => {
      try {
        if (write) {
          await panFetch('/api/v1/thoughts', { method: 'POST', body: write });
        }
        const params = new URLSearchParams();
        if (limit) params.set('limit', String(limit));
        if (source) params.set('source', source);
        if (since_ms) params.set('since_ms', String(since_ms));
        const qs = params.toString();
        return ok(await panFetch(`/api/v1/thoughts/recent${qs ? '?' + qs : ''}`));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    'pan_decide',
    'Log a significant decision to PAN memory. Use when choosing between approaches, architectures, or designs — so future sessions know what was decided and why.',
    {
      decision:   z.string().describe('What was decided — short summary'),
      rationale:  z.string().optional().describe('Why this option was chosen'),
      options:    z.array(z.string()).optional().describe('Alternatives that were considered'),
      domain:     z.string().optional().describe('Category, e.g. architecture, ux, ai, infra'),
      reversible: z.boolean().optional().describe('Was this easily reversible?'),
    },
    async ({ decision, rationale, options, domain, reversible }) => {
      try {
        return ok(await panFetch('/api/v1/decisions', {
          method: 'POST',
          body: { decision, rationale, options, domain, reversible },
        }));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    'pan_restart',
    'Restart PAN server. ONLY safe way to restart — never use Bash to run node pan.js or server.js.',
    {},
    async () => {
      try { return ok(await panFetch('/api/admin/restart', { method: 'POST' })); }
      catch (e) { return err(e); }
    },
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
    },
  );

  server.tool(
    'pan_terminal_send',
    'Send text to an active terminal session.',
    { text: z.string(), session_id: z.string().optional() },
    async ({ text, session_id }) => {
      try {
        const body = { text, source: 'mcp_tool' };
        if (session_id) body.session_id = session_id;
        return ok(await panFetch('/api/v1/terminal/send', { method: 'POST', body }));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    'pan_browser',
    'Control browser: list_tabs, navigate, click, type, screenshot.',
    { action: z.string(), url: z.string().optional(), query: z.string().optional(), text: z.string().optional() },
    async (params) => {
      try { return ok(await panFetch('/api/v1/browser', { method: 'POST', body: params })); }
      catch (e) { return err(e); }
    },
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
          if (!content) return err(new Error('content required for scan'));
          return ok(await panFetch('/api/v1/guardian/scan', { method: 'POST', body: { content } }));
        }
        if (action === 'config') {
          const body = {};
          if (enabled !== undefined) body.enabled = enabled;
          if (mode) body.mode = mode;
          return ok(await panFetch('/api/v1/guardian/config', { method: 'POST', body }));
        }
        return err(new Error('Unknown action'));
      } catch (e) { return err(e); }
    },
  );

  // ==================== ROUTER ====================

  server.tool(
    'pan',
    `PAN router — single dispatch for all PAN data + actions. The umbrella tool: past conversations, projects, tasks, services, devices, sessions, alerts, voice, logs, runner, library, context, and more. Use @pan://actions to see the full action list with parameters.

Actions: conversations, projects, tasks, services, devices, stats, sessions, sensors, photos, scout, alerts, recording, windows, settings, logs, runner, library, context, processes, carrier, ops, voice`,
    {
      action: z.string().describe('Action name (see @pan://actions for full list)'),
      params: z.record(z.string(), z.any()).optional().describe('Action parameters as key-value pairs'),
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
                method: 'POST', body: { title: params.title, description: params.description, milestone_id: params.milestone_id, status: params.status || 'todo', priority: params.priority || 0 },
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
                method: 'POST', body: { target_device: params.target_device, type: params.command_type, command: params.command, text: params.text },
              }));
            }
            if (params.device_action === 'exec') {
              return ok(await panFetch('/api/v1/devices/command', {
                method: 'POST',
                body: { target_device: params.target_device, type: 'shell_exec', command: params.command, cwd: params.cwd, timeout_ms: params.timeout_ms || 30000 },
              }));
            }
            if (params.device_action === 'invite') {
              const name = encodeURIComponent(params.name || 'new-device');
              const ttl  = params.ttl_minutes || 30;
              return ok(await panFetch(`/api/v1/client/invite?name=${name}&ttl_minutes=${ttl}`));
            }
            if (params.device_action === 'list_all') {
              return ok(await panFetch('/dashboard/api/devices'));
            }
            if (params.device_action === 'record') {
              const all = await panFetch('/dashboard/api/devices');
              const rows = Array.isArray(all) ? all : (all.devices || []);
              const match = rows.find(r =>
                r.id === Number(params.id) ||
                r.hostname?.toLowerCase() === String(params.hostname || '').toLowerCase() ||
                r.name?.toLowerCase() === String(params.name || '').toLowerCase()
              );
              return ok(match || { found: false, searched: { id: params.id, hostname: params.hostname, name: params.name } });
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
          case 'alerts': {
            const sub = params.alert_action || 'list';
            if (sub === 'types') return ok(await panFetch('/dashboard/api/alerts/types'));
            if (sub === 'count') return ok(await panFetch('/dashboard/api/alerts/count'));
            if (sub === 'get') return ok(await panFetch(`/dashboard/api/alerts/${params.id}`));
            if (sub === 'acknowledge') return ok(await panFetch(`/dashboard/api/alerts/${params.id}`, { method: 'PATCH', body: { status: 'acknowledged' } }));
            if (sub === 'resolve') return ok(await panFetch(`/dashboard/api/alerts/${params.id}`, { method: 'PATCH', body: { status: 'resolved', resolution: params.resolution || '', resolved_by: 'claude' } }));
            if (sub === 'dismiss') return ok(await panFetch(`/dashboard/api/alerts/${params.id}`, { method: 'PATCH', body: { status: 'dismissed' } }));
            if (sub === 'reopen') return ok(await panFetch(`/dashboard/api/alerts/${params.id}`, { method: 'PATCH', body: { status: 'open' } }));
            let path = `/dashboard/api/alerts?limit=${params.limit || 50}`;
            if (params.status) path += `&status=${encodeURIComponent(params.status)}`;
            if (params.type) path += `&type=${encodeURIComponent(params.type)}`;
            return ok(await panFetch(path));
          }
          case 'recording': {
            const sub = params.recording_action || 'status';
            if (sub === 'start') return ok(await panFetch('/api/v1/recording/start', { method: 'POST' }));
            if (sub === 'stop') return ok(await panFetch('/api/v1/recording/stop', { method: 'POST' }));
            if (sub === 'list') return ok(await panFetch('/api/v1/recording/list'));
            return ok(await panFetch('/api/v1/recording/status'));
          }
          case 'windows': {
            const sub = params.window_action || 'list';
            if (sub === 'open') return ok(await panFetch('/api/v1/windows/open', { method: 'POST', body: { url: params.url, label: params.label } }));
            if (sub === 'focus') return ok(await panFetch('/api/v1/windows/focus', { method: 'POST', body: { title: params.title, label: params.label } }));
            if (sub === 'close') return ok(await panFetch('/api/v1/windows/close', { method: 'POST', body: { title: params.title, label: params.label } }));
            return ok(await panFetch('/api/v1/windows'));
          }
          case 'settings': {
            if (params.settings_action === 'set') return ok(await panFetch('/api/v1/settings', { method: 'PUT', body: params.values }));
            return ok(await panFetch('/api/v1/settings'));
          }
          case 'logs': {
            if (params.log_action === 'summary') return ok(await panFetch('/api/v1/logs/summary'));
            let path = `/api/v1/logs?limit=${params.limit || 50}`;
            if (params.device_id) path += `&device_id=${encodeURIComponent(params.device_id)}`;
            if (params.level) path += `&level=${encodeURIComponent(params.level)}`;
            if (params.source) path += `&source=${encodeURIComponent(params.source)}`;
            return ok(await panFetch(path));
          }
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
          case 'library': {
            if (params.file) return ok(await panFetch(`/api/v1/library/view?file=${encodeURIComponent(params.file)}`));
            return ok(await panFetch('/api/v1/library'));
          }
          case 'processes':
            return ok(await panFetch('/api/v1/processes'));
          case 'carrier': {
            const sub = params.carrier_action || 'status';
            if (sub === 'status') return ok(await panFetch('/api/carrier/status'));
            if (sub === 'swap') return ok(await panFetch('/api/carrier/swap', { method: 'POST' }));
            if (sub === 'restart') {
              const qs = params.force ? '?force=1' : '';
              return ok(await panFetch(`/api/carrier/restart${qs}`, { method: 'POST' }));
            }
            if (sub === 'swap_history') {
              const qs = params.log ? '?log=1' : '';
              return ok(await panFetch(`/api/carrier/swap-history${qs}`));
            }
            if (sub === 'perf_trace') return ok(await panFetch('/api/v1/perf/trace'));
            if (sub === 'log_tail') {
              const r = await panFetch('/api/carrier/swap-history?log=1');
              let lines = (r.log_tail || '').split('\n');
              if (params.filter) {
                const f = String(params.filter).toLowerCase();
                lines = lines.filter(l => l.toLowerCase().includes(f));
              }
              const tail = lines.slice(-(params.lines || 60));
              return ok({ lines: tail.length, log: tail.join('\n') });
            }
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
            return err(new Error(`Unknown carrier_action: "${sub}"`));
          }
          case 'ops': {
            const sub = params.ops_action || 'overview';
            if (sub === 'overview') {
              const [status, perf, hist] = await Promise.all([
                panFetch('/api/carrier/status').catch(e => ({ error: e.message })),
                panFetch('/api/v1/perf/trace').catch(e => ({ error: e.message })),
                panFetch('/api/carrier/swap-history?log=1').catch(e => ({ error: e.message })),
              ]);
              const failed = (perf.stages || []).filter(s => s.state === 'failed').map(s => `${s.id} (${s.error || 'unknown'})`);
              const recentLog = (hist.log_tail || '').split('\n').slice(-10).join('\n');
              return ok({
                carrier: status.carrier,
                primary_craft: status.primaryCraft,
                swap_pending: status.swapPending,
                perf_counts: perf.counts,
                system_ready: perf.system_ready,
                failed_stages: failed,
                recent_log_tail: recentLog,
              });
            }
            if (sub === 'probe') {
              const path = params.path || '/dashboard/api/services';
              const startedAt = Date.now();
              try {
                await panFetch(path);
                return ok({ path, ms: Date.now() - startedAt, http: 200 });
              } catch (e) {
                return ok({ path, ms: Date.now() - startedAt, error: e.message });
              }
            }
            if (sub === 'processes') return ok(await panFetch('/api/v1/processes'));
            return err(new Error(`Unknown ops_action: "${sub}"`));
          }
          case 'voice': {
            const sub = params.voice_action || 'profiles';
            if (sub === 'profiles') return ok(await panFetch('/api/v1/voice/profiles'));
            if (sub === 'pregenerate') return ok(await panFetch(`/api/v1/voice/pregenerate/${encodeURIComponent(params.name)}`, { method: 'POST' }));
            if (sub === 'pack') return ok(await panFetch(`/api/v1/voice/pack/${encodeURIComponent(params.name)}`));
            return err(new Error(`Unknown voice_action: "${sub}"`));
          }
          case 'context': {
            if (params.context_action === 'inject') return ok(await panFetch('/api/v1/inject-context', { method: 'POST', body: { cwd: params.cwd || '%USERPROFILE%\\Desktop\\PAN' } }));
            return ok(await panFetch('/api/v1/context-briefing'));
          }
          default:
            return err(new Error(`Unknown action: "${action}". Use @pan://actions to see all available actions.`));
        }
      } catch (e) { return err(e); }
    },
  );

  // ==================== PAEAN RECORDS — Quality Log ====================
  // Same tools as /mcp/quality-log, folded in here so one connector URL
  // (this one) reaches everything in PAN.

  server.tool(
    'pan_quality_compute',
    'Paean Records — score song/art/mechanic ratings without logging. Returns { q_avg, q_geo, q_min }. q_avg = weighted average; q_geo = Cobb-Douglas (collapses if any dim is low); q_min = weakest link.',
    {
      ratings: z.record(z.string(), z.number())
        .describe('Per-dimension ratings, 1..10. e.g. {beat:8,flow:7,voices:9,adlibs:6,lyrics:8}'),
      weights: z.record(z.string(), z.number()).optional()
        .describe('Per-dimension weights (non-negative). Defaults to equal weights across the rated dimensions.'),
    },
    async ({ ratings, weights }) => {
      try {
        return ok(await panFetch('/api/v1/quality-log/compute', {
          method: 'POST', body: { ratings, weights },
        }));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    'pan_quality_log_attempt',
    'Paean Records — log one creative attempt (song/art/mechanic) with ratings + weights, computes q_avg, q_geo, q_min on insert, returns the row.',
    {
      domain:      z.string().describe('"song" | "art" | "mechanic" (extensible).'),
      genre:       z.string().optional().describe('e.g. "jazz", "afrobeat", "rap".'),
      round_id:    z.string().describe('Groups iterations toward one keeper.'),
      iteration_n: z.number().int().describe('Attempt number within the round, starting at 1.'),
      ratings:     z.record(z.string(), z.number()).describe('Per-dimension ratings 1..10.'),
      weights:     z.record(z.string(), z.number()).optional(),
      kept:        z.boolean().optional().describe('Mark true when this attempt becomes the seed for the next round.'),
      seed_of:     z.string().optional().describe('id of the attempt this one was built from.'),
      notes:       z.string().optional(),
    },
    async (args) => {
      try {
        return ok(await panFetch('/api/v1/quality-log/attempts', { method: 'POST', body: args }));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    'pan_quality_get_round',
    'Paean Records — every attempt in a round, the running best (highest q_geo), and threshold gate (default 8.5).',
    {
      round_id:  z.string(),
      threshold: z.number().optional(),
    },
    async ({ round_id, threshold }) => {
      try {
        const qs = threshold != null ? `?threshold=${threshold}` : '';
        return ok(await panFetch(`/api/v1/quality-log/rounds/${encodeURIComponent(round_id)}${qs}`));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    'pan_quality_best_seed',
    'Paean Records — highest-scoring attempt to use as seed for next round.',
    { round_id: z.string().optional() },
    async ({ round_id }) => {
      try {
        const qs = round_id ? `?round_id=${encodeURIComponent(round_id)}` : '';
        return ok(await panFetch(`/api/v1/quality-log/best-seed${qs}`));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    'pan_quality_history',
    'Paean Records — recent quality-log entries, newest first.',
    {
      domain: z.string().optional(),
      genre:  z.string().optional(),
      limit:  z.number().int().optional(),
    },
    async ({ domain, genre, limit }) => {
      try {
        const params = new URLSearchParams();
        if (domain) params.set('domain', domain);
        if (genre)  params.set('genre',  genre);
        if (limit)  params.set('limit',  String(limit));
        const qs = params.toString();
        return ok(await panFetch(`/api/v1/quality-log/history${qs ? '?' + qs : ''}`));
      } catch (e) { return err(e); }
    },
  );

  // ==================== RESOURCES ====================

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
| tasks | List/create/update project tasks | project_id, task_action?(list/create/update), task_id?, title?, description?, status?, milestone_id?, priority? |
| services | Service status (steward, devices) | (none) |
| devices | List devices, send commands, enroll | device_action?(list/list_all/command/exec/invite/record), target_device?, command_type?, command? |
| stats | Database statistics | (none) |
| sessions | Active terminal sessions | (none) |
| sensors | 22 sensor definitions | (none) |
| photos | Photo library | (none) |
| scout | Tool Scout findings | status?(new/reviewed/installed/dismissed) |

## Alerts
| Action | Description | Params |
|--------|-------------|--------|
| alerts | Manage system alerts | alert_action?(list/count/types/get/acknowledge/resolve/dismiss/reopen), id?, status?, type?, resolution?, limit? |

## System Control
| Action | Description | Params |
|--------|-------------|--------|
| recording | Screen recording | recording_action?(start/stop/status/list) |
| windows | Desktop window control | window_action?(list/open/focus/close), url?, title?, label? |
| settings | Read/write PAN config | settings_action?(get/set), values? |
| logs | System logs | log_action?(query/summary), device_id?, level?, source?, limit? |
| runner | Project service management | runner_action?(projects/running/status/start/stop/stop_all/logs), path?, service? |
| library | Docs and knowledge files | file? |
| context | Session context/briefing | context_action?(briefing/inject), cwd? |
| processes | All PIDs spawned by PAN | (none) |

## Carrier / Crucible (AutoDev)
| Action | Description | Params |
|--------|-------------|--------|
| carrier | Carrier runtime control + shadow traffic + crucible | carrier_action?, limit?, mismatches? |

## Ops Diagnostics
| Action | Description | Params |
|--------|-------------|--------|
| ops | Quick health snapshot, latency probes, process map | ops_action?(overview/probe/processes), path?, timeout_ms? |

## Voice
| Action | Description | Params |
|--------|-------------|--------|
| voice | Voice profile management | voice_action?(profiles/pregenerate/pack), name? |
`,
      }],
    }),
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
    },
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
    },
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
    },
  );
}
