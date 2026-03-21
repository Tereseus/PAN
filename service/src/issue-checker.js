// PAN Issue Checker — periodically checks filed platform issues for updates
// Runs as part of the PAN service, checks once per day
// Results logged to the dashboard and reported to the user

import { insert } from './db.js';

const ISSUES = [
  { repo: 'anthropics/claude-code', number: 37205, title: 'OAuth tokens for API' },
  { repo: 'anthropics/claude-code', number: 37211, title: 'claude serve mode' },
  { repo: 'microsoft/PowerToys', number: 46383, title: 'Voice Typing API' },
  { repo: 'microsoft/PowerToys', number: 46385, title: 'UI Automation performance' },
];

export async function checkIssues() {
  const results = [];

  for (const issue of ISSUES) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${issue.repo}/issues/${issue.number}`,
        { headers: { 'User-Agent': 'PAN-Issue-Checker' } }
      );

      if (!res.ok) continue;
      const data = await res.json();

      const status = {
        repo: issue.repo,
        number: issue.number,
        title: issue.title,
        state: data.state,
        labels: data.labels?.map(l => l.name) || [],
        comments: data.comments,
        updated: data.updated_at,
        url: data.html_url,
      };

      results.push(status);

      // Check for new comments
      if (data.comments > 0) {
        const commentsRes = await fetch(
          `https://api.github.com/repos/${issue.repo}/issues/${issue.number}/comments?per_page=5&sort=created&direction=desc`,
          { headers: { 'User-Agent': 'PAN-Issue-Checker' } }
        );
        if (commentsRes.ok) {
          const comments = await commentsRes.json();
          status.latest_comment = comments[0]?.body?.slice(0, 200);
          status.latest_comment_by = comments[0]?.user?.login;
          status.latest_comment_date = comments[0]?.created_at;
        }
      }
    } catch (e) {
      console.error(`[Issues] Failed to check ${issue.repo}#${issue.number}: ${e.message}`);
    }
  }

  // Log results
  if (results.length > 0) {
    insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
      ':sid': `issues-${Date.now()}`,
      ':type': 'IssueCheck',
      ':data': JSON.stringify({ checked: new Date().toISOString(), issues: results })
    });

    console.log(`[Issues] Checked ${results.length} issues:`);
    for (const r of results) {
      const labels = r.labels.length > 0 ? ` [${r.labels.join(', ')}]` : '';
      console.log(`  ${r.repo}#${r.number}: ${r.state}${labels} (${r.comments} comments)`);
    }
  }

  return results;
}
