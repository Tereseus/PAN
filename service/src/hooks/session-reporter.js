#!/usr/bin/env node
/**
 * session-reporter.js — Stop hook. Tells PAN what a Claude session just did so
 * PAN can summarise it to the user by voice.
 *
 * The loop this completes:
 *   Claude finishes a turn  ->  this hook  ->  PAN summarises  ->  phone speaks
 *   ->  user replies by voice  ->  router pipes it back into the session.
 *
 * SCOPED ON PURPOSE. This does nothing unless the session's cwd matches the
 * allowlist. With ~13 Claude sessions running, reporting all of them would
 * rebuild notification hell with a voice. `pan_interjections` already carries
 * the scar of that: interjections #564..#581 fired within ~1.5h on 2026-05-27
 * because a dedupe silently never matched. Start with one project, watch it,
 * widen only if it earns it.
 *
 * Allowlist is a comma-separated list of case-insensitive substrings matched
 * against cwd, from either:
 *   env  PAN_SESSION_REPORT_MATCH=WoE
 *   or the `session_report_match` setting, read server-side.
 * Empty/unset = report nothing.
 *
 * Wire in ~/.claude/settings.json under Stop hooks. Always exit(0): a Stop hook
 * that throws breaks the chain for every other hook behind it.
 */

import fs from 'fs';

const PAN_BASE = process.env.PAN_BASE || 'http://127.0.0.1:7777';
const MATCH    = (process.env.PAN_SESSION_REPORT_MATCH || '').trim();
const MAX_TEXT = 1200;   // plenty for a summary; keeps the POST small

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

/**
 * Last assistant turn + whether this turn did work or just talked.
 * Claude Code writes the transcript as JSONL, one message per line.
 */
function readLastTurn(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  let lastAssistantText = '';
  let usedTools = false;
  let lastUserText = '';

  // Walk backwards; stop once we have the last assistant turn and the user
  // prompt that triggered it.
  for (let i = lines.length - 1; i >= 0 && (!lastAssistantText || !lastUserText); i--) {
    let msg;
    try { msg = JSON.parse(lines[i]); } catch { continue; }
    const role = msg.message?.role || msg.role;
    const content = msg.message?.content ?? msg.content;

    if (role === 'assistant' && !lastAssistantText) {
      if (Array.isArray(content)) {
        if (content.some((c) => c.type === 'tool_use')) usedTools = true;
        lastAssistantText = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      } else if (typeof content === 'string') {
        lastAssistantText = content.trim();
      }
    } else if (role === 'user' && !lastUserText) {
      if (typeof content === 'string') lastUserText = content.trim();
      else if (Array.isArray(content)) {
        lastUserText = content.filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
      }
    }
  }
  return { lastAssistantText, lastUserText, usedTools };
}

async function main() {
  if (!MATCH) process.exit(0);   // not configured — do nothing, cheaply

  let payload;
  try { payload = JSON.parse(readStdin() || '{}'); } catch { process.exit(0); }

  const sessionId = payload.session_id;
  const cwd = payload.cwd || '';
  const transcriptPath = payload.transcript_path;
  if (!sessionId || !transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

  // The gate. Substring match on cwd so "WoE" catches any session in that tree.
  const needles = MATCH.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const cwdLower = cwd.toLowerCase();
  if (!needles.some((n) => cwdLower.includes(n))) process.exit(0);

  let turn;
  try { turn = readLastTurn(transcriptPath); } catch { process.exit(0); }
  if (!turn.lastAssistantText) process.exit(0);

  // "Blocked on you" is the highest-value thing to interrupt for: the session
  // asked something and is now idle until you answer. A turn that ended after
  // tool use is progress; a short text-only turn ending in a question is a
  // request for input.
  const endsWithQuestion = /\?\s*$/.test(turn.lastAssistantText);
  const kind = endsWithQuestion && !turn.usedTools ? 'blocked'
             : turn.usedTools ? 'progress'
             : 'completed';

  const body = JSON.stringify({
    session_id: sessionId,
    cwd,
    project: cwd.split(/[\\/]/).filter(Boolean).pop() || 'unknown',
    kind,
    used_tools: turn.usedTools,
    last_user_text: turn.lastUserText.slice(0, 300),
    assistant_text: turn.lastAssistantText.slice(0, MAX_TEXT),
  });

  try {
    const res = await fetch(`${PAN_BASE}/hooks/internal/session-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) console.error(`[session-reporter] POST failed: ${res.status}`);
  } catch (e) {
    console.error(`[session-reporter] POST error: ${e.message}`);
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
