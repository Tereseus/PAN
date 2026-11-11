// PAN MCP Apps: tools whose result draws as a page inside Claude (MCP Apps, launched Nov 2026).
//
// First test (2026-11-11): pan_jobs_view shows the Scheduled Jobs page data (hub /jobs.json)
// as a table. Registered on the stdio server only (mcp-server.js), so the hub's HTTP route is
// untouched until we know which surfaces draw it (Code tab? desktop chat? phone?).
//
// The page is fully self-contained: the ext-apps App bundle is inlined, no CDN, so no CSP list.

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

const require = createRequire(import.meta.url);
const JOBS_URI = 'ui://pan/jobs-view.html';

// The bundle is an ES module ending in export{a as B,...}. Turn the exports into a global so it
// can sit inline in the page.
function appBundle() {
  const path = require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
  let src = readFileSync(path, 'utf8');
  const exportsRe = /export\s*\{([^}]*)\}\s*;?/g;
  const pairs = [];
  src = src.replace(exportsRe, (_, list) => {
    for (const part of list.split(',')) {
      const m = part.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (m) pairs.push(`${m[2] || m[1]}:${m[1]}`);
    }
    return '';
  });
  return `${src}\nglobalThis.McpExtApps={${pairs.join(',')}};`.replace(/<\/script/gi, '<\\/script');
}

function jobsPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PAN jobs</title>
<style>
:root{--bg:#fff;--fg:#1f1f1c;--soft:#6b6a63;--line:#e4e3dc;--on:#2f7d4f;--off:#a8a69c}
@media (prefers-color-scheme:dark){:root{--bg:#1f1f1c;--fg:#ecebe6;--soft:#a3a29a;--line:#3a3a36;--on:#6fcf97;--off:#6b6a63}}
body{margin:0;padding:12px 14px;background:var(--bg);color:var(--fg);font:13px/1.4 -apple-system,"Segoe UI",sans-serif}
h1{font-size:15px;margin:0 0 2px} .sub{color:var(--soft);margin-bottom:10px}
h2{font-size:13px;margin:14px 0 4px} table{border-collapse:collapse;width:100%}
td,th{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--soft);font-weight:500} .on{color:var(--on)} .off{color:var(--off)} code{font-size:12px}
</style></head><body>
<h1>Scheduled jobs</h1><div class="sub" id="sub">Waiting for PAN…</div><div id="out"></div>
<script>${appBundle()}</script>
<script>
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function render(d) {
  if (!d || !d.machines) { document.getElementById('sub').textContent = 'No data.'; return; }
  document.getElementById('sub').textContent = 'Built ' + new Date(d.built * 1000).toLocaleString();
  document.getElementById('out').innerHTML = d.machines.map(m =>
    '<h2>' + esc(m.name) + ' <span class="off">' + esc(m.host) + '</span></h2><table><tr><th>Job</th><th>When</th><th>Last run</th></tr>' +
    m.tasks.map(t => '<tr><td class="' + (t.enabled ? 'on' : 'off') + '">' + esc(t.name) + (t.enabled ? '' : ' (off)') +
      '</td><td><code>' + esc(t.cron) + '</code></td><td>' + esc(t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : 'never') + '</td></tr>').join('') +
    '</table>').join('');
}
const app = new McpExtApps.App({ name: 'PAN jobs', version: '1.0.0' }, {});
app.ontoolresult = (r) => render(r.structuredContent);
app.connect().catch(e => { document.getElementById('sub').textContent = 'Not connected: ' + e.message; });
</script></body></html>`;
}

export function registerPanApps(server, { panBaseUrl }) {
  registerAppTool(server, 'pan_jobs_view', {
    title: 'PAN scheduled jobs',
    description: 'Show the scheduled jobs on every PAN machine (G16, Mint) as an interactive page: name, schedule, on/off, last run.',
    inputSchema: {},
    _meta: { ui: { resourceUri: JOBS_URI } },
  }, async () => {
    try {
      const res = await fetch(`${panBaseUrl}/jobs.json`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`PAN ${res.status}`);
      const j = await res.json();
      const machines = Object.entries(j.machines || {}).map(([name, m]) => ({
        name, host: m.host,
        tasks: (m.tasks || []).map(t => ({ name: t.displayName || t.id, cron: t.cronExpression || '', enabled: !!t.enabled, lastRunAt: t.lastRunAt || null })),
      }));
      const data = { built: j.built, machines };
      const text = machines.map(m => `${m.name}: ${m.tasks.filter(t => t.enabled).length} on, ${m.tasks.filter(t => !t.enabled).length} off`).join('; ');
      return { content: [{ type: 'text', text: `Scheduled jobs. ${text}` }], structuredContent: data };
    } catch (e) {
      return { content: [{ type: 'text', text: `PAN jobs not reachable: ${e.message}` }], isError: true };
    }
  });

  registerAppResource(server, 'PAN jobs view', JOBS_URI, { mimeType: RESOURCE_MIME_TYPE },
    async () => ({ contents: [{ uri: JOBS_URI, mimeType: RESOURCE_MIME_TYPE, text: jobsPage() }] }));
}
