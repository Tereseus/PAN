// Tier 0 migration runner — CLI entry point.
//
// Usage:
//   node service/src/migrations/run.js          # live migration with backup + verify
//   node service/src/migrations/run.js --dry     # dry run, no writes
//
// Calls tier0-org-foundation.js which handles:
//   1. Pre-flight checks (DB exists, disk space, no existing backup)
//   2. Backup pan.db -> pan.db.pre-tier0.bak
//   3. Snapshot row counts
//   4. CREATE TABLE + ALTER TABLE + backfill (in transaction)
//   5. Verify row counts, backfill, columns
//   6. Report results
//
// Idempotent — safe to re-run.

import { migrate } from './tier0-org-foundation.js';

const dry = process.argv.includes('--dry');

console.log('='.repeat(60));
console.log('  Tier 0 — Org Foundation Migration');
console.log('  ' + (dry ? 'DRY RUN' : 'LIVE'));
console.log('='.repeat(60));
console.log();

const result = migrate({ dry });

console.log();
console.log('='.repeat(60));
if (result.alreadyDone) {
  console.log('  Result: ALREADY MIGRATED (no changes needed)');
} else if (result.ok) {
  console.log('  Result: SUCCESS');
  if (result.backupPath) {
    console.log('  Backup: ' + result.backupPath);
  }
} else {
  console.log('  Result: FAILED — check log above');
  if (result.backupPath) {
    console.log('  Backup: ' + result.backupPath);
  }
}
console.log('='.repeat(60));

process.exit(result.ok ? 0 : 1);
