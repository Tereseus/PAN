// PAN Episodic Memory — records of what happened
//
// Each episode: summary, detail, type, outcome, importance, decay.
// Retrieved by hybrid scoring: vector similarity + recency + importance.

import { all, get, insert, run } from '../db.js';
import { embed, cosineSimilarity, toBlob, fromBlob } from './embeddings.js';

// Store a new episode
async function store(episode) {
  const {
    summary,
    detail = '',
    type = 'interaction',
    outcome = 'success',
    importance = 0.5,
    sessionId = null,
    projectId = null,
  } = episode;

  const text = `${summary} ${detail}`.trim();
  const embedding = await embed(text);

  return insert(
    `INSERT INTO episodic_memories (summary, detail, episode_type, outcome, importance, session_id, project_id, embedding)
     VALUES (:summary, :detail, :type, :outcome, :importance, :sid, :pid, :embedding)`,
    {
      ':summary': summary,
      ':detail': detail,
      ':type': type,
      ':outcome': outcome,
      ':importance': importance,
      ':sid': sessionId,
      ':pid': projectId,
      ':embedding': toBlob(embedding),
    }
  );
}

// Retrieve episodes by semantic similarity with hybrid scoring
async function recall(query, { limit = 10, strategy = 'recency', minImportance = 0, projectId = null } = {}) {
  const queryEmbedding = await embed(query);

  // Get candidates — recent + important episodes
  let sql = `SELECT * FROM episodic_memories WHERE 1=1`;
  const params = {};
  if (minImportance > 0) {
    sql += ` AND importance >= :minImp`;
    params[':minImp'] = minImportance;
  }
  if (projectId) {
    sql += ` AND (project_id = :pid OR project_id IS NULL)`;
    params[':pid'] = projectId;
  }
  sql += ` ORDER BY created_at DESC LIMIT 500`;

  const candidates = all(sql, params);

  // Score each candidate
  const scored = candidates.map(ep => {
    const epEmbedding = fromBlob(ep.embedding);
    const similarity = epEmbedding ? cosineSimilarity(queryEmbedding, epEmbedding) : 0;

    const hoursSince = (Date.now() - new Date(ep.created_at).getTime()) / 3600000;
    const recencyScore = Math.exp(-0.01 * hoursSince);

    // Strategy weights
    let score;
    if (strategy === 'similarity') {
      score = similarity * 0.7 + recencyScore * 0.1 + ep.importance * 0.2;
    } else if (strategy === 'temporal') {
      score = similarity * 0.2 + recencyScore * 0.6 + ep.importance * 0.2;
    } else {
      // 'recency' — balanced default
      score = similarity * 0.4 + recencyScore * 0.35 + ep.importance * 0.25;
    }

    return { ...ep, score, similarity };
  });

  // Sort by score, return top N
  scored.sort((a, b) => b.score - a.score);

  // Update access counts for returned results
  const results = scored.slice(0, limit);
  for (const ep of results) {
    run(`UPDATE episodic_memories SET access_count = access_count + 1, last_accessed = datetime('now','localtime') WHERE id = :id`,
      { ':id': ep.id });
  }

  return results;
}

// Get recent episodes (no embedding needed)
function getRecent(limit = 20, projectId = null) {
  let sql = `SELECT * FROM episodic_memories`;
  const params = {};
  if (projectId) {
    sql += ` WHERE (project_id = :pid OR project_id IS NULL)`;
    params[':pid'] = projectId;
  }
  sql += ` ORDER BY created_at DESC LIMIT :limit`;
  params[':limit'] = limit;
  return all(sql, params);
}

// Count episodes
function count() {
  return get('SELECT COUNT(*) as c FROM episodic_memories')?.c || 0;
}

export { store, recall, getRecent, count };
