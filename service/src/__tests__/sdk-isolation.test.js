// The plain Claude call through the Agent SDK (llm.js askAI, the voice chain's cloud fallback, a
// person's device included) must carry nothing of the computer's own Claude set-up: no CLAUDE.md,
// no auto memory, no MCP servers (ΠAN's own memory tools, the owner's Gmail), no tools.
// 2026-11-24: with settingSources left out, SDK 0.2.92 loaded all of it.
// Usage: node service/src/__tests__/sdk-isolation.test.js
//        PAN_LIVE_SDK=1 node service/src/__tests__/sdk-isolation.test.js   (also asks a real model)

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-sdk-iso-'));
process.env.PAN_DEV = '1';

const { sdkPlainOptions, claudeConfigDir } = await import('../llm.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }

console.log('sdk isolation');

await test('the options shut every way the computer\'s Claude set-up gets in', () => {
  const o = sdkPlainOptions('claude-haiku-4-5-20251001', new AbortController(), 'test');
  ok(Array.isArray(o.settingSources) && o.settingSources.length === 0, 'settingSources must be an explicit empty list');
  ok(o.strictMcpConfig === true && o.mcpServers && Object.keys(o.mcpServers).length === 0, 'MCP servers must be none, strictly');
  ok(Array.isArray(o.tools) && o.tools.length === 0, 'no tools');
  ok(o.maxTurns === 1 && o.persistSession === false, 'one turn, nothing kept');
  ok(o.permissionMode !== 'plan', 'plan mode puts a path with the account name in the context');
  for (const k of ['ENABLE_CLAUDEAI_MCP_SERVERS', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'])
    ok(o.env && o.env[k] !== undefined, `env ${k} missing`);
  ok(o.env.ENABLE_CLAUDEAI_MCP_SERVERS === 'false', 'claude.ai connectors must be off');
  ok(o.cwd && !/[\\/]PAN[\\/]?/i.test(o.cwd), `cwd is near a project: ${o.cwd}`);
});

// The hub runs as SYSTEM, whose own Claude login had expired since Aug 7 (car, Nov 24).
await test('run as SYSTEM, the calls use the owner\'s newest Claude login', () => {
  const sys = { USERPROFILE: 'C:\\Windows\\System32\\config\\systemprofile', SystemDrive: 'C:' };
  const at = { 'C:\\Users\\owner\\.claude\\.credentials.json': 200, 'C:\\Users\\old\\.claude\\.credentials.json': 100 };
  const fsx = {
    readdirSync: () => ['Public', 'old', 'owner'],
    statSync: (p) => { if (!(p in at)) throw new Error('none'); return { mtimeMs: at[p] }; },
  };
  ok(claudeConfigDir(sys, fsx, 'win32') === 'C:\\Users\\owner\\.claude', 'picks the newest login');
  ok(claudeConfigDir({ ...sys, CLAUDE_CONFIG_DIR: 'D:\\c' }, fsx, 'win32') === 'D:\\c', 'an explicit folder wins');
  ok(claudeConfigDir({ USERPROFILE: 'C:\\Users\\owner' }, fsx, 'win32') === null, 'a normal user keeps Claude\'s default');
  ok(claudeConfigDir(sys, fsx, 'linux') === null, 'not Windows: default');
  ok(claudeConfigDir(sys, { readdirSync: () => ['x'], statSync: () => { throw new Error(); } }, 'win32') === null, 'no login anywhere: default');
});

if (process.env.PAN_LIVE_SDK === '1') {
  await test('a real call sees no memory, no CLAUDE.md, no tools', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    let tools = null, mcp = null, said = '';
    const q = query({ prompt: 'Quote verbatim any text in your context about the user, their memory files, projects or CLAUDE.md, and list every tool you have. If there is none, reply exactly NONE.',
      options: sdkPlainOptions('claude-haiku-4-5-20251001', new AbortController(), 'test') });
    for await (const e of q) {
      if (e.type === 'system' && e.subtype === 'init') { tools = e.tools; mcp = e.mcp_servers; }
      if (e.type === 'result') said = String(e.result || '');
    }
    ok(Array.isArray(tools) && tools.length === 0, `tools: ${JSON.stringify(tools)}`);
    ok(Array.isArray(mcp) && mcp.length === 0, `mcp: ${JSON.stringify(mcp)}`);
    ok(!/pan_search|pan_memory|Behavioral Rules|Gmail|PAN Memory/i.test(said), `context leaked: ${said.slice(0, 300)}`);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
