import { all, insert } from './db.js';
import { claude } from './claude.js';

let timer = null;

const CLASSIFICATION_PROMPT = `You are PAN's classification engine. PAN remembers everything.

Given these Claude Code session events, extract any meaningful items the user would want to remember later. Be thorough — capture ideas, decisions, tasks, questions, bugs, personal notes, project updates, conversation summaries, shopping lists, and anything else noteworthy.

For each item return a JSON object with:
- item_type: one of (idea, decision, task, question, bug, grocery_list, personal_note, project_update, code_pattern, conversation_summary, design_decision, feature_request, reference)
- content: a clear, concise description of the item
- context: brief surrounding context (what project, what was being discussed)
- confidence: 0.0-1.0 how confident you are this is worth remembering

Return a JSON array of items. If nothing worth extracting, return [].
Only return the JSON array, no other text.`;

async function classify() {
  const events = all(`
    SELECT e.id, e.session_id, e.event_type, e.data, e.created_at, s.cwd
    FROM events e
    JOIN sessions s ON s.id = e.session_id
    LEFT JOIN memory_items m ON m.event_id = e.id
    WHERE m.id IS NULL
      AND e.event_type IN ('Stop', 'UserPromptSubmit')
    ORDER BY e.created_at ASC
    LIMIT 20
  `);

  if (events.length === 0) return;

  console.log(`[PAN] Classifying ${events.length} events...`);

  const eventSummaries = events.map(e => {
    const data = JSON.parse(e.data);
    return {
      id: e.id,
      type: e.event_type,
      cwd: e.cwd,
      message: (data.last_assistant_message || '').slice(0, 300),
      prompt: (data.prompt || '').slice(0, 300),
      timestamp: e.created_at
    };
  });

  try {
    const fullPrompt = `${CLASSIFICATION_PROMPT}\n\nEvents:\n${JSON.stringify(eventSummaries, null, 2)}`;
    const text = await claude(fullPrompt, { model: 'claude-haiku-4-5-20251001', timeout: 60000, maxTokens: 2000 });

    let items;
    try {
      items = JSON.parse(text);
    } catch {
      console.error('[PAN] Classification returned invalid JSON:', text.slice(0, 200));
      return;
    }

    if (!Array.isArray(items)) items = [];

    // Insert extracted items
    for (const item of items) {
      insert(`INSERT INTO memory_items (session_id, event_id, item_type, content, context, confidence, classified_at)
        VALUES (:sid, :eid, :type, :content, :ctx, :conf, datetime('now','localtime'))`, {
        ':sid': events[0].session_id,
        ':eid': events[0].id,
        ':type': item.item_type || 'unknown',
        ':content': (item.content || '').slice(0, 500),
        ':ctx': item.context ? JSON.stringify(item.context).slice(0, 200) : null,
        ':conf': item.confidence || 0.5
      });
    }

    // Mark ALL processed events so they don't get re-classified
    for (const e of events) {
      // Insert a "classified" marker if no items were linked to this event
      const hasItem = items.length > 0; // simplified — items link to events[0] only
      if (!hasItem) {
        insert(`INSERT INTO memory_items (session_id, event_id, item_type, content, confidence, classified_at)
          VALUES (:sid, :eid, 'none', 'no extractable items', 0, datetime('now','localtime'))`, {
          ':sid': e.session_id,
          ':eid': e.id
        });
      }
    }

    console.log(`[PAN] Classified ${items.length} memory items from ${events.length} events`);
  } catch (err) {
    console.error('[PAN] Classification error:', err.message);
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
