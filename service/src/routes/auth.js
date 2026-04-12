// PAN Auth Routes — Phase 1: User Identity
//
// OAuth flow: Client gets id_token from Google/Apple/Microsoft/GitHub,
// sends it here, server verifies and issues a PAN API token.

import { Router } from 'express';
import { get, all, insert, run } from '../db.js';
import { randomBytes } from 'crypto';
import { requireRole, getRoleLevels } from '../middleware/auth.js';
import { auditLog } from '../middleware/org-context.js';

const router = Router();

// Verify OAuth token with provider and extract user info
async function verifyOAuthToken(provider, token) {
  switch (provider) {
    case 'google': {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
      if (!res.ok) throw new Error('Invalid Google token');
      const data = await res.json();
      return { email: data.email, name: data.name || data.email, avatar: data.picture, providerId: data.sub };
    }
    case 'microsoft': {
      const res = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Invalid Microsoft token');
      const data = await res.json();
      return { email: data.mail || data.userPrincipalName, name: data.displayName, avatar: null, providerId: data.id };
    }
    case 'github': {
      const [userRes, emailRes] = await Promise.all([
        fetch('https://api.github.com/user', { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }),
        fetch('https://api.github.com/user/emails', { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } })
      ]);
      if (!userRes.ok) throw new Error('Invalid GitHub token');
      const userData = await userRes.json();
      let email = userData.email;
      if (!email && emailRes.ok) {
        const emails = await emailRes.json();
        const primary = emails.find(e => e.primary) || emails[0];
        email = primary?.email;
      }
      return { email, name: userData.name || userData.login, avatar: userData.avatar_url, providerId: String(userData.id) };
    }
    case 'apple': {
      // Apple sends a JWT id_token — decode payload (header.payload.signature)
      // In production, verify signature against Apple's public keys
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('Invalid Apple token format');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (!payload.email) throw new Error('Apple token missing email');
      return { email: payload.email, name: payload.name || payload.email, avatar: null, providerId: payload.sub };
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// Generate a secure API token
function generateToken() {
  return randomBytes(32).toString('hex');
}

// POST /api/v1/auth/oauth — sign in with any OAuth provider
router.post('/oauth', async (req, res) => {
  const { provider, id_token, token_name } = req.body;

  if (!provider || !id_token) {
    return res.status(400).json({ error: 'provider and id_token are required' });
  }

  if (!['google', 'apple', 'microsoft', 'github'].includes(provider)) {
    return res.status(400).json({ error: 'Unsupported provider. Use: google, apple, microsoft, github' });
  }

  try {
    // Verify with provider
    const providerUser = await verifyOAuthToken(provider, id_token);

    if (!providerUser.email) {
      return res.status(400).json({ error: 'Could not get email from provider' });
    }

    // Find or create user by email
    let user = get("SELECT * FROM users WHERE email = :email", { ':email': providerUser.email });

    if (!user) {
      // New user — check if this is the first real user (not the default owner@localhost)
      const userCount = get("SELECT COUNT(*) as c FROM users WHERE email != 'owner@localhost'");
      const role = userCount.c === 0 ? 'owner' : 'user';

      const userId = insert(
        `INSERT INTO users (email, display_name, avatar_url, role) VALUES (:email, :name, :avatar, :role)`,
        { ':email': providerUser.email, ':name': providerUser.name, ':avatar': providerUser.avatar || null, ':role': role }
      );

      user = get("SELECT * FROM users WHERE id = :id", { ':id': userId });
      console.log(`[PAN Auth] New user registered: ${providerUser.email} (${role})`);
    } else {
      // Update display name and avatar from provider
      run(`UPDATE users SET display_name = :name, avatar_url = COALESCE(:avatar, avatar_url), last_login = datetime('now','localtime') WHERE id = :id`,
        { ':name': providerUser.name, ':avatar': providerUser.avatar || null, ':id': user.id });
    }

    // Link OAuth provider if not already linked
    const existingLink = get(
      "SELECT * FROM user_oauth WHERE provider = :provider AND provider_id = :pid",
      { ':provider': provider, ':pid': providerUser.providerId }
    );

    if (!existingLink) {
      insert(
        `INSERT INTO user_oauth (user_id, provider, provider_id, provider_email) VALUES (:uid, :provider, :pid, :email)`,
        { ':uid': user.id, ':provider': provider, ':pid': providerUser.providerId, ':email': providerUser.email }
      );
      console.log(`[PAN Auth] Linked ${provider} to user ${user.email}`);
    }

    // Issue PAN API token
    const apiToken = generateToken();
    insert(
      `INSERT INTO api_tokens (user_id, token, name) VALUES (:uid, :token, :name)`,
      { ':uid': user.id, ':token': apiToken, ':name': token_name || 'default' }
    );

    // Audit the login
    try {
      const auditReq = { user: { id: user.id }, org_id: 'org_personal' };
      auditLog(auditReq, 'auth.login', provider, { email: user.email, ip: req.ip });
    } catch {}

    res.json({
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name || providerUser.name,
        avatar_url: user.avatar_url || providerUser.avatar,
        role: user.role
      },
      token: apiToken
    });

  } catch (err) {
    console.error(`[PAN Auth] OAuth error (${provider}):`, err.message);
    res.status(401).json({ error: `Authentication failed: ${err.message}` });
  }
});

// POST /api/v1/auth/logout — revoke current token
router.post('/logout', (req, res) => {
  if (!req.user || !req.user.token_id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Audit the logout before revoking the token
  try {
    const auditReq = { user: { id: req.user.id }, org_id: req.org_id || 'org_personal' };
    auditLog(auditReq, 'auth.logout', null, { ip: req.ip });
  } catch {}

  run("DELETE FROM api_tokens WHERE id = :id", { ':id': req.user.token_id });
  res.json({ ok: true });
});

// GET /api/v1/auth/me — current user info
// Includes Tier 0 fields: display_nickname, active org slug + name + colors.
router.get('/me', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const user = get("SELECT * FROM users WHERE id = :id", { ':id': req.user.id });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const providers = get("SELECT provider FROM user_oauth WHERE user_id = :uid", { ':uid': user.id });

  // Tier 0: resolve the active org. last_active_org_id is set by the migration
  // to 'org_personal' for existing users; if anything is null, fall back to it.
  const activeOrgId = user.last_active_org_id || 'org_personal';
  const org = get("SELECT id, slug, name, color_primary, color_secondary, logo_url FROM orgs WHERE id = :id", { ':id': activeOrgId })
            || { id: 'org_personal', slug: 'personal', name: 'Personal', color_primary: '#f5c2e7', color_secondary: null, logo_url: null };

  res.json({
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    display_nickname: user.display_nickname || user.display_name,
    avatar_url: user.avatar_url,
    role: user.role,
    created_at: user.created_at,
    last_login: user.last_login,
    org: {
      id: org.id,
      slug: org.slug,
      name: org.name,
      color_primary: org.color_primary,
      color_secondary: org.color_secondary,
      logo_url: org.logo_url,
    },
  });
});

// GET /api/v1/auth/tokens — list user's active tokens
router.get('/tokens', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

  const tokens = get("SELECT id, name, created_at, last_used, expires_at FROM api_tokens WHERE user_id = :uid ORDER BY created_at DESC",
    { ':uid': req.user.id });

  res.json(tokens || []);
});

// DELETE /api/v1/auth/tokens/:id — revoke a specific token
router.delete('/tokens/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

  const tokenId = parseInt(req.params.id);
  const token = get("SELECT * FROM api_tokens WHERE id = :id AND user_id = :uid",
    { ':id': tokenId, ':uid': req.user.id });

  if (!token) return res.status(404).json({ error: 'Token not found' });

  run("DELETE FROM api_tokens WHERE id = :id", { ':id': tokenId });
  res.json({ ok: true });
});

// GET /api/v1/auth/providers — which OAuth providers are configured
// This is PUBLIC (no auth needed) so the login page knows which buttons to show
router.get('/providers', (req, res) => {
  const modeSetting = get("SELECT value FROM settings WHERE key = 'auth_mode'");
  let authMode = modeSetting?.value || 'none';

  // Auto-auth for localhost/Tailscale — skip login screen entirely
  const ip = req.ip || req.connection?.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip.endsWith('127.0.0.1') || ip === '::ffff:127.0.0.1';
  const isTailscale = ip.startsWith('100.') || ip.startsWith('::ffff:100.');
  if (isLocal || isTailscale) {
    authMode = 'none';
  }

  const providers = {};
  for (const p of ['google', 'microsoft', 'github', 'apple']) {
    const clientId = get("SELECT value FROM settings WHERE key = :k", { ':k': `oauth_${p}_client_id` });
    const clientSecret = get("SELECT value FROM settings WHERE key = :k", { ':k': `oauth_${p}_client_secret` });
    providers[p] = { configured: !!clientId?.value, client_id: clientId?.value || null };
  }

  res.json({ auth_mode: authMode, providers });
});

// POST /api/v1/auth/providers — save OAuth client IDs (owner only)
router.post('/providers', requireRole('owner'), (req, res) => {
  const { provider, client_id, client_secret } = req.body;
  if (!provider || !['google', 'microsoft', 'github', 'apple'].includes(provider)) {
    return res.status(400).json({ error: 'Invalid provider' });
  }

  if (client_id !== undefined) {
    run("INSERT OR REPLACE INTO settings (key, value) VALUES (:k, :v)", { ':k': `oauth_${provider}_client_id`, ':v': client_id || '' });
  }
  if (client_secret !== undefined) {
    run("INSERT OR REPLACE INTO settings (key, value) VALUES (:k, :v)", { ':k': `oauth_${provider}_client_secret`, ':v': client_secret || '' });
  }

  res.json({ ok: true });
});

// POST /api/v1/auth/mode — toggle auth mode (owner only)
router.post('/mode', requireRole('owner'), (req, res) => {
  const { mode } = req.body;
  if (!['none', 'token'].includes(mode)) {
    return res.status(400).json({ error: 'Mode must be "none" or "token"' });
  }
  run("INSERT OR REPLACE INTO settings (key, value) VALUES ('auth_mode', :v)", { ':v': mode });
  res.json({ ok: true, auth_mode: mode });
});

// POST /api/v1/auth/github-callback — exchange GitHub OAuth code for access token
// GitHub OAuth uses authorization codes, not id_tokens from browser
router.post('/github-callback', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });

  const clientId = get("SELECT value FROM settings WHERE key = 'oauth_github_client_id'");
  const clientSecret = get("SELECT value FROM settings WHERE key = 'oauth_github_client_secret'");
  if (!clientId?.value || !clientSecret?.value) {
    return res.status(400).json({ error: 'GitHub OAuth not configured' });
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: clientId.value, client_secret: clientSecret.value, code })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    // Now use the access token to get user info via the normal OAuth flow
    const providerUser = await verifyOAuthToken('github', tokenData.access_token);
    if (!providerUser.email) return res.status(400).json({ error: 'Could not get email from GitHub' });

    // Find or create user (same logic as /oauth)
    let user = get("SELECT * FROM users WHERE email = :email", { ':email': providerUser.email });
    if (!user) {
      const userCount = get("SELECT COUNT(*) as c FROM users WHERE email != 'owner@localhost'");
      const role = userCount.c === 0 ? 'owner' : 'user';
      const userId = insert(
        `INSERT INTO users (email, display_name, avatar_url, role) VALUES (:email, :name, :avatar, :role)`,
        { ':email': providerUser.email, ':name': providerUser.name, ':avatar': providerUser.avatar || null, ':role': role }
      );
      user = get("SELECT * FROM users WHERE id = :id", { ':id': userId });
      console.log(`[PAN Auth] New user via GitHub: ${providerUser.email} (${role})`);
    } else {
      run(`UPDATE users SET display_name = :name, avatar_url = COALESCE(:avatar, avatar_url), last_login = datetime('now','localtime') WHERE id = :id`,
        { ':name': providerUser.name, ':avatar': providerUser.avatar || null, ':id': user.id });
    }

    // Link OAuth provider
    const existingLink = get("SELECT * FROM user_oauth WHERE provider = 'github' AND provider_id = :pid", { ':pid': providerUser.providerId });
    if (!existingLink) {
      insert(`INSERT INTO user_oauth (user_id, provider, provider_id, provider_email) VALUES (:uid, 'github', :pid, :email)`,
        { ':uid': user.id, ':pid': providerUser.providerId, ':email': providerUser.email });
    }

    // Issue PAN token
    const apiToken = generateToken();
    insert(`INSERT INTO api_tokens (user_id, token, name) VALUES (:uid, :token, 'dashboard')`,
      { ':uid': user.id, ':token': apiToken });

    // Audit the login
    try {
      const auditReq = { user: { id: user.id }, org_id: 'org_personal' };
      auditLog(auditReq, 'auth.login', 'github', { email: user.email, ip: req.ip });
    } catch {}

    res.json({
      user: { id: user.id, email: user.email, display_name: user.display_name || providerUser.name, avatar_url: user.avatar_url || providerUser.avatar, role: user.role },
      token: apiToken
    });
  } catch (err) {
    console.error('[PAN Auth] GitHub callback error:', err.message);
    res.status(401).json({ error: `GitHub auth failed: ${err.message}` });
  }
});

// POST /api/v1/auth/google-callback — exchange Google OAuth code for PAN token
router.post('/google-callback', async (req, res) => {
  const { code, redirect_uri } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });

  const clientId = get("SELECT value FROM settings WHERE key = 'oauth_google_client_id'");
  const clientSecret = get("SELECT value FROM settings WHERE key = 'oauth_google_client_secret'");
  if (!clientId?.value || !clientSecret?.value) {
    return res.status(400).json({ error: 'Google OAuth not configured' });
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId.value,
        client_secret: clientSecret.value,
        redirect_uri: redirect_uri || `${req.protocol}://${req.get('host')}/auth/google/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    // Verify the id_token to get user info
    const providerUser = await verifyOAuthToken('google', tokenData.id_token);
    if (!providerUser.email) return res.status(400).json({ error: 'Could not get email from Google' });

    // Find or create user
    let user = get("SELECT * FROM users WHERE email = :email", { ':email': providerUser.email });
    if (!user) {
      const userCount = get("SELECT COUNT(*) as c FROM users WHERE email != 'owner@localhost'");
      const role = userCount.c === 0 ? 'owner' : 'user';
      const userId = insert(
        `INSERT INTO users (email, display_name, avatar_url, role) VALUES (:email, :name, :avatar, :role)`,
        { ':email': providerUser.email, ':name': providerUser.name, ':avatar': providerUser.avatar || null, ':role': role }
      );
      user = get("SELECT * FROM users WHERE id = :id", { ':id': userId });
      console.log(`[PAN Auth] New user via Google: ${providerUser.email} (${role})`);
    } else {
      run(`UPDATE users SET display_name = :name, avatar_url = COALESCE(:avatar, avatar_url), last_login = datetime('now','localtime') WHERE id = :id`,
        { ':name': providerUser.name, ':avatar': providerUser.avatar || null, ':id': user.id });
    }

    // Link OAuth provider
    const existingLink = get("SELECT * FROM user_oauth WHERE provider = 'google' AND provider_id = :pid", { ':pid': providerUser.providerId });
    if (!existingLink) {
      insert(`INSERT INTO user_oauth (user_id, provider, provider_id, provider_email) VALUES (:uid, 'google', :pid, :email)`,
        { ':uid': user.id, ':pid': providerUser.providerId, ':email': providerUser.email });
    }

    // Issue PAN token
    const apiToken = generateToken();
    insert(`INSERT INTO api_tokens (user_id, token, name) VALUES (:uid, :token, 'dashboard')`,
      { ':uid': user.id, ':token': apiToken });

    // Audit the login
    try {
      const auditReq = { user: { id: user.id }, org_id: 'org_personal' };
      auditLog(auditReq, 'auth.login', 'google', { email: user.email, ip: req.ip });
    } catch {}

    res.json({
      user: { id: user.id, email: user.email, display_name: user.display_name || providerUser.name, avatar_url: user.avatar_url || providerUser.avatar, role: user.role },
      token: apiToken
    });
  } catch (err) {
    console.error('[PAN Auth] Google callback error:', err.message);
    res.status(401).json({ error: `Google auth failed: ${err.message}` });
  }
});

// POST /api/v1/auth/dev-token — local/LAN emergency access (never get locked out)
router.post('/dev-token', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const raw = ip.replace('::ffff:', '');
  const isLocal = raw === '127.0.0.1' || ip === '::1' || ip === 'localhost';
  const isLAN = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(raw);
  if (!isLocal && !isLAN) {
    return res.status(403).json({ error: 'Dev access only available from local network' });
  }

  // Issue a token for the owner user (id=1)
  const owner = get("SELECT * FROM users WHERE id = 1");
  if (!owner) return res.status(500).json({ error: 'No owner user found' });

  const apiToken = generateToken();
  insert(`INSERT INTO api_tokens (user_id, token, name) VALUES (:uid, :token, 'dev-access')`,
    { ':uid': owner.id, ':token': apiToken });

  console.log('[PAN Auth] Dev token issued from localhost');
  res.json({
    user: { id: owner.id, email: owner.email, display_name: owner.display_name, role: owner.role },
    token: apiToken
  });
});

// GET /api/v1/auth/users — list all users (admin+ only)
router.get('/users', requireRole('admin'), (req, res) => {
  const users = all("SELECT id, email, display_name, avatar_url, role, is_active, created_at, last_login FROM users ORDER BY id");
  res.json(users || []);
});

// PUT /api/v1/auth/users/:id/role — change user role (owner only)
router.put('/users/:id/role', requireRole('owner'), (req, res) => {
  const { role } = req.body;
  const validRoles = getRoleLevels();
  if (!validRoles[role]) {
    return res.status(400).json({ error: 'Invalid role', valid: Object.keys(validRoles) });
  }
  const userId = parseInt(req.params.id);
  if (userId === req.user.id && role !== 'owner') {
    return res.status(400).json({ error: 'Cannot demote yourself' });
  }
  run("UPDATE users SET role = :role WHERE id = :id", { ':role': role, ':id': userId });
  res.json({ ok: true });
});

// === ROLE MANAGEMENT (owner only) ===

// GET /api/v1/auth/roles — list all roles
router.get('/roles', requireRole('admin'), (req, res) => {
  const roles = all("SELECT * FROM roles ORDER BY level ASC");
  res.json(roles || []);
});

// POST /api/v1/auth/roles — create a custom role
router.post('/roles', requireRole('owner'), (req, res) => {
  const { name, level, description, permissions, color } = req.body;
  if (!name || typeof level !== 'number') {
    return res.status(400).json({ error: 'name (string) and level (number 0-100) required' });
  }
  if (level < 0 || level > 100) {
    return res.status(400).json({ error: 'level must be 0-100' });
  }
  try {
    const id = insert(
      "INSERT INTO roles (name, level, description, permissions, color) VALUES (:name, :level, :desc, :perms, :color)",
      { ':name': name.toLowerCase(), ':level': level, ':desc': description || null, ':perms': JSON.stringify(permissions || []), ':color': color || null }
    );
    res.json({ ok: true, id, name: name.toLowerCase(), level });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Role already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/auth/roles/:id — update a role
router.put('/roles/:id', requireRole('owner'), (req, res) => {
  const { name, level, description, permissions, color } = req.body;
  const roleId = parseInt(req.params.id);
  const existing = get("SELECT * FROM roles WHERE id = :id", { ':id': roleId });
  if (!existing) return res.status(404).json({ error: 'Role not found' });

  // Prevent modifying owner role's level
  if (existing.name === 'owner' && level !== undefined && level !== 100) {
    return res.status(400).json({ error: 'Cannot change owner role level' });
  }

  run("UPDATE roles SET name = COALESCE(:name, name), level = COALESCE(:level, level), description = COALESCE(:desc, description), permissions = COALESCE(:perms, permissions), color = COALESCE(:color, color) WHERE id = :id", {
    ':name': name?.toLowerCase() || null, ':level': level ?? null, ':desc': description || null,
    ':perms': permissions ? JSON.stringify(permissions) : null, ':color': color || null, ':id': roleId
  });
  res.json({ ok: true });
});

// DELETE /api/v1/auth/roles/:id — delete a custom role (can't delete defaults)
router.delete('/roles/:id', requireRole('owner'), (req, res) => {
  const roleId = parseInt(req.params.id);
  const existing = get("SELECT * FROM roles WHERE id = :id", { ':id': roleId });
  if (!existing) return res.status(404).json({ error: 'Role not found' });

  const defaults = ['viewer', 'user', 'manager', 'admin', 'owner'];
  if (defaults.includes(existing.name)) {
    return res.status(400).json({ error: 'Cannot delete default roles' });
  }

  // Check if any users have this role
  const usersWithRole = get("SELECT COUNT(*) as c FROM users WHERE role = :role", { ':role': existing.name });
  if (usersWithRole?.c > 0) {
    return res.status(400).json({ error: `${usersWithRole.c} users have this role. Reassign them first.` });
  }

  run("DELETE FROM roles WHERE id = :id", { ':id': roleId });
  res.json({ ok: true });
});

export default router;
