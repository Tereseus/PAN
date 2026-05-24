#!/usr/bin/env node
/**
 * behavioral-lock-breaker.js — Stop hook that breaks Claude out of stock-reply loops.
 *
 * Symptom this fixes (bug #769): Claude parks itself in a "standing by, waiting
 * for 'go'" stock state. The user sends 3+ short probes (test / ping / hi /
 * "what happened") to check if Claude is alive. Each probe gets a near-identical
 * stock reply. Five times in a row today (2026-05-22). The user thinks Claude
 * crashed but actually the channel works — Claude is just behaviorally locked.
 *
 * What this hook does:
 *   1. After every assistant turn (Stop event), read the last ~6 turns from the
 *      session JSONL transcript.
 *   2. Skip turns where the assistant used tools (real work, not stock reply).
 *   3. If the last 3 text-only assistant replies are pairwise similar (Jaccard
 *      > 0.65 + length within 25%) AND the last 3 user prompts are each ≤25
 *      chars AND ≥5 minutes have elapsed since the first repeat AND we haven't
 *      already nudged this session in the last 10 min → POST a row into the
 *      session_nudges table via the PAN server's internal endpoint.
 *   4. The UPS handler (routes/hooks.js) reads pending nudges on the next
 *      UserPromptSubmit and returns them as additionalContext, which Claude
 *      Code prepends to the user prompt before the model sees it. Loop broken
 *      on turn N+1 instead of turn ∞.
 *
 * Wired in ~/.claude/settings.json under Stop hooks, AFTER skill-learner.js.
 * Always exit(0) — never break the Stop chain.
 */

import fs from 'fs';

const NUDGE_TEXT =
  "[PAN behavioral-lock breaker] You've replied with near-identical text " +
  "3+ times to short user probes. The user is testing if you're alive because " +
  "they think you're stuck. STOP saying 'standing by'. Either (a) resume the " +
  "parked task now without asking, or (b) acknowledge in one short line that " +
  "you parked, and ask one specific question about what to do next. Do NOT " +
  "repeat the previous reply.";

// Tuning knobs (env override for testing)
const JACCARD_MIN      = Number(process.env.BLB_JACCARD_MIN || 0.65);
const LEN_RATIO_MIN    = Number(process.env.BLB_LEN_RATIO_MIN || 0.75);
const SHORT_PROMPT_MAX = Number(process.env.BLB_SHORT_PROMPT_MAX || 25);
const ELAPSED_MIN_S    = Number(process.env.BLB_ELAPSED_MIN_S || 300);    // 5 min
const COOLDOWN_S       = Number(process.env.BLB_COOLDOWN_S || 600);       // 10 min
const SESSION_AGE_MIN_S = Number(process.env.BLB_SESSION_AGE_MIN_S || 60);
const PAN_BASE = process.env.PAN_BASE || 'http://127.0.0.1:7777';

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^\w\s]+/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0)
  );
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return inter / union;
}

function similar(textA, textB) {
  const ta = tokenize(textA);
  const tb = tokenize(textB);
  if (jaccard(ta, tb) < JACCARD_MIN) return false;
  const la = (textA || '').length;
  const lb = (textB || '').length;
  if (la === 0 || lb === 0) return la === lb;
  const ratio = Math.min(la, lb) / Math.max(la, lb);
  return ratio >= LEN_RATIO_MIN;
}

/**
 * Walk JSONL backward. Build a chronologically-ordered list of {role, text, ts, hadTool}.
 * Only include text content. Mark assistant turns that had any tool_use in them
 * (we'll skip those when looking for "stock reply" patterns).
 */
function parseTranscript(jsonlPath, maxLines = 200) {
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = raw.trim().split('\n');
  const turns = [];
  const startIdx = Math.max(0, lines.length - maxLines);
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'user') {
      const content = obj.message?.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text' && c.text) text += c.text;
        }
      }
      text = text.trim();
      // Skip synthetic <task-notification> reinjections (they look like prompts but aren't)
      if (text && !text.startsWith('<task-notification>') && !text.startsWith('<system-reminder>')) {
        turns.push({ role: 'user', text, ts: obj.timestamp || null });
      }
    } else if (obj.type === 'assistant') {
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      let text = '';
      let hadTool = false;
      for (const c of content) {
        if (c.type === 'text' && c.text) text += c.text;
        if (c.type === 'tool_use') hadTool = true;
      }
      text = text.trim();
      if (text || hadTool) {
        turns.push({ role: 'assistant', text, ts: obj.timestamp || null, hadTool });
      }
    }
  }
  return turns;
}

function detectLock(turns) {
  // Need at least 3 user prompts and 3 text-only assistant turns at the end.
  const lastAssistants = turns.filter(t => t.role === 'assistant' && !t.hadTool && t.text);
  const lastUsers = turns.filter(t => t.role === 'user' && t.text);
  if (lastAssistants.length < 3 || lastUsers.length < 3) {
    return { locked: false, reason: 'insufficient turns' };
  }

  const a3 = lastAssistants.slice(-3);
  const u3 = lastUsers.slice(-3);

  // Each of the last 3 user prompts must be short
  for (const u of u3) {
    if (u.text.length > SHORT_PROMPT_MAX) {
      return { locked: false, reason: `user prompt too long (${u.text.length} chars)` };
    }
  }

  // Pairwise similarity check on the 3 assistant replies
  if (!similar(a3[0].text, a3[1].text)) return { locked: false, reason: 'a0~a1 not similar' };
  if (!similar(a3[1].text, a3[2].text)) return { locked: false, reason: 'a1~a2 not similar' };
  if (!similar(a3[0].text, a3[2].text)) return { locked: false, reason: 'a0~a2 not similar' };

  // Elapsed time check — from first of the 3 to now
  const firstTs = a3[0].ts ? Date.parse(a3[0].ts) : null;
  const nowMs = Date.now();
  if (firstTs && (nowMs - firstTs) / 1000 < ELAPSED_MIN_S) {
    return { locked: false, reason: `elapsed ${(nowMs - firstTs) / 1000}s < ${ELAPSED_MIN_S}s` };
  }

  // Session age — don't fire on cold start
  const earliest = turns[0]?.ts ? Date.parse(turns[0].ts) : null;
  if (earliest && (nowMs - earliest) / 1000 < SESSION_AGE_MIN_S) {
    return { locked: false, reason: 'session too young' };
  }

  return {
    locked: true,
    meta: {
      jaccard: [
        +jaccard(tokenize(a3[0].text), tokenize(a3[1].text)).toFixed(3),
        +jaccard(tokenize(a3[1].text), tokenize(a3[2].text)).toFixed(3),
        +jaccard(tokenize(a3[0].text), tokenize(a3[2].text)).toFixed(3),
      ],
      reply_lens: a3.map(a => a.text.length),
      prompt_lens: u3.map(u => u.text.length),
      elapsed_s: firstTs ? Math.round((nowMs - firstTs) / 1000) : null,
    },
  };
}

async function postNudge(sessionId, meta) {
  const body = JSON.stringify({
    session_id: sessionId,
    kind: 'behavioral_lock',
    body: NUDGE_TEXT,
    detector_meta: JSON.stringify(meta),
    cooldown_s: COOLDOWN_S,
  });
  try {
    const res = await fetch(`${PAN_BASE}/hooks/internal/session-nudges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) {
      console.error(`[behavioral-lock] POST failed: ${res.status} ${res.statusText}`);
    } else {
      const j = await res.json().catch(() => ({}));
      console.log(`[behavioral-lock] nudge enqueued for session=${sessionId.slice(0, 8)} (id=${j.id ?? '?'}, ${j.skipped ? 'cooldown-skipped' : 'inserted'})`);
    }
  } catch (err) {
    console.error(`[behavioral-lock] POST error: ${err.message}`);
  }
}

async function main() {
  let payload = {};
  try {
    const raw = fs.readFileSync(0, 'utf-8'); // stdin
    payload = JSON.parse(raw || '{}');
  } catch {
    process.exit(0);
  }

  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  if (!sessionId || !transcriptPath || !fs.existsSync(transcriptPath)) {
    process.exit(0);
  }

  let turns;
  try {
    turns = parseTranscript(transcriptPath);
  } catch (err) {
    console.error(`[behavioral-lock] parse error: ${err.message}`);
    process.exit(0);
  }

  const verdict = detectLock(turns);
  if (!verdict.locked) {
    // Quiet by default; uncomment when tuning
    // console.log(`[behavioral-lock] no-fire session=${sessionId.slice(0,8)} reason=${verdict.reason}`);
    process.exit(0);
  }

  console.log(`[behavioral-lock] LOCK detected session=${sessionId.slice(0, 8)} meta=${JSON.stringify(verdict.meta)}`);
  await postNudge(sessionId, verdict.meta);
  process.exit(0);
}

main().catch(err => {
  console.error(`[behavioral-lock] fatal: ${err.message}`);
  process.exit(0);
});
