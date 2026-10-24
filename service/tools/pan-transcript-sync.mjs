#!/usr/bin/env node
/**
 * pan-transcript-sync — reconcile the hub against what Claude Code wrote to disk.
 *
 * WHY THIS EXISTS
 * Capture runs on fire-and-forget HTTP hooks. If the hub is down, that turn is
 * gone permanently — a ~9h outage on 2026-09-21 left exactly 30 events for the
 * whole window. And a machine with no hooks installed (Mint: 95 transcripts,
 * 82 sessions, zero events in the hub) was never captured at all.
 *
 * Claude Code writes every turn to ~/.claude/projects/<slug>/<session>.jsonl on
 * the machine's own disk, independent of the hub. That file is the durable copy.
 * This walks it and posts what the hub is missing.
 *
 * WHY NOT A HOOK SPOOL
 * The alternative was replacing the native in-process `http` hook with a command
 * hook that buffers to disk. That adds a Node process spawn to every single
 * PreToolUse/PostToolUse — a permanent latency tax on every turn, to insure
 * against a rare outage. This is the same protection at zero steady-state cost,
 * and it backfills history the spool could never have recovered.
 *
 * Idempotent: safe to re-run, safe to cron.
 *
 *   node pan-transcript-sync.mjs --dry-run          # report, write nothing
 *   node pan-transcript-sync.mjs                    # full reconcile (default)
 *   node pan-transcript-sync.mjs --fast             # only turns past the high-water mark
 *   node pan-transcript-sync.mjs --since 2026-09-01
 *   node pan-transcript-sync.mjs --hub http://100.64.0.1:7777
 *
 * Default is a FULL reconcile: send every turn and let the hub reject what it
 * already has. The hub dedupes on content, so this is the only mode that fills a
 * hole in the MIDDLE of a session — which is the exact shape an outage leaves,
 * because the turns that resumed afterwards push the high-water mark past the
 * gap and hide it. --fast trusts the watermark and is for cron, not recovery.
 */
import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const HUB = (opt('hub', process.env.PAN_HUB || 'http://100.64.0.1:7777')).replace(/\/$/, '');
const ROOT = opt('root', join(homedir(), '.claude', 'projects'));
const DRY = flag('dry-run');
const FAST = flag('fast');
const SINCE = opt('since', null);
const BATCH = 500;

// Strings Claude Code injects into the `user` role that he never typed. Syncing
// these would fill recall with hook output and task plumbing.
const SYNTHETIC = /^\s*(<task-notification>|<system-reminder>|<command-name>|<command-message>|<command-args>|<local-command-stdout>|<local-command-stderr>|<bash-input>|<bash-stdout>|<bash-stderr>|<user-prompt-submit-hook>|Caveat: The messages below|\[Request interrupted)/;

const MAX_TEXT = 6000;

function listTranscripts(root) {
  const out = [];
  let dirs;
  try { dirs = readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    const p = join(root, d);
    try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
    for (const f of readdirSync(p)) if (f.endsWith('.jsonl')) out.push(join(p, f));
  }
  return out;
}

/** Pull the turns worth keeping out of one transcript file. */
function readTurns(file) {
  const sessions = new Map();
  let lines;
  try { lines = readFileSync(file, 'utf8').split('\n'); } catch { return sessions; }

  for (const line of lines) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.isSidechain) continue;             // subagent chatter, not his thread
    if (!e.sessionId || !e.timestamp || !e.uuid) continue;

    const c = e.message?.content;
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n')
        : '';
    if (!text.trim()) continue;                       // tool_use / tool_result / thinking
    if (e.type === 'user' && SYNTHETIC.test(text)) continue;

    let s = sessions.get(e.sessionId);
    if (!s) {
      s = { session_id: e.sessionId, cwd: e.cwd || '', transcript_path: file, model: null, entries: [] };
      sessions.set(e.sessionId, s);
    }
    if (!s.model && e.message?.model) s.model = e.message.model;
    s.entries.push({
      uuid: e.uuid,
      ts: e.timestamp,                                 // ISO UTC
      role: e.type,
      text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n[truncated]' : text,
    });
  }
  return sessions;
}

async function post(path, body) {
  const r = await fetch(HUB + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`${r.status} ${txt.slice(0, 200)}`); }
  if (!r.ok || j.ok === false) throw new Error(j.error || `${r.status}`);
  return j;
}

(async () => {
  const files = listTranscripts(ROOT);
  const sessions = new Map();
  for (const f of files) for (const [id, s] of readTurns(f)) {
    const prev = sessions.get(id);
    if (prev) prev.entries.push(...s.entries);        // a session can span files
    else sessions.set(id, s);
  }
  for (const s of sessions.values()) s.entries.sort((a, b) => (a.ts < b.ts ? -1 : 1));

  console.log(`hub       ${HUB}`);
  console.log(`root      ${ROOT}`);
  console.log(`found     ${files.length} transcripts, ${sessions.size} sessions, ` +
    `${[...sessions.values()].reduce((n, s) => n + s.entries.length, 0)} turns`);
  if (!sessions.size) return;

  // Ask the hub what it already holds, and what time it thinks it is.
  const ids = [...sessions.keys()];
  const marks = {};
  let hubNow = null;
  for (let i = 0; i < ids.length; i += BATCH) {
    const j = await post('/hooks/internal/session-watermark', { session_ids: ids.slice(i, i + BATCH) });
    Object.assign(marks, j.marks);
    hubNow = hubNow || j.hub_now;
  }

  // The watermark is the hub's LOCAL time; transcript stamps are UTC. Derive the
  // offset from the hub's own clock rather than assuming both boxes share a zone.
  const offsetMs = hubNow
    ? Date.parse(hubNow.local.replace(' ', 'T') + 'Z') - Date.parse(hubNow.utc.replace(' ', 'T') + 'Z')
    : 0;
  console.log(`hub clock ${hubNow?.local} local / ${hubNow?.utc} utc  (offset ${offsetMs / 3600000}h)`);

  const sinceMs = SINCE ? Date.parse(SINCE + 'T00:00:00Z') : null;
  let known = 0, fresh = 0, sent = 0, written = 0, skipped = 0, failed = 0;
  const plan = [];

  for (const [id, s] of sessions) {
    const m = marks[id] || { last: null, events: 0 };
    if (m.events > 0) known++; else fresh++;

    // --fast only: skip anything at or before the newest thing the hub holds for
    // this session, converting that local watermark back to a UTC instant first.
    // The default sends everything and lets the hub's content dedupe decide, so
    // that a gap in the middle of a session is actually seen.
    const cutoff = !FAST || !m.last ? -Infinity : Date.parse(m.last.replace(' ', 'T') + 'Z') - offsetMs;
    let due = s.entries.filter((e) => Date.parse(e.ts) > cutoff);
    if (sinceMs !== null) due = due.filter((e) => Date.parse(e.ts) >= sinceMs);
    if (!due.length) continue;

    plan.push({ id, cwd: s.cwd, hubEvents: m.events, due: due.length, from: due[0].ts, to: due[due.length - 1].ts });
    if (DRY) { sent += due.length; continue; }

    for (let i = 0; i < due.length; i += 1000) {
      try {
        const j = await post('/hooks/internal/transcript-sync', {
          session_id: id, cwd: s.cwd, transcript_path: s.transcript_path,
          model: s.model, entries: due.slice(i, i + 1000),
        });
        written += j.written; skipped += j.skipped; sent += due.slice(i, i + 1000).length;
      } catch (err) {
        failed++;
        console.error(`  FAIL ${id.slice(0, 8)}: ${err.message}`);
      }
    }
  }

  console.log(`sessions  ${known} already in hub, ${fresh} never captured`);
  console.log(`\n${DRY ? 'WOULD SYNC' : 'SYNCED'} ${plan.length} sessions, ${sent} turns`);
  for (const p of plan.sort((a, b) => b.due - a.due).slice(0, 15)) {
    console.log(`  ${String(p.due).padStart(6)} turns  hub had ${String(p.hubEvents).padStart(6)}  ` +
      `${p.from.slice(0, 16)} .. ${p.to.slice(0, 16)}  ${p.cwd}`);
  }
  if (plan.length > 15) console.log(`  ... and ${plan.length - 15} more sessions`);
  if (!DRY) console.log(`\nwritten ${written}  skipped(dupe) ${skipped}  failed batches ${failed}`);
})().catch((e) => { console.error('sync failed:', e.message); process.exit(1); });
