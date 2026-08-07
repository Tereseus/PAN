// PAN secret handling — one source of truth for "what is a credential".
//
// WHY THIS EXISTS (2026-08-07 incident):
// Every provider key lived as a plain row in the `settings` table, and
// GET /api/v1/settings returned the whole table verbatim with no auth in front
// of it. `public_tunnel` was ON by default, which publishes the hub on a
// Cloudflare Quick Tunnel / Tailscale Funnel. Result: a plain unauthenticated
// GET from the open internet returned the Tailscale OAuth client secret, the
// Google OAuth client secret, the Cerebras key and the Gemini key. Verified
// from outside the tailnet — the hostname resolved to Cloudflare anycast
// (104.16.x.x) and egressed over the physical NIC, not the tailnet.
//
// Two defences, both here:
//   1. isSecretKey()  — the settings API strips these from every response, so
//                       leaking the endpoint no longer leaks the credentials.
//   2. getSecret()    — resolves ENV FIRST, DB second. Lets you move keys out
//                       of the database at your own pace: set the env var and
//                       the DB row stops being consulted. Nothing breaks on day
//                       one because the DB is still the fallback.
//
// Env var naming: PAN_ + the setting key uppercased.
//   cerebras_api_key -> PAN_CEREBRAS_API_KEY
//   tailscale_oauth_client_secret -> PAN_TAILSCALE_OAUTH_CLIENT_SECRET
import { get } from './db.js';

// Known credential-bearing settings keys. Explicit list so a rename can't
// silently drop something out of redaction.
export const SECRET_KEYS = new Set([
  'anthropic_api_key',
  'openai_api_key',
  'gemini_api_key',
  'cerebras_api_key',
  'groq_api_key',
  'oauth_google_client_id',
  'oauth_google_client_secret',
  'tailscale_oauth_client_id',
  'tailscale_oauth_client_secret',
  'delete_password',
  'client_invite_tokens',
  'hass_token',
  'slack_bot_token',
  'github_token',
]);

// Belt and braces: anything whose NAME looks like a credential is redacted too,
// so a key added later is covered before anyone remembers to update the list.
// Deliberately does not match 'ollama_url', 'embedding_model', etc.
const SECRET_NAME_RE = /(^|_)(api_?key|secret|token|password|passwd|credential|client_secret)(_|$)/i;

export function isSecretKey(name) {
  if (!name) return false;
  return SECRET_KEYS.has(name) || SECRET_NAME_RE.test(name);
}

function envNameFor(key) {
  return 'PAN_' + String(key).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Resolve a secret: environment first, settings table second.
 * Returns null when neither is set.
 */
export function getSecret(key) {
  const fromEnv = process.env[envNameFor(key)];
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  try {
    const row = get('SELECT value FROM settings WHERE key = :k', { ':k': key });
    if (row && row.value != null) {
      // settings values are sometimes JSON-quoted strings
      return String(row.value).replace(/^"|"$/g, '').trim() || null;
    }
  } catch { /* db not ready — env-only is a valid state */ }
  return null;
}

/** True when a secret is configured anywhere, without revealing it. */
export function hasSecret(key) {
  return !!getSecret(key);
}

/** Where a given secret is coming from — for diagnostics, never the value. */
export function secretSource(key) {
  if (process.env[envNameFor(key)]) return 'env';
  try {
    const row = get('SELECT value FROM settings WHERE key = :k', { ':k': key });
    if (row && row.value) return 'database';
  } catch {}
  return 'unset';
}

/**
 * Strip credentials out of a settings object before it goes over the wire.
 * Returns a new object; adds `_secrets` listing which names exist and where
 * they resolve from, so the dashboard can render "configured / not configured"
 * without ever receiving the value.
 */
export function redactSettings(settings) {
  const safe = {};
  const present = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (isSecretKey(k)) {
      if (v !== null && v !== undefined && v !== '') present[k] = secretSource(k);
      continue; // omitted entirely — PUT is a partial merge, so nothing round-trips a mask back
    }
    safe[k] = v;
  }
  safe._secrets = present;
  return safe;
}

export function envNameForKey(key) {
  return envNameFor(key);
}
