// pan-notify.js — unified messaging channel from all ΠΑΝ services to the user
//
// Services call panNotify(service, subject, body) to drop a message into the
// ΠΑΝ contact thread. The user reads it in Comms (chat) or Mail (composed view).
// The user can reply and get a ΠΑΝ persona response (Cerebras, fast).
//
// Service sign-offs (use these exactly):
//   Scout      · 🔍   "Scout · 🔍"
//   Dream      · ✨   "Dream · ✨"
//   Pipeline   · 🔬   "Pipeline · 🔬"
//   Benchmark  · 📊   "Benchmark · 📊"
//   Memory     · 🧠   "Memory · 🧠"
//   ΠΑΝ System · ⚡   "ΠΑΝ · ⚡"

import { db } from './db.js';
import { claude } from './llm.js';

export const PAN_CONTACT_ID = 'contact-pan-system';
export const PAN_THREAD_ID  = 'thread-pan-system';

// ── Seed ΠΑΝ contact + thread (idempotent, call on boot) ─────────────────────
export function ensurePanContact() {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO contacts
        (id, pan_instance_id, display_name, status, favorited, avatar_url, notes)
      VALUES (?, 'pan-system', 'ΠΑΝ', 'online', 1, null,
              'Your personal AI network. Scout, Dream, Pipeline, Benchmark and all services report here.')
    `).run(PAN_CONTACT_ID);

    db.prepare(`
      INSERT OR IGNORE INTO chat_threads (id, type, name)
      VALUES (?, 'dm', 'ΠΑΝ')
    `).run(PAN_THREAD_ID);

    db.prepare(`
      INSERT OR IGNORE INTO chat_thread_members (thread_id, contact_id)
      VALUES (?, ?)
    `).run(PAN_THREAD_ID, PAN_CONTACT_ID);
  } catch (err) {
    // tables may not exist yet during early boot — safe to ignore
    console.warn('[ΠΑΝ-notify] ensurePanContact failed (tables not ready?):', err.message);
  }
}

// ── Post a system message into the ΠΑΝ thread ────────────────────────────────
// subject  = short one-line summary  (shown in contacts list + mail preview)
// body     = full detail message     (shown when user opens the message)
// opts.severity  = 'info' | 'warning' | 'critical'  (default: 'info')
// opts.metadata  = extra JSON fields stored with the message
export function panNotify(service, subject, body, opts = {}) {
  const { severity = 'info', metadata = {} } = opts;
  const msgId = `cmsg_pan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now   = Date.now();

  try {
    db.prepare(`
      INSERT INTO chat_messages
        (id, thread_id, sender_id, body, subject, body_type, message_type, channel, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, 'text', 'composed', 'pan', ?, ?)
    `).run(
      msgId,
      PAN_THREAD_ID,
      PAN_CONTACT_ID,
      body,
      subject,
      JSON.stringify({ service, severity, ...metadata }),
      now,
    );

    db.prepare(`UPDATE chat_threads SET updated_at = ? WHERE id = ?`).run(now, PAN_THREAD_ID);
    console.log(`[ΠΑΝ] ${service}: ${subject}`);
    return msgId;
  } catch (err) {
    console.warn('[ΠΑΝ-notify] panNotify failed:', err.message);
    return null;
  }
}

// ── ΠΑΝ persona reply ─────────────────────────────────────────────────────────
// Called when the user sends a message in the ΠΑΝ contact thread.
// Fetches recent context, calls Cerebras Qwen, stores + returns the reply.
export async function panReply(userMessage) {
  // Pull last 12 messages for context (oldest first after reverse)
  const recent = db.prepare(`
    SELECT sender_id, body, subject, metadata, created_at
    FROM chat_messages
    WHERE thread_id = ?
    ORDER BY created_at DESC
    LIMIT 12
  `).all(PAN_THREAD_ID).reverse();

  const contextLines = recent.map(m => {
    if (m.sender_id === 'self') return `You: ${m.body}`;
    const meta = tryJSON(m.metadata);
    const svc  = meta?.service || 'ΠΑΝ';
    const subj = m.subject ? `[${m.subject}] ` : '';
    return `${svc}: ${subj}${m.body.slice(0, 300)}`;
  }).join('\n');

  const prompt = `You are ΠΑΝ — a persistent personal AI operating system running across all the user's devices. You manage their digital life: voice commands, memory, benchmarks, code pipelines, and all system services.

Services that report to you:
• Scout 🔍 — researches broken things, finds fixes
• Dream ✨ — consolidates memories every 6 hours
• Pipeline 🔬 — validates code changes with 12 benchmark suites
• Benchmark 📊 — quality tests across memory, routing, privacy, latency
• Memory 🧠 — persistent knowledge graph

Recent thread context:
${contextLines || '(no recent activity)'}

The user just said: ${userMessage}

Reply as ΠΑΝ — direct, concise, with personality. Reference specific recent system activity if relevant. If they ask what's going on, summarise the recent messages. If they ask a question you can answer from context, answer it. Keep replies short (2-4 sentences) unless they ask for detail.`;

  let replyText;
  try {
    replyText = await claude(prompt, {
      caller: 'pan_persona',
      maxTokens: 400,
      timeout: 15000,
    });
  } catch {
    replyText = 'ΠΑΝ is thinking… try again in a moment.';
  }

  const replyId  = `cmsg_pan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const replyNow = Date.now();

  db.prepare(`
    INSERT INTO chat_messages
      (id, thread_id, sender_id, body, body_type, message_type, channel, metadata, created_at)
    VALUES (?, ?, ?, ?, 'text', 'quick', 'pan', ?, ?)
  `).run(
    replyId,
    PAN_THREAD_ID,
    PAN_CONTACT_ID,
    replyText,
    JSON.stringify({ service: 'ΠΑΝ · ⚡' }),
    replyNow,
  );

  db.prepare(`UPDATE chat_threads SET updated_at = ? WHERE id = ?`).run(replyNow, PAN_THREAD_ID);
  return { id: replyId, body: replyText, created_at: replyNow };
}

function tryJSON(s) { try { return JSON.parse(s); } catch { return {}; } }
