// Hook script: updates .pan file in the project directory with current session ID
// Called by Claude Code on SessionStart via stdin JSON
//
// The .pan file is the source of truth for PAN's project awareness.
// It tracks: project name, last session ID (for --resume), the claude project
// dir where sessions are stored, and previous paths (for rename tracking).
//
// On launch, PAN reads .pan files to know what to resume. This hook keeps
// them up to date as new sessions start.

const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd;
    const sessionId = data.session_id;

    if (!cwd || !sessionId) process.exit(0);

    const panFile = path.join(cwd, '.pan');
    let panData = {};

    // Read existing .pan file if it exists
    try {
      panData = JSON.parse(fs.readFileSync(panFile, 'utf-8'));
    } catch {}

    // Set project name from folder name if not already set
    if (!panData.project_name) {
      panData.project_name = path.basename(cwd);
    }

    // Update with current session
    panData.last_session_id = sessionId;
    panData.last_session_time = new Date().toISOString();

    // Track the claude project dir for this cwd (so renames don't lose sessions)
    const cwdEncoded = 'C--' + cwd.replace(/^[A-Z]:[\\\/]/, '').replace(/[\\\/]/g, '-');
    const claudeProjectDir = path.join(
      process.env.USERPROFILE || 'C:\\Users\\tzuri',
      '.claude', 'projects', cwdEncoded
    );
    if (fs.existsSync(claudeProjectDir)) {
      // Track current and any previous claude project dirs
      const prev = panData.claude_project_dir;
      panData.claude_project_dir = claudeProjectDir;

      if (!panData.all_session_dirs) panData.all_session_dirs = [];
      const dirName = path.basename(claudeProjectDir);
      if (!panData.all_session_dirs.includes(dirName)) {
        panData.all_session_dirs.push(dirName);
      }
    }

    // Keep history of previous sessions (last 10)
    if (!panData.session_history) panData.session_history = [];
    panData.session_history.unshift({
      id: sessionId,
      time: new Date().toISOString()
    });
    panData.session_history = panData.session_history.slice(0, 10);

    fs.writeFileSync(panFile, JSON.stringify(panData, null, 2));
  } catch (e) {
    // Silently fail — don't block Claude
  }
});
