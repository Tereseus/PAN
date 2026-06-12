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

// feature -> profiles it runs in. 'full' implicitly includes everything;
// listing it keeps the table explicit and greppable.
const FEATURES = {
  // ── presence / sensors (DEGRADE-class; opt-in toggles arrive in Phase 4) ──
  screen_watch:        ['full'],
  webcam:              ['full'],
  activity_tracker:    ['full'],
  remote_screen:       ['full'],   // polls pan-clients for their screens
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

export function featureEnabled(name) {
  const profiles = FEATURES[name];
  if (!profiles) return true; // unknown feature: fail-open (protects `full`)
  return profiles.includes(PROFILE);
}

// One-line boot summary so every log makes the active profile obvious.
export function profileSummary() {
  if (!IS_CORE) return `[PAN] Boot profile: ${PROFILE} (everything enabled)`;
  const off = Object.keys(FEATURES).filter(f => !featureEnabled(f));
  return `[PAN] Boot profile: core — ${off.length} features gated off: ${off.join(', ')}`;
}
