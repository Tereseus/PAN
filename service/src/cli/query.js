import { all } from '../db.js';

export default function cmdQuery(args) {
  const queryText = args.join(' ').trim();

  if (!queryText) {
    console.log('Usage: pan query <search text>');
    return;
  }

  const results = all(`
    SELECT m.*, p.name as project_name
    FROM memory_items m
    LEFT JOIN sessions s ON s.id = m.session_id
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE m.content LIKE :q OR m.context LIKE :q
    ORDER BY m.created_at DESC
    LIMIT 20
  `, { ':q': `%${queryText}%` });

  if (results.length === 0) {
    console.log(`\n[PAN] No memory items matching "${queryText}"\n`);
    return;
  }

  console.log(`\n=== PAN Memory: "${queryText}" (${results.length} results) ===`);
  for (const m of results) {
    const time = (m.created_at || '').slice(0, 19);
    const project = m.project_name || 'unlinked';
    console.log(`\n  [${m.item_type}] ${m.content}`);
    console.log(`    Project: ${project}  |  ${time}  |  Confidence: ${m.confidence}`);
  }
  console.log('');
}
