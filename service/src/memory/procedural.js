// PAN Procedural Memory — learned multi-step procedures
//
// Stores procedures with triggers, steps, preconditions.
// Tracks success/failure rates for confidence scoring.

import { all, get, insert, run } from '../db.js';
import { embed, cosineSimilarity, toBlob, fromBlob } from './embeddings.js';

// Store a new procedure
async function store(procedure) {
  const {
    name,
    description,
    triggerPattern = '',
    steps = [],
    preconditions = [],
    postconditions = [],
  } = procedure;

  const text = `${name} ${description} ${triggerPattern}`;
  const embedding = await embed(text);

  // Check for existing procedure with same name — update instead
  const existing = get(`SELECT * FROM procedural_memories WHERE name = :name`, { ':name': name });
  if (existing) {
    run(
      `UPDATE procedural_memories SET description = :desc, trigger_pattern = :trigger, steps = :steps,
       preconditions = :pre, postconditions = :post, embedding = :embedding WHERE id = :id`,
      {
        ':desc': description,
        ':trigger': triggerPattern,
        ':steps': JSON.stringify(steps),
        ':pre': JSON.stringify(preconditions),
        ':post': JSON.stringify(postconditions),
        ':embedding': toBlob(embedding),
        ':id': existing.id,
      }
    );
    return existing.id;
  }

  return insert(
    `INSERT INTO procedural_memories (name, description, trigger_pattern, steps, preconditions, postconditions, embedding)
     VALUES (:name, :desc, :trigger, :steps, :pre, :post, :embedding)`,
    {
      ':name': name,
      ':desc': description,
      ':trigger': triggerPattern,
      ':steps': JSON.stringify(steps),
      ':pre': JSON.stringify(preconditions),
      ':post': JSON.stringify(postconditions),
      ':embedding': toBlob(embedding),
    }
  );
}

// Find relevant procedures for a task
async function recall(taskDescription, { limit = 5 } = {}) {
  const queryEmbedding = await embed(taskDescription);

  const candidates = all(`SELECT * FROM procedural_memories ORDER BY success_count DESC LIMIT 100`);

  const scored = candidates.map(proc => {
    const procEmbedding = fromBlob(proc.embedding);
    const similarity = procEmbedding ? cosineSimilarity(queryEmbedding, procEmbedding) : 0;
    const total = proc.success_count + proc.failure_count;
    const confidence = total > 0 ? proc.success_count / total : 0.5;
    const score = similarity * 0.6 + confidence * 0.4;
    return { ...proc, score, similarity, confidence, steps: JSON.parse(proc.steps || '[]') };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Record success/failure for a procedure
function recordOutcome(id, success) {
  if (success) {
    run(`UPDATE procedural_memories SET success_count = success_count + 1, last_used = datetime('now','localtime') WHERE id = :id`, { ':id': id });
  } else {
    run(`UPDATE procedural_memories SET failure_count = failure_count + 1, last_used = datetime('now','localtime') WHERE id = :id`, { ':id': id });
  }
}

function count() {
  return get('SELECT COUNT(*) as c FROM procedural_memories')?.c || 0;
}

export { store, recall, recordOutcome, count };
