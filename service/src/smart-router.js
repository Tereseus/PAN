/**
 * PAN Smart Router — invisible routing layer
 *
 * Makes routing decisions without the user needing to know about devices, apps,
 * or configuration. Learns from corrections. Works in any language (pattern-based,
 * no LLM needed for correction detection).
 *
 * Three jobs:
 *   1. smartPickApp(action_type, device)         → best single app for the job
 *   2. detectCorrection(text)                    → did user just correct us?
 *   3. scoreAndPickDevice(intent, devices, ctx)  → best device for the intent
 */

import { get, all, run, insert } from './db.js';

// ─────────────────────────────────────────────────────────────────────────────
// APP PRIORITY TABLES
// Higher score = better. Pick highest-scoring available app.
// "available" means device.capabilities includes "app:<name>"
// ─────────────────────────────────────────────────────────────────────────────
const APP_SCORES = {
  play_movie: {
    plex:           100,  // best UX: remote, resume, subtitles
    kodi:            90,  // full media center
    'media-player-classic': 75,
    'mpc-hc':        75,
    vlc:             70,  // fast, reliable
    mpv:             65,
    'windows-media-player': 55,
    'wmp':           55,
    potplayer:       60,
    chrome:          30,  // youtube fallback
    firefox:         28,
    browser:         25,
  },
  play_music: {
    spotify:        100,
    plex:            80,  // Plex music
    'apple-music':   90,
    vlc:             40,
    chrome:          30,  // youtube
    firefox:         28,
    browser:         25,
  },
  open_browser: {
    chrome:         100,
    'google-chrome': 100,
    firefox:         85,
    edge:            75,
    safari:          70,
    browser:         50,
  },
  open_app: {},  // generic — no preference
  stream_cast: {
    obs:            100,
    plex:            80,
    chrome:          40,
  },
};

/**
 * Pick the single best app for an action on a device.
 * Returns app name (string) or null if nothing relevant installed.
 */
export function smartPickApp(action_type, device) {
  let caps = [];
  try { caps = JSON.parse(device.capabilities || '[]'); } catch {}
  const installed = new Set(
    caps.filter(c => c.startsWith('app:')).map(c => c.replace('app:', ''))
  );

  const scores = APP_SCORES[action_type] || {};
  let best = null, bestScore = -1;
  for (const [app, score] of Object.entries(scores)) {
    if (installed.has(app) && score > bestScore) {
      best = app;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Get ALL apps for an action on a device, sorted by score (best first).
 * Used to offer a choice when multiple options exist.
 */
export function rankedAppsForAction(action_type, device) {
  let caps = [];
  try { caps = JSON.parse(device.capabilities || '[]'); } catch {}
  const installed = new Set(
    caps.filter(c => c.startsWith('app:')).map(c => c.replace('app:', ''))
  );

  const scores = APP_SCORES[action_type] || {};
  const ranked = Object.entries(scores)
    .filter(([app]) => installed.has(app))
    .sort((a, b) => b[1] - a[1])
    .map(([app]) => app);

  // If nothing matched our priority table, return whatever is installed
  if (ranked.length === 0) {
    return [...installed];
  }
  return ranked;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEVICE SCORING
// ─────────────────────────────────────────────────────────────────────────────

// Capability → score bonus for an intent
const DEVICE_CAP_SCORES = {
  play_movie:   { projector: 80, display: 40, speakers: 20, hdmi: 15, kvm: 10 },
  play_music:   { speakers: 60, bluetooth: 20, audio: 40 },
  open_browser: { browser: 30, apps: 20 },
  run_command:  { terminal: 50, shell_exec: 40, windows: 20 },
  terminal:     { terminal: 50, shell_exec: 40 },
};

// Natural language words → capability hints
const NATURAL_DEVICE_HINTS = {
  // Display/projection
  'big screen':     ['projector', 'display', 'tv'],
  'projector':      ['projector'],
  'tv':             ['tv', 'hdmi', 'display'],
  'screen':         ['display', 'projector'],
  'monitor':        ['display'],
  // Rooms (match aliases)
  'living room':    ['living-room', 'lounge', 'tv'],
  'bedroom':        ['bedroom'],
  'office':         ['office', 'desktop'],
  'kitchen':        ['kitchen'],
  // Device types
  'laptop':         ['laptop'],
  'desktop':        ['desktop'],
  'computer':       ['desktop', 'laptop'],
  'phone':          ['phone'],
  'tablet':         ['tablet'],
  // Your specific setup
  'hub':            ['server', 'hub'],
  'main computer':  ['server', 'hub', 'desktop'],
  'mini':           ['mini-pc', 'minipc'],
  'other one':      null,  // means "not the one you just used"
  'other computer': null,
  'that one':       null,
  'over there':     null,
};

/**
 * Score a device for a given intent.
 * Higher = better match.
 */
function scoreDevice(device, action_type, hintCaps = []) {
  let caps = [];
  try { caps = JSON.parse(device.capabilities || '[]'); } catch {}
  const capSet = new Set(caps);
  let score = 0;

  // Capability match for intent
  const intentScores = DEVICE_CAP_SCORES[action_type] || {};
  for (const [cap, bonus] of Object.entries(intentScores)) {
    if (caps.some(c => c.includes(cap))) score += bonus;
  }

  // Natural language hint match
  for (const hint of hintCaps) {
    if (caps.some(c => c.includes(hint))) score += 60;
    if ((device.name || '').toLowerCase().includes(hint)) score += 50;
    if ((device.hostname || '').toLowerCase().includes(hint)) score += 40;
  }

  // Device is online → prefer it
  if (device.online) score += 20;

  // Has the app we'd need
  const bestApp = smartPickApp(action_type, device);
  if (bestApp) score += 30;

  return score;
}

/**
 * Pick the best device for an action given:
 *  - active devices list
 *  - action intent
 *  - optional natural language hint from user ("big screen", "projector")
 *
 * Returns { device, app, confident }
 *   confident = true means we're sure enough to act without asking
 */
export function pickDevice(action_type, devices, naturalHint = '') {
  if (!devices || devices.length === 0) return { device: null, app: null, confident: false };

  // Resolve natural hint → capability keywords
  const hintLower = naturalHint.toLowerCase();
  let hintCaps = [];
  for (const [phrase, caps] of Object.entries(NATURAL_DEVICE_HINTS)) {
    if (hintLower.includes(phrase) && caps) {
      hintCaps = [...new Set([...hintCaps, ...caps])];
    }
  }

  // Check aliases (user may have named devices: "projector" → tedprodesk2)
  if (naturalHint) {
    const words = hintLower.split(/\s+/);
    for (const word of words) {
      try {
        const alias = get(
          "SELECT d.* FROM device_aliases a JOIN devices d ON d.hostname = a.device_id WHERE a.alias = :alias",
          { ':alias': word }
        );
        if (alias) return { device: alias, app: smartPickApp(action_type, alias), confident: true };
      } catch {}
    }
  }

  // Score all online devices
  const online = devices.filter(d => d.online);
  const pool = online.length > 0 ? online : devices;

  const scored = pool
    .map(d => ({ device: d, score: scoreDevice(d, action_type, hintCaps), app: smartPickApp(action_type, d) }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { device: null, app: null, confident: false };

  const top = scored[0];
  const runnerUp = scored[1];

  // Confident if: top score is meaningfully better than runner-up, OR there's only one device
  const gap = runnerUp ? (top.score - runnerUp.score) : Infinity;
  const confident = scored.length === 1 || gap >= 30 || top.score >= 80;

  return {
    device: top.device,
    app: top.app,
    confident,
    alternatives: scored.slice(1).map(s => ({ device: s.device, app: s.app, score: s.score })),
    score: top.score,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTION DETECTION
// Detects when the user is correcting PAN's last action/choice.
// Works pattern-first — no LLM needed, works in noisy/multilingual speech.
// ─────────────────────────────────────────────────────────────────────────────

// Correction trigger patterns (order matters — most specific first)
const CORRECTION_PATTERNS = [
  // "no, do it on X" / "no, play it on X"
  /(?:no[,.]?\s+)?(?:do it|play it|put it|show it|open it|run it|send it)\s+(?:on|to|in|at)\s+(.+)/i,
  // "on X instead" / "on X not Y"
  /(?:on|to|at)\s+(.+?)\s+instead/i,
  // "I meant X" / "I mean X"
  /I\s+meant?\s+(.+)/i,
  // "not that one, the X" / "not X, the Y"
  /not\s+(?:that|this|the\s+\w+)[,.]?\s+(?:the\s+)?(.+)/i,
  // "use X" / "use X for that"
  /\buse\s+(.+?)(?:\s+for\s+.+)?$/i,
  // "wrong ..." → "other one" or gives name after
  /(?:that['']?s?\s+wrong|wrong\s+(?:one|device|screen|place))[,.]?\s*(?:try\s+)?(.+)?/i,
  // "switch to X" / "move it to X"
  /(?:switch|move)\s+(?:it\s+)?to\s+(.+)/i,
  // Direct: "the projector" / "the big screen" / "my phone" at start
  /^(?:the\s+|my\s+|on\s+the\s+|on\s+my\s+)(.+?)(?:\s+please)?\.?$/i,
];

// Signals that a message is a correction (even without explicit target)
const CORRECTION_SIGNALS = [
  /^no[,.]?\s+(?:not\s+that|that['']?s?\s+wrong|wrong)/i,
  /^(?:wrong|incorrect|not\s+right|that['']?s?\s+not)/i,
  /\bthat['']?s?\s+not\s+(?:what|where|right|correct)/i,
  /\bnot\s+(?:on|there|that\s+(?:one|screen|device))/i,
];

/**
 * Detect if the user is correcting a previous action.
 * Returns { isCorrection, target, rawTarget } or null.
 *
 * target = natural language description of where they WANT it ("the projector", "my phone")
 */
export function detectCorrection(text) {
  const t = text.trim();

  // Check correction signals first (pure negation — target may need inference)
  const hasSignal = CORRECTION_SIGNALS.some(p => p.test(t));

  // Check extraction patterns
  for (const pattern of CORRECTION_PATTERNS) {
    const m = t.match(pattern);
    if (m) {
      const rawTarget = (m[1] || '').trim().replace(/[.,!?]$/, '').toLowerCase();
      return {
        isCorrection: true,
        target: rawTarget || null,
        rawTarget,
        hasExplicitTarget: rawTarget.length > 0,
      };
    }
  }

  if (hasSignal) {
    return { isCorrection: true, target: null, hasExplicitTarget: false };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PREFERENCE LEARNER
// Called after a correction is confirmed.
// Saves the user's choice so we never ask again for the same situation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Learn from a correction: save the preference to DB so next time we route correctly.
 * @param {string} action_type  — e.g. "play_movie"
 * @param {object} device       — the device the user chose
 * @param {string|null} app     — the app they chose (or null = best available)
 * @param {string} org_id
 * @param {string|null} user_id
 */
export function learnCorrection(action_type, device, app, org_id = 'org_personal', user_id = null) {
  if (!device) return;
  try {
    run(`INSERT INTO action_preferences
      (user_id, org_id, action_type, device_id, device_type, app, confidence, use_count)
      VALUES (:uid, :oid, :at, :did, :dtype, :app, 0.9, 1)
      ON CONFLICT(COALESCE(user_id,''), org_id, action_type)
      DO UPDATE SET device_id = :did, device_type = :dtype, app = :app,
        confidence = MIN(1.0, confidence + 0.1), use_count = use_count + 1`,
      {
        ':uid': user_id || '',
        ':oid': org_id,
        ':at':  action_type,
        ':did': device.hostname || device.device_id || '',
        ':dtype': device.device_type || 'pc',
        ':app': app || '',
      }
    );
    console.log(`[SmartRouter] Learned: ${action_type} → ${device.hostname} (${app || 'auto'})`);
  } catch (e) {
    console.warn('[SmartRouter] learnCorrection failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT STORE
// Keeps track of the last routed action per session so corrections can reference it.
// In-memory — cleared on restart. That's fine: corrections need immediate context.
// ─────────────────────────────────────────────────────────────────────────────
const lastAction = new Map(); // session_id → { action_type, device, app, text, ts }

export function setLastAction(session_id, action_type, device, app, text) {
  lastAction.set(session_id, { action_type, device, app, text, ts: Date.now() });
}

export function getLastAction(session_id) {
  const a = lastAction.get(session_id);
  if (!a) return null;
  // Corrections only make sense within 5 minutes
  if (Date.now() - a.ts > 5 * 60 * 1000) return null;
  return a;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION TYPE INFERENCE
// Maps Claude's intent strings to action_type keys used in preference store
// ─────────────────────────────────────────────────────────────────────────────
export function intentToActionType(intent, parsed = {}) {
  const map = {
    music:      'play_music',
    video:      'play_movie',
    movie:      'play_movie',
    media:      'play_movie',
    browser:    'open_browser',
    navigate:   'navigate',
    terminal:   'terminal',
    system:     'run_command',
    query:      'query',
    memory:     'save_memory',
    calendar:   'calendar',
  };

  // Music vs video: check the query
  if (intent === 'music') {
    const q = (parsed.query || '').toLowerCase();
    if (q.match(/movie|film|episode|show|video|watch/)) return 'play_movie';
    return 'play_music';
  }

  return map[intent] || intent;
}
