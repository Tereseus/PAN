// PAN Classifier — processes events and updates the living state document
//
// Runs every 5 minutes. Instead of creating individual memory_items rows,
// it marks events as processed and triggers a state file update when enough
// new meaningful events have accumulated.

import { all, get, insert } from './db.js';
import { dream } from './dream.js';

let timer = null;
let eventsSinceLastUpdate = 0;

async function classify() {
  // Find unprocessed events (ones not yet marked in memory_items)
  const events = all(`
    SELECT e.id, e.session_id, e.event_type, e.data, e.created_at
    FROM events e
    LEFT JOIN memory_items m ON m.event_id = e.id
    WHERE m.id IS NULL
      AND e.event_type IN ('Stop', 'UserPromptSubmit')
    ORDER BY e.created_at ASC
    LIMIT 20
  `);

  if (events.length === 0) return;

  console.log(`[PAN] Processing ${events.length} events...`);

  // Mark all events as processed (just a marker, no classification needed)
  for (const e of events) {
    insert(`INSERT INTO memory_items (session_id, event_id, item_type, content, confidence, classified_at)
      VALUES (:sid, :eid, 'processed', 'event processed', 0, datetime('now','localtime'))`, {
      ':sid': e.session_id,
      ':eid': e.id
    });
  }

  eventsSinceLastUpdate += events.length;
  console.log(`[PAN] Marked ${events.length} events as processed (${eventsSinceLastUpdate} since last state update)`);

  // Trigger a state file update if enough events accumulated
  if (eventsSinceLastUpdate >= 10) {
    console.log('[PAN] Triggering state file update...');
    eventsSinceLastUpdate = 0;
    try {
      await dream();
    } catch (err) {
      console.error('[PAN] State update error:', err.message);
    }
  }
}

function startClassifier(intervalMs) {
  setTimeout(() => classify().catch(console.error), 10000);
  timer = setInterval(() => classify().catch(console.error), intervalMs);
  console.log(`[PAN] Classifier running every ${intervalMs / 1000}s`);
}

function stopClassifier() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export { classify, startClassifier, stopClassifier };
