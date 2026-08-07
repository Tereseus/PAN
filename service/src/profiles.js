// PAN boot profiles — which subsystems start.
// (SHIP-PLAN.md Phase 1 + NORTH-STAR-AUDIT.md wearable profile.)
//
// One codebase, three profiles:
//   full     — the personal PAN, everything on. DEFAULT (no env var = full),
//              byte-identical to pre-profiles.
//   core     — the shippable memory subset: DB + capture + MCP + voice +
//              intuition. No watchers, no experimental loops, no feature routes.
//   wearable — the north-star daily driver (NORTH-STAR-AUDIT.md). Voice +
//              WATCH + NOTIFY + voice-actions + the device/QR control mesh, but
//              NO browser dashboard (use Claude Code + the PAN MCP server) and
//              none of the dead dev loops. Turns ON more than core in places
//              (email watch, sensors, device mesh, claude-control, tailscale)
//              and turns OFF the SvelteKit dashboard + quality-log. Nothing is
//              deleted — "turn off, don't delete."
//
// This module gates STARTUP and MOUNTING, not code presence. Full-only
// route modules are still statically imported by server.js (several export
// helpers the boot path uses — see PAN-DEPENDENCY-MAP.md §1). Physically
// excluding code from a distribution is a packaging concern (Phase 5).
//
// Rules of use:
//   - server.js:  if (featureEnabled('screen_watch')) startScreenWatcher()
//                 if (featureEnabled('routes_zones')) app.use('/api/v1/zones', ...)
//   - steward.js: service entries carry `profiles: ['full']`; absence of the
//                 field means the service runs in every profile.
//
// Adding a feature? Add a row here, gate the start/mount site, done. If a
// feature isn't listed, featureEnabled() returns true (fail-open) so a
// missing row can never dark-launch a breakage in the full profile.

export const PROFILE = (process.env.PAN_PROFILE || 'full').toLowerCase();
export const IS_CORE = PROFILE === 'core';
export const IS_WEARABLE = PROFILE === 'wearable';

// feature -> where it runs. Two value shapes:
//   ['full', ...]  — runs in the listed profiles (most features).
//   'optin'        — OFF in every profile (including full) unless the env var
//                    PAN_ENABLE_<NAME>=1 is set. Use for privacy-sensitive
//                    capture the user must consciously turn on.
const FEATURES = {
  // ── presence / sensors (DEGRADE-class) ──
  // The three user-facing capture features (identity/screen/activity) are NOT
  // gated here — they live in capture-consent.js as per-device opt-in toggles
  // (the /privacy page). profiles.js only owns boot-time, non-user-toggled gates.
  remote_screen:       ['full'],            // polls pan-clients for their screens
  dashboard_watchdog:  ['full'],            // babysits the dashboard (off in wearable)
  dashboard_health:    ['full'],            // dashboard render QA
  vision_verifier:     ['full'],            // vision-vs-DOM bug filing
  forge_dashboard:     ['full'],            // experimental auto-fix loop

  // ── experiments / autonomous loops (OFF in core AND wearable) ──
  smart_steward:       ['full'],            // plain 60s steward suffices
  benchmarks_daily:    ['full'],
  personal_sync:       ['full'],            // T3 cross-node federation

  // ── voice-action executor — ON in wearable (north-star job 4) ──
  claude_control:      ['full', 'wearable'],

  // ── device mesh / transport / QR-onboarding — ON in wearable ──
  // The "add PAN to any computer via QR + control it over SSH" mesh + the
  // transport that reaches the phone/pendant. Load-bearing for wearable.
  tailscale_cleanup:   ['full', 'wearable'],
  // public_tunnel was ['full','wearable'] — i.e. ON BY DEFAULT. On boot it runs
  // `tailscale funnel <port>` and falls back to a Cloudflare Quick Tunnel, which
  // publishes the hub on the open internet. Verified 2026-08-07 from an external
  // URL with NO credentials: /health, /dashboard/api/stats (full event counts)
  // and /api/v1/settings (which contains API keys in plaintext) were all served.
  // /ws/terminal has no auth either. Convenience for QR onboarding is not worth
  // publishing the whole hub, so it is now opt-in: PAN_ENABLE_PUBLIC_TUNNEL=1.
  public_tunnel:       'optin',
  lan_discovery:       ['full', 'wearable'],
  firewall_rule:       ['full', 'wearable'],

  // ── browser dashboard UI — kept ON in wearable per user (Atlas + widgets live here) ──
  dashboard_ui:        ['full', 'core', 'wearable'],

  // ── browser xterm terminal (WS PTY server) — OFF in wearable ──
  // The dashboard's live shell surface: /ws/terminal PTY sessions, ScreenBuffer
  // rendering, reconnect tokens, /ws/panels + /ws/whisper proxying. Pure
  // dev-tool — replaced by Claude Code + the PAN MCP server. Critically, the
  // PHONE's voice-action path does NOT use this: it drives pipe-mode Claude
  // adapters over plain HTTP (/api/v1/terminal/pipe|send|messages|new), which
  // run without the WS server (terminal.js loads ScreenBuffer eagerly so
  // createPipeSession works standalone). So turning this OFF keeps the phone's
  // north-star job-4 voice actions working — no APK change. Gated at the boot
  // call in both carrier.js (prod: Carrier owns the PTY) and server.js
  // (standalone/dev). See docs/HANDOFF-WEARABLE.md Step 2.
  terminal_server:     ['full', 'core'],

  // ── route groups ──
  // Functional routes the wearable NEEDS (watch / privacy / durability):
  routes_sensors:          ['full', 'wearable'],  // capture/privacy control plane
  routes_incognito:        ['full', 'wearable'],  // no-trace capture
  routes_replication:      ['full', 'wearable'],  // backup/restore — never forgets
  routes_sync:             ['full', 'wearable'],  // cross-device DB sync
  routes_email:            ['full', 'wearable'],  // inbox = the in-repo cloud-watch source
  // Off in wearable (dashboard-dev / SaaS / off-mission):
  routes_runner:           ['full'],              // run dev servers — dashboard-dev
  routes_audit:            ['full'],              // enterprise hash-chain audit
  routes_zones:            ['full'],              // geofencing (unbuilt)
  routes_orgs:             ['full'],              // multi-tenant (org_personal middleware is separate)
  routes_teams:            ['full'],              // SaaS teams/projects
  routes_wrap:             ['full'],              // Tauri webview scrapers
  routes_messaging_prefs:  ['full'],
  routes_benchmark:        ['full'],              // model benchmarking
  routes_quality_log:      ['full'],              // Paean Records music subsystem — carved off
};

// Opt-in features default OFF; set PAN_ENABLE_<NAME>=1 to turn one on.
function optInEnabled(name) {
  const v = process.env[`PAN_ENABLE_${name.toUpperCase()}`];
  return v === '1' || v === 'true';
}

export function featureEnabled(name) {
  const spec = FEATURES[name];
  if (spec === undefined) return true;          // unknown feature: fail-open (protects `full`)
  if (spec === 'optin') return optInEnabled(name);
  return spec.includes(PROFILE);
}

// One-line boot summary so every log makes the active profile + opt-ins obvious.
export function profileSummary() {
  const optIns = Object.keys(FEATURES).filter(f => FEATURES[f] === 'optin');
  const optInState = optIns.map(f => `${f}=${featureEnabled(f) ? 'on' : 'off'}`).join(', ');
  if (PROFILE === 'full') {
    return `[PAN] Boot profile: full (everything enabled) · opt-ins: ${optInState}`;
  }
  const off = Object.keys(FEATURES).filter(f => FEATURES[f] !== 'optin' && !featureEnabled(f));
  return `[PAN] Boot profile: ${PROFILE} — ${off.length} features off: ${off.join(', ')} · opt-ins: ${optInState}`;
}
