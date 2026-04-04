// PAN Semantic Memory — knowledge graph with contradiction detection
//
// Stores subject-predicate-object triples with embeddings.
// When a new fact contradicts an existing one (same subject, >0.85 similarity,
// different object), the old fact is superseded automatically.

import { all, get, insert, run } from '../db.js';
import { embed, cosineSimilarity, toBlob, fromBlob } from './embeddings.js';

// Store a new fact with automatic contradiction detection
async function store(fact) {
  const {
    subject,
    predicate,
    object,
    description = '',
    category = 'domain_knowledge',
    confidence = 0.8,
  } = fact;

  const text = description || `${subject} ${predicate} ${object}`;
  const embedding = await embed(text);

  // Check for contradictions — same subject, high similarity, different object
  const existing = all(
    `SELECT * FROM semantic_facts WHERE subject = :subject AND valid_until IS NULL`,
    { ':subject': subject }
  );

  for (const ex of existing) {
    const exEmbedding = fromBlob(ex.embedding);
    const sim = exEmbedding ? cosineSimilarity(embedding, exEmbedding) : 0;

    if (sim > 0.85 && ex.object !== object) {
      // Contradiction detected — supersede old fact
      console.log(`[PAN Memory] Contradiction: "${subject} ${ex.predicate} ${ex.object}" superseded by "${subject} ${predicate} ${object}"`);
      run(
        `UPDATE semantic_facts SET valid_until = datetime('now','localtime') WHERE id = :id`,
        { ':id': ex.id }
      );

      // New fact references old one
      return insert(
        `INSERT INTO semantic_facts (subject, predicate, object, description, category, confidence, version, previous_version_id, embedding)
         VALUES (:subject, :predicate, :object, :desc, :category, :confidence, :version, :prev, :embedding)`,
        {
          ':subject': subject,
          ':predicate': predicate,
          ':object': object,
          ':desc': description,
          ':category': category,
          ':confidence': confidence,
          ':version': ex.version + 1,
          ':prev': ex.id,
          ':embedding': toBlob(embedding),
        }
      );
    }

    // Exact duplicate — skip
    if (ex.predicate === predicate && ex.object === object) {
      return ex.id;
    }
  }

  // No contradiction — store as new fact
  return insert(
    `INSERT INTO semantic_facts (subject, predicate, object, description, category, confidence, embedding)
     VALUES (:subject, :predicate, :object, :desc, :category, :confidence, :embedding)`,
    {
      ':subject': subject,
      ':predicate': predicate,
      ':object': object,
      ':desc': description,
      ':category': category,
      ':confidence': confidence,
      ':embedding': toBlob(embedding),
    }
  );
}

// Retrieve facts by semantic search
async function recall(query, { limit = 10, category = null } = {}) {
  const queryEmbedding = await embed(query);

  let sql = `SELECT * FROM semantic_facts WHERE valid_until IS NULL`;
  const params = {};
  if (category) {
    sql += ` AND category = :category`;
    params[':category'] = category;
  }
  sql += ` ORDER BY created_at DESC LIMIT 300`;

  const candidates = all(sql, params);

  const scored = candidates.map(fact => {
    const factEmbedding = fromBlob(fact.embedding);
    const similarity = factEmbedding ? cosineSimilarity(queryEmbedding, factEmbedding) : 0;
    return { ...fact, similarity };
  });

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

// Get all active facts (no embedding needed)
function getActive(category = null) {
  if (category) {
    return all(
      `SELECT * FROM semantic_facts WHERE valid_until IS NULL AND category = :cat ORDER BY confidence DESC`,
      { ':cat': category }
    );
  }
  return all(`SELECT * FROM semantic_facts WHERE valid_until IS NULL ORDER BY confidence DESC`);
}

// Get fact history for a subject (including superseded facts)
function getHistory(subject) {
  return all(
    `SELECT * FROM semantic_facts WHERE subject = :subject ORDER BY version DESC`,
    { ':subject': subject }
  );
}

function count() {
  return get('SELECT COUNT(*) as c FROM semantic_facts WHERE valid_until IS NULL')?.c || 0;
}

export { store, recall, getActive, getHistory, count };
