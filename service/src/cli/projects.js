import { all } from '../db.js';

export default function cmdProjects() {
  const projects = all(`
    SELECT p.*, COUNT(s.id) as session_count
    FROM projects p
    LEFT JOIN sessions s ON s.project_id = p.id
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `);

  if (projects.length === 0) {
    console.log('\n[PAN] No projects detected yet. Start using Claude Code and PAN will auto-detect them.\n');
    return;
  }

  console.log('\n=== PAN Projects ===');
  for (const p of projects) {
    console.log(`\n  ${p.name}`);
    console.log(`    Path:     ${p.path}`);
    console.log(`    Sessions: ${p.session_count}`);
    if (p.description) console.log(`    Desc:     ${p.description}`);
    console.log(`    Created:  ${p.created_at}`);
  }
  console.log('');
}
