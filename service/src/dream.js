// PAN Auto-Dream — overnight memory consolidation
//
// Runs periodically (default: every 6 hours) to review recent events,
// extract key decisions/facts/preferences, and consolidate into structured memory.
// Like sleeping and dreaming — processes the day's experiences into long-term memory.

import { all, get, insert, run } from './db.js';

let dreamInterval = null;

async function dream() {
  console.log('[PAN Dream] Starting memory consolidation...');

  try {
    const { claude } = await import('./claude.js');

    // Get events since last dream (or last 12 hours)
    const lastDream = get("SELECT MAX(created_at) as t FROM events WHERE event_type = 'DreamCycle'");
    const since = lastDream?.t || new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    const events = all(
      `SELECT id, event_type, data, created_at FROM events
       WHERE created_at > :since
       AND event_type NOT IN ('SessionStart', 'SessionEnd', 'DreamCycle', 'MobileSend')
       ORDER BY created_at ASC`,
      { ':since': since }
    );

    if (events.length < 5) {
      console.log(`[PAN Dream] Only ${events.length} events since last dream — skipping`);
      return;
    }

    // Extract clean text from events
    const entries = [];
    for (const e of events) {
      let data = {};
      try { data = JSON.parse(e.data); } catch { continue; }

      let text = null;
      if (e.event_type === 'RouterCommand') {
        const q = data.text || '';
        const a = data.result || data.response_text || '';
        if (q) text = `Voice Q: ${q}\nA: ${a}`;
      } else if (e.event_type === 'UserPromptSubmit') {
        const p = data.prompt || '';
        if (p.length >= 20 && !p.startsWith('{')) text = `User: ${p}`;
      } else if (e.event_type === 'Stop') {
        const m = data.last_assistant_message || '';
        if (m.length >= 30) text = `Claude: ${m}`;
      } else if (e.event_type === 'VisionAnalysis') {
        const d = data.description || '';
        if (d) text = `Saw: ${d}`;
      }

      if (text) entries.push(`[${e.created_at}] ${text.slice(0, 500)}`);
    }

    if (entries.length < 3) {
      console.log(`[PAN Dream] Only ${entries.length} meaningful entries — skipping`);
      return;
    }

    // Build context — cap at ~40K chars (~10K tokens)
    let context = '';
    for (const entry of entries) {
      if (context.length + entry.length > 40000) break;
      context += entry + '\n\n';
    }

    // Get existing memories to avoid duplicates
    const existingMemories = all("SELECT content FROM memory_items WHERE item_type IN ('decision', 'preference', 'fact', 'insight') ORDER BY created_at DESC LIMIT 30");
    const existingContext = existingMemories.map(m => m.content).join('\n');

    // Ask Haiku to extract structured memories
    const result = await claude(
      `You are PAN's memory consolidation system. Review these ${entries.length} recent events and extract important information worth remembering long-term.

${existingContext ? `EXISTING MEMORIES (don't duplicate these):\n${existingContext}\n\n` : ''}RECENT EVENTS:\n${context}

Extract memories as a JSON array. Each memory should be:
- type: "decision" (choices made), "preference" (user likes/dislikes), "fact" (learned info), "insight" (patterns noticed), "task" (action items), "bug" (issues found)
- content: concise description (1-2 sentences)
- confidence: 0.0-1.0 (how certain this is important)

Only extract things worth remembering weeks/months from now. Skip trivial interactions, debugging noise, and things already in existing memories.

Output ONLY valid JSON array, nothing else. If nothing worth remembering, output [].`,
      { maxTokens: 2000, timeout: 45000 }
    );

    let memories = [];
    try {
      memories = JSON.parse(result);
    } catch {
      console.log('[PAN Dream] Failed to parse Haiku response:', result.slice(0, 200));
      return;
    }

    if (!Array.isArray(memories) || memories.length === 0) {
      console.log('[PAN Dream] No new memories to consolidate');
    } else {
      let saved = 0;
      for (const m of memories) {
        if (!m.content || !m.type) continue;
        insert(`INSERT INTO memory_items (item_type, content, confidence, classified_at, created_at)
          VALUES (:type, :content, :conf, datetime('now','localtime'), datetime('now','localtime'))`, {
          ':type': m.type,
          ':content': m.content.slice(0, 500),
          ':conf': m.confidence || 0.5
        });
        saved++;
      }
      console.log(`[PAN Dream] Consolidated ${saved} memories from ${entries.length} events`);
    }

    // Log the dream cycle
    insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
      ':sid': 'system-dream',
      ':type': 'DreamCycle',
      ':data': JSON.stringify({
        events_reviewed: events.length,
        entries_processed: entries.length,
        memories_created: memories.length,
        since,
        timestamp: Date.now()
      })
    });

  } catch (err) {
    console.error('[PAN Dream] Error:', err.message);
  }
}

function startDream(intervalMs = 6 * 60 * 60 * 1000) {
  // Run first dream after 2 minutes (let other systems settle)
  setTimeout(() => {
    dream();
    dreamInterval = setInterval(dream, intervalMs);
  }, 120000);
  console.log(`[PAN Dream] Scheduled every ${Math.round(intervalMs / 3600000)}h`);
}

function stopDream() {
  if (dreamInterval) clearInterval(dreamInterval);
  dreamInterval = null;
}

export { dream, startDream, stopDream };
