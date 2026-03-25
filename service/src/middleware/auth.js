// PAN Auth Middleware — Phase 1: User Identity
//
// Two modes controlled by settings key 'auth_mode':
//   "none" (default) — no auth required, all requests get user_id=1 (owner)
//   "token" — requires Authorization: Bearer <token> header
//
// Every request gets req.user = { id, email, display_name, role }

import { get, run } from '../db.js';

const ROLE_HIERARCHY = ['viewer', 'user', 'manager', 'admin', 'owner'];

function getRoleLevel(role) {
  const idx = ROLE_HIERARCHY.indexOf(role);
  return idx >= 0 ? idx : 0;
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

export { extractUser, requireRole, ROLE_HIERARCHY, getRoleLevel };
