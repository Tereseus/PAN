// PAN GitHub Monitor — job type for the Job Runner
//
// Watches for new comments on user's GitHub issues.
// Registered as job type 'github_issues' with the Job Runner.
// Can also be started standalone for backward compatibility.

import { execSync } from 'child_process';
import { get, run, insert, indexEventFTS } from './db.js';
import { registerJobType, upsertJob } from './jobs.js';

const GITHUB_USER = 'Tereseus';
const SETTINGS_KEY = 'github_monitor_last_check';

let intervalHandle = null;

/**
 * Run a gh CLI command and parse JSON output.
 */
function ghApi(endpoint, extraArgs = '') {
  try {
    const cmd = `gh api "${endpoint}" ${extraArgs}`.trim();
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout);
  } catch (err) {
    console.error(`[GitHub] gh api failed for ${endpoint}: ${err.message}`);
    return null;
  }
}

function getLastCheck() {
  const row = get("SELECT value FROM settings WHERE key = :key", { ':key': SETTINGS_KEY });
  return row ? row.value : null;
}

function saveLastCheck(isoTimestamp) {
  run(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (:key, :val, datetime('now','localtime'))",
    { ':key': SETTINGS_KEY, ':val': isoTimestamp }
  );
}

/**
 * Core check logic — used both by job runner and standalone mode.
 */
export async function checkGithubNow(config = {}) {
  const user = config.github_user || GITHUB_USER;
  const checkStart = new Date().toISOString();
  const lastCheck = getLastCheck();

  console.log(`[GitHub] Checking issues for @${user}...`);

  const since = lastCheck || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const searchQuery = `author:${user} is:issue updated:>=${since.slice(0, 10)}`;
  const searchResult = ghApi(
    `search/issues?q=${encodeURIComponent(searchQuery)}&sort=updated&order=desc&per_page=50`
  );

  if (!searchResult || !searchResult.items) {
    console.log('[GitHub] No results (API may be unavailable)');
    saveLastCheck(checkStart);
    return { ok: true, new_comments: 0 };
  }

  const issues = searchResult.items;
  console.log(`[GitHub] ${issues.length} recently updated issues`);

  const newComments = [];

  for (const issue of issues) {
    if (!issue.comments || issue.comments === 0) continue;

    const repoMatch = issue.repository_url?.match(/repos\/(.+)$/);
    if (!repoMatch) continue;
    const repo = repoMatch[1];

    const commentsEndpoint = `repos/${repo}/issues/${issue.number}/comments?since=${encodeURIComponent(since)}&per_page=50`;
    const comments = ghApi(commentsEndpoint);

    if (!comments || !Array.isArray(comments)) continue;

    const otherComments = comments.filter(c =>
      c.user?.login?.toLowerCase() !== user.toLowerCase() &&
      new Date(c.created_at) > new Date(since)
    );

    for (const comment of otherComments) {
      const entry = {
        repo,
        issue_number: issue.number,
        issue_title: issue.title,
        issue_url: issue.html_url,
        comment_id: comment.id,
        comment_url: comment.html_url,
        author: comment.user?.login,
        created_at: comment.created_at,
        body: comment.body?.slice(0, 1000) || '',
      };

      newComments.push(entry);

      const eventId = insert(
        `INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`,
        {
          ':sid': `github-${Date.now()}`,
          ':type': 'GitHubComment',
          ':data': JSON.stringify(entry),
        }
      );

      const searchText = `${entry.repo}#${entry.issue_number} ${entry.issue_title} — ${entry.author}: ${entry.body}`;
      indexEventFTS(eventId, 'GitHubComment', JSON.stringify({ text: searchText }));

      console.log(`[GitHub] New: ${repo}#${issue.number} by @${entry.author}`);
      console.log(`  "${entry.body.slice(0, 120)}${entry.body.length > 120 ? '...' : ''}"`);
    }
  }

  saveLastCheck(checkStart);

  if (newComments.length > 0) {
    insert(
      `INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`,
      {
        ':sid': `github-${Date.now()}`,
        ':type': 'GitHubMonitorSummary',
        ':data': JSON.stringify({
          checked_at: checkStart,
          new_comments: newComments.length,
          issues_with_comments: [...new Set(newComments.map(c => `${c.repo}#${c.issue_number}`))],
          comments: newComments.map(c => ({
            repo: c.repo, issue: `#${c.issue_number}`, title: c.issue_title,
            author: c.author, url: c.comment_url, preview: c.body.slice(0, 200),
          })),
        }),
      }
    );
    console.log(`[GitHub] Found ${newComments.length} new comment(s)`);
  } else {
    console.log('[GitHub] No new comments');
  }

  return { ok: true, new_comments: newComments.length, comments: newComments };
}

// Register as a job type with the Job Runner
registerJobType('github_issues', async (config) => {
  return await checkGithubNow(config);
});

// Seed the default job if it doesn't exist
try {
  upsertJob({
    name: 'GitHub Issue Monitor',
    job_type: 'github_issues',
    config: { github_user: GITHUB_USER },
    interval_ms: 2 * 60 * 60 * 1000, // 2 hours
    enabled: true,
  });
} catch {}

// Backward-compatible start/stop (delegates to job runner now)
export function startGithubMonitor() {
  console.log('[GitHub] Registered as job type "github_issues" (managed by Job Runner)');
}

export function stopGithubMonitor() {
  // Job runner handles lifecycle now
}
