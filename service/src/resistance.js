// PAN Resistance Router — Path of Least Resistance for every action
//
// Every action (play music, send message, etc.) has multiple paths.
// Each path has prerequisites and a success rate.
// PAN tries them in order of most likely to succeed.
// Success/failure data is logged and used to improve routing.

import { all, get, run, insert } from './db.js';

// Ensure resistance tables exist
try {
  run(`CREATE TABLE IF NOT EXISTS resistance_paths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    path_name TEXT NOT NULL,
    method TEXT NOT NULL,
    platform TEXT DEFAULT 'all',
    requires TEXT DEFAULT '[]',
    priority INTEGER DEFAULT 50,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    last_used TEXT,
    last_error TEXT,
    UNIQUE(action, path_name)
  )`);

  run(`CREATE TABLE IF NOT EXISTS resistance_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    path_name TEXT NOT NULL,
    success INTEGER NOT NULL,
    error TEXT,
    duration_ms INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
} catch {}

// Default paths — seeded on first run, users/community can add more
const DEFAULT_PATHS = [
  // Music playback
  { action: 'play_music', path_name: 'youtube_browser', method: 'browser', platform: 'pc', requires: '["browser_extension"]', priority: 90,
    description: 'Search and play on YouTube via browser extension' },
  { action: 'play_music', path_name: 'youtube_intent', method: 'intent', platform: 'android', requires: '[]', priority: 85,
    description: 'Open YouTube app with search query via Android intent' },
  { action: 'play_music', path_name: 'spotify_deeplink', method: 'deeplink', platform: 'android', requires: '[]', priority: 80,
    description: 'Open Spotify search via deep link' },
  { action: 'play_music', path_name: 'spotify_api', method: 'api', platform: 'all', requires: '["spotify_token"]', priority: 95,
    description: 'Play directly via Spotify Web API (needs auth)' },
  { action: 'play_music', path_name: 'youtube_accessibility', method: 'accessibility', platform: 'android', requires: '["accessibility_service"]', priority: 60,
    description: 'Open YouTube and tap play via accessibility' },

  // Send message
  { action: 'send_message', path_name: 'pan_direct', method: 'pan_network', platform: 'all', requires: '["recipient_has_pan"]', priority: 95,
    description: 'Send directly via PAN-to-PAN network' },
  { action: 'send_message', path_name: 'sms_intent', method: 'intent', platform: 'android', requires: '[]', priority: 80,
    description: 'Send SMS via Android intent' },
  { action: 'send_message', path_name: 'whatsapp_accessibility', method: 'accessibility', platform: 'android', requires: '["accessibility_service"]', priority: 70,
    description: 'Open WhatsApp and type message via accessibility' },
  { action: 'send_message', path_name: 'browser_webapp', method: 'browser', platform: 'pc', requires: '["browser_extension"]', priority: 75,
    description: 'Send via web app in browser (WhatsApp Web, Instagram, etc)' },

  // Navigation
  { action: 'navigate', path_name: 'maps_intent', method: 'intent', platform: 'android', requires: '[]', priority: 90,
    description: 'Open Google Maps with destination' },
  { action: 'navigate', path_name: 'maps_browser', method: 'browser', platform: 'pc', requires: '["browser_extension"]', priority: 80,
    description: 'Open Google Maps in browser' },

  // Open app/website
  { action: 'open_app', path_name: 'android_launch', method: 'intent', platform: 'android', requires: '[]', priority: 90,
    description: 'Launch Android app by package name' },
  { action: 'open_app', path_name: 'browser_navigate', method: 'browser', platform: 'pc', requires: '["browser_extension"]', priority: 85,
    description: 'Open website in browser' },
  { action: 'open_app', path_name: 'pc_launch', method: 'command', platform: 'pc', requires: '[]', priority: 80,
    description: 'Launch desktop application' },

  // Calendar
  { action: 'calendar', path_name: 'google_api', method: 'api', platform: 'all', requires: '["google_calendar_token"]', priority: 95,
    description: 'Google Calendar API (needs auth)' },
  { action: 'calendar', path_name: 'calendar_intent', method: 'intent', platform: 'android', requires: '[]', priority: 80,
    description: 'Open calendar app via intent' },

  // Search
  { action: 'search', path_name: 'browser_search', method: 'browser', platform: 'pc', requires: '["browser_extension"]', priority: 90,
    description: 'Search in browser' },
  { action: 'search', path_name: 'google_intent', method: 'intent', platform: 'android', requires: '[]', priority: 85,
    description: 'Google search via Android intent' },
];

// Seed default paths if table is empty
function seedDefaults() {
  const count = get('SELECT COUNT(*) as c FROM resistance_paths');
  if (count && count.c === 0) {
    for (const p of DEFAULT_PATHS) {
      run(`INSERT OR IGNORE INTO resistance_paths (action, path_name, method, platform, requires, priority)
           VALUES (:action, :path_name, :method, :platform, :requires, :priority)`, {
        ':action': p.action,
        ':path_name': p.path_name,
        ':method': p.method,
        ':platform': p.platform,
        ':requires': p.requires,
        ':priority': p.priority,
      });
    }
    console.log(`[Resistance] Seeded ${DEFAULT_PATHS.length} default paths`);
  }
}
seedDefaults();

// Get available capabilities for this device/user
function getCapabilities(platform = 'pc') {
  const caps = ['browser_extension']; // assume browser ext is installed on PC
  if (platform === 'android') {
    caps.push('accessibility_service');
  }
  // Check for API tokens
  try {
    const spotifyToken = get("SELECT value FROM settings WHERE key = 'spotify_token'");
    if (spotifyToken) caps.push('spotify_token');
  } catch {}
  try {
    const gcalToken = get("SELECT value FROM settings WHERE key = 'google_calendar_token'");
    if (gcalToken) caps.push('google_calendar_token');
  } catch {}
  return caps;
}

// Get ordered paths for an action, filtered by platform and capabilities
export function getResistancePaths(action, platform = 'pc') {
  const capabilities = getCapabilities(platform);

  const paths = all(
    `SELECT * FROM resistance_paths WHERE action = :action AND (platform = :platform OR platform = 'all')
     ORDER BY priority DESC, success_count DESC, fail_count ASC`,
    { ':action': action, ':platform': platform }
  );

  // Filter by available capabilities and sort by effective priority
  return paths
    .map(p => {
      const requires = JSON.parse(p.requires || '[]');
      const hasAll = requires.every(r => capabilities.includes(r));
      const total = p.success_count + p.fail_count;
      const successRate = total > 0 ? p.success_count / total : 0.5;
      const effectivePriority = p.priority * (0.5 + successRate * 0.5);
      return { ...p, available: hasAll, effectivePriority, successRate, missingRequirements: requires.filter(r => !capabilities.includes(r)) };
    })
    .sort((a, b) => {
      // Available paths first, then by effective priority
      if (a.available && !b.available) return -1;
      if (!a.available && b.available) return 1;
      return b.effectivePriority - a.effectivePriority;
    });
}

// Try an action — returns the first working path's result
export async function tryAction(action, params = {}, platform = 'pc') {
  const paths = getResistancePaths(action, platform);

  if (paths.length === 0) {
    return { ok: false, error: `No paths available for action "${action}"` };
  }

  const errors = [];

  for (const path of paths) {
    if (!path.available) {
      const missing = path.missingRequirements.join(', ');
      errors.push({ path: path.path_name, error: `Requires: ${missing}`, suggestion: getSuggestion(path) });
      continue;
    }

    const start = Date.now();
    try {
      const result = await executePath(path, params);
      const duration = Date.now() - start;

      // Log success
      logResult(action, path.path_name, true, null, duration);
      return { ok: true, path: path.path_name, method: path.method, result, duration };

    } catch (err) {
      const duration = Date.now() - start;
      const errorMsg = err.message || String(err);

      // Log failure
      logResult(action, path.path_name, false, errorMsg, duration);
      errors.push({ path: path.path_name, error: errorMsg });
    }
  }

  // All paths failed — return helpful error with alternatives
  const available = errors.filter(e => !e.suggestion);
  const needSetup = errors.filter(e => e.suggestion);

  let message = `Could not ${action.replace('_', ' ')}.`;
  if (needSetup.length > 0) {
    message += ` To enable more options: ${needSetup.map(e => e.suggestion).join('. ')}.`;
  }

  return { ok: false, error: message, attempts: errors };
}

// Execute a specific path
async function executePath(path, params) {
  // This is where the actual execution happens
  // Each method type has its own handler
  // The router.js or api.js calls the appropriate service

  // For now, return the path info for the router to execute
  // The actual execution is handled by the existing PAN infrastructure
  return { path_name: path.path_name, method: path.method, params };
}

// Get setup suggestion for a missing requirement
function getSuggestion(path) {
  const missing = path.missingRequirements || [];
  const suggestions = {
    'spotify_token': 'Say "connect Spotify" to link your Spotify account',
    'google_calendar_token': 'Say "connect calendar" to link your Google Calendar',
    'browser_extension': 'Install the PAN browser extension',
    'accessibility_service': 'Enable PAN accessibility service in Android settings',
    'recipient_has_pan': 'The recipient needs PAN installed for direct messaging',
  };
  return missing.map(m => suggestions[m] || `Set up ${m}`).join('. ');
}

// Log success/failure and update path stats
function logResult(action, pathName, success, error, durationMs) {
  try {
    // Log to resistance_log
    run(`INSERT INTO resistance_log (action, path_name, success, error, duration_ms)
         VALUES (:action, :path, :success, :error, :duration)`, {
      ':action': action,
      ':path': pathName,
      ':success': success ? 1 : 0,
      ':error': error || null,
      ':duration': durationMs || null,
    });

    // Update path stats
    if (success) {
      run(`UPDATE resistance_paths SET success_count = success_count + 1, last_used = datetime('now')
           WHERE action = :action AND path_name = :path`, {
        ':action': action, ':path': pathName,
      });
    } else {
      run(`UPDATE resistance_paths SET fail_count = fail_count + 1, last_used = datetime('now'), last_error = :error
           WHERE action = :action AND path_name = :path`, {
        ':action': action, ':path': pathName, ':error': error,
      });
    }
  } catch {}
}

// Add a new path (community/user discovered)
export function addPath(action, pathName, method, platform, requires = [], priority = 50) {
  run(`INSERT OR REPLACE INTO resistance_paths (action, path_name, method, platform, requires, priority)
       VALUES (:action, :path_name, :method, :platform, :requires, :priority)`, {
    ':action': action,
    ':path_name': pathName,
    ':method': method,
    ':platform': platform,
    ':requires': JSON.stringify(requires),
    ':priority': priority,
  });
}

// Get stats for the dashboard
export function getResistanceStats() {
  const pathStats = all(`SELECT action, path_name, success_count, fail_count, priority,
    CASE WHEN (success_count + fail_count) > 0
      THEN ROUND(100.0 * success_count / (success_count + fail_count), 1)
      ELSE NULL END as success_rate
    FROM resistance_paths ORDER BY action, priority DESC`);

  const recentLogs = all(`SELECT * FROM resistance_log ORDER BY created_at DESC LIMIT 50`);

  return { paths: pathStats, recent: recentLogs };
}
