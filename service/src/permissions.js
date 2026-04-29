/**
 * PAN Permission Matrix
 *
 * Single source of truth for what power level each feature requires.
 * All enforcement middleware imports from here.
 *
 * Power levels:
 *   child   =   5  — action commands only, no AI chat
 *   viewer  =   0  — (legacy) read-only
 *   guest   =  15  — AI chat allowed, no settings/automations
 *   user    =  25  — standard adult: projects, automations (view), devices (own)
 *   manager =  50  — manage all devices, automations, projects
 *   admin   =  75  — manage users/roles, all settings
 *   owner   = 100  — full everything
 */

// Feature → minimum power level required
export const FEATURE_POWER = {
  // AI chat & terminal
  'chat:ai':              15,  // guest+ (child cannot chat with Claude)
  'terminal:send':        15,  // guest+ (child cannot send to Claude terminal)
  'terminal:create':      25,  // user+

  // Actions (child-safe)
  'action:execute':        0,  // everyone
  'media:play':            0,  // everyone
  'lights:control':        0,  // everyone
  'timer:set':             0,  // everyone

  // Projects
  'projects:view':        25,  // user+
  'projects:create':      25,  // user+
  'projects:edit':        25,  // user+ (own projects only for user, all for manager+)
  'projects:delete':      50,  // manager+

  // Automations
  'automations:view':     25,  // user+
  'automations:create':   50,  // manager+
  'automations:edit':     50,  // manager+
  'automations:delete':   50,  // manager+
  'automations:toggle':   50,  // manager+

  // Devices
  'devices:view':         25,  // user+
  'devices:control':      50,  // manager+ (control OTHER devices; own always allowed)
  'devices:manage':       50,  // manager+

  // Sensors
  'sensors:view':         25,  // user+
  'sensors:configure':    50,  // manager+

  // Memory / conversations
  'memory:view':          25,  // user+ (own memory)
  'memory:manage':        75,  // admin+

  // Settings
  'settings:personal':    25,  // user+ (own preferences)
  'settings:org':         75,  // admin+
  'settings:system':     100,  // owner only

  // Users & roles
  'users:view':           75,  // admin+
  'users:manage':         75,  // admin+
  'roles:manage':        100,  // owner only

  // Incognito
  'incognito':            25,  // user+ (if org policy allows)
};

/**
 * Widget visibility map for the dashboard.
 * Key = widget/panel name, value = min power level to SEE it at all.
 */
export const WIDGET_POWER = {
  terminal:       20,   // guest+ (child gets action-only interface, no terminal)
  automations:    25,   // user+
  projects:       25,   // user+
  devices:        25,   // user+
  sensors:        25,   // user+
  memory:         25,   // user+
  settings:       25,   // user+ (personal settings; system settings gated further inside)
  users:          75,   // admin+
  tests:         100,   // owner only
  instances:     100,   // owner only
  scout:          50,   // manager+
  dream:          50,   // manager+
  privacy:        50,   // manager+
  audit:          75,   // admin+
};

/**
 * Returns true if the user's power level meets the feature requirement.
 * Owner (power=100) always passes. '*' permission means all features allowed.
 */
export function can(user, feature) {
  if (!user) return false;
  const power = user.power ?? user.power_lvl ?? 0;
  if (power >= 100) return true;  // owner bypasses everything
  const required = FEATURE_POWER[feature];
  if (required === undefined) return true;  // unknown feature — allow (fail open for now)
  return power >= required;
}

/**
 * Express middleware: block request if user lacks the feature.
 *
 * Usage: router.post('/endpoint', requireFeature('automations:create'), handler)
 */
export function requireFeature(feature) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!can(req.user, feature)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        feature,
        required_power: FEATURE_POWER[feature],
        your_power: req.user.power ?? 0,
        hint: req.user.power < 20
          ? 'Child accounts cannot access this feature. Ask an admin.'
          : 'Your account level does not have access to this feature.',
      });
    }
    next();
  };
}

/**
 * Child-mode chat intercept.
 * Returns middleware that blocks Claude chat for power < 20 (child).
 * Allows "action" prefixed requests through (lights, timer, media).
 */
export function requireNotChild(req, res, next) {
  const power = req.user?.power ?? req.user?.power_lvl ?? 100;
  if (power < 15) {  // child (5) blocked; guest (15) allowed
    return res.status(403).json({
      error: 'Child accounts cannot send messages to Claude directly.',
      code: 'CHILD_RESTRICTED',
      hint: 'Use action commands (lights, timer, media) instead.',
      power,
    });
  }
  next();
}

/**
 * Returns the permissions matrix as a plain object for API responses.
 */
export function getPermissionsMatrix() {
  return { features: FEATURE_POWER, widgets: WIDGET_POWER };
}
