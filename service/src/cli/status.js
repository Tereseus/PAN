import { get, all } from '../db.js';

export default function cmdStatus() {
  const stats = get(`
    SELECT
      (SELECT COUNT(*) FROM sessions) as total_sessions,
      (SELECT COUNT(*) FROM events) as total_events,
      (SELECT COUNT(*) FROM projects) as total_projects,
      (SELECT COUNT(*) FROM memory_items) as total_memory_items
  `);

  const recent = all(`
    SELECT e.event_type, e.created_at, s.cwd
    FROM events e
    JOIN sessions s ON s.id = e.session_id
    ORDER BY e.created_at DESC
    LIMIT 10
  `);

  console.log('\n=== PAN Status ===');
  console.log(`Sessions:     ${stats.total_sessions}`);
  console.log(`Events:       ${stats.total_events}`);
  console.log(`Projects:     ${stats.total_projects}`);
  console.log(`Memory Items: ${stats.total_memory_items}`);

  if (recent.length > 0) {
    console.log('\n--- Recent Events ---');
    for (const e of recent) {
      const time = (e.created_at || '').slice(0, 19);
      console.log(`  ${time}  ${(e.event_type || '').padEnd(18)}  ${e.cwd}`);
    }
  }
  console.log('');
}
