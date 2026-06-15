// PAN boot profiles — which subsystems start. (SHIP-PLAN.md Phase 1)
//
// One codebase, two profiles:
//   full  — the personal PAN, everything on. DEFAULT: no env var = full,
//           so this deployment's behavior is byte-identical to pre-profiles.
//   core  — the shippable subset: memory spine + capture + MCP + voice +
//           intuition. No watchers (camera/screen/activity are opt-in via
//           feature toggles later — Phase 4), no experimental loops, no
//           multi-org/enterprise routes, no network extras (tunnel,
//           discovery, firewall).
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

// feature -> where it runs. Two value shapes:
//   ['full', ...]  — runs in the listed profiles (most features).
//   'optin'        — OFF in every profile (including full) unless the env var
//                    PAN_ENABLE_<NAME>=1 is set. Use for privacy-sensitive
//                    capture the user must consciously turn on.
const FEATURES = {
  // ── presence / sensors (DEGRADE-class) ──
  // NOTE: the three user-facing capture features — identity (camera), screen,
  // and activity — are NOT gated here. They live in capture-consent.js, which
  // layers a live, DB-backed consent toggle (the /privacy page) on top of the
  // profile default. profiles.js only owns boot-time, non-user-toggled gates.
  remote_screen:       ['full'],   // polls pan-clients for their screens (multi-device)
  dashboard_watchdog:  ['full'],   // currently neutered anyway (early return)
  dashboard_health:    ['full'],   // dashboard render QA
  vision_verifier:     ['full'],   // vision-vs-DOM bug filing
  forge_dashboard:     ['full'],   // experimental auto-fix loop

  // ── experiments / autonomous loops ──
  smart_steward:       ['full'],
  claude_control:      ['full'],   // computer-use PTY — opt-in later
  benchmarks_daily:    ['full'],

  // ── multi-device network extras (single-machine core needs none of these) ──
  tailscale_cleanup:   ['full'],
  public_tunnel:       ['full'],
  lan_discovery:       ['full'],
  firewall_rule:       ['full'],
  personal_sync:       ['full'],   // T3 cross-node sync loop

  // ── full-only route groups (mount gating; modules still load) ──
  routes_sensors:          ['full'],
  routes_runner:           ['full'],
  routes_incognito:        ['full'],
  routes_audit:            ['full'],
  routes_replication:      ['full'],
  routes_zones:            ['full'],
  routes_sync:             ['full'],
  routes_orgs:             ['full'],
  routes_email:            ['full'],
  routes_teams:            ['full'],
  routes_wrap:             ['full'],
  routes_messaging_prefs:  ['full'],
  routes_benchmark:        ['full'],
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
  if (!IS_CORE) {
    return `[PAN] Boot profile: full (everything enabled) · opt-ins: ${optInState}`;
  }
  const off = Object.keys(FEATURES).filter(f => !featureEnabled(f));
  return `[PAN] Boot profile: core — ${off.length} features off: ${off.join(', ')}`;
}
