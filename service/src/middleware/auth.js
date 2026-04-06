// PAN Auth Middleware — Phase 1: User Identity
//
// Two modes controlled by settings key 'auth_mode':
//   "none" (default) — no auth required, all requests get user_id=1 (owner)
//   "token" — requires Authorization: Bearer <token> header
//
// Every request gets req.user = { id, email, display_name, role }

import { get, all, run } from '../db.js';

// Default hierarchy — used as fallback if roles table is empty or missing
const DEFAULT_ROLES = { viewer: 0, user: 25, manager: 50, admin: 75, owner: 100 };

// Cache role levels from DB (refreshed on each request — cheap single query)
let _roleCache = null;
let _roleCacheTime = 0;

function getRoleLevels() {
  const now = Date.now();
  if (_roleCache && now - _roleCacheTime < 30000) return _roleCache; // cache for 30s
  try {
    const rows = all("SELECT name, level FROM roles");
    if (rows.length > 0) {
      _roleCache = {};
      for (const r of rows) _roleCache[r.name] = r.level;
      _roleCacheTime = now;
      return _roleCache;
    }
  } catch {}
  return DEFAULT_ROLES;
}

// Exported for backwards compat — dynamic list of role names sorted by level
function getRoleHierarchy() {
  const levels = getRoleLevels();
  return Object.entries(levels).sort((a, b) => a[1] - b[1]).map(e => e[0]);
}

const ROLE_HIERARCHY = getRoleHierarchy(); // initial load

function getRoleLevel(role) {
  const levels = getRoleLevels();
  return levels[role] ?? 0;
}

/**
 * extractUser — attaches req.user to every request
 * In "none" mode: always sets the default owner user
 * In "token" mode: validates Bearer token, returns 401 if invalid
 */
function extractUser(req, res, next) {
  // Check auth mode
  const modeSetting = get("SELECT value FROM settings WHERE key = 'auth_mode'");
  const authMode = modeSetting?.value || 'none';

  if (authMode === 'none') {
    // No auth — everyone is the default owner
    req.user = { id: 1, email: 'owner@localhost', display_name: 'Owner', role: 'owner' };
    return next();
  }

  // Token mode — validate Authorization header
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
  }

  const token = authHeader.slice(7);
  const tokenRow = get(
    "SELECT t.*, u.email, u.display_name, u.role, u.is_active FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = :token",
    { ':token': token }
  );

  if (!tokenRow) {
    return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  }

  if (!tokenRow.is_active) {
    return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
  }

  if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
  }

  // Update last_used timestamp (async, don't block the request)
  try {
    run("UPDATE api_tokens SET last_used = datetime('now','localtime') WHERE id = :id", { ':id': tokenRow.id });
  } catch {}

  req.user = {
    id: tokenRow.user_id,
    email: tokenRow.email,
    display_name: tokenRow.display_name,
    role: tokenRow.role,
    token_id: tokenRow.id,
    token_name: tokenRow.name
  };

  next();
}

/**
 * requireRole — checks that req.user has at least the specified role
 * Usage: router.post('/admin-action', requireRole('admin'), handler)
 */
function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userLevel = getRoleLevel(req.user.role);
    const requiredLevel = getRoleLevel(minRole);

    if (userLevel < requiredLevel) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: minRole,
        current: req.user.role
      });
    }

    next();
  };
}

export { extractUser, requireRole, ROLE_HIERARCHY, getRoleLevel, getRoleHierarchy, getRoleLevels };
