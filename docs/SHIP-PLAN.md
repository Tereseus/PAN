# PAN Ship Plan

*Decided 2026-06-12, grounded in [PAN-DEPENDENCY-MAP.md](./PAN-DEPENDENCY-MAP.md).
This is the keep/cut/build/sequence document for making PAN installable by
other people without forking the codebase.*

## The strategy in one paragraph

Nothing gets deleted. One codebase, two boot profiles. **`full`** is the
personal PAN exactly as it runs today — every watcher, every experiment,
every widget. **`core`** is what a stranger installs: the memory spine, the
MCP access layer, and voice. The dependency map proved the watchers are all
DEGRADE-class (cutting their *startup* breaks nothing) and the experimental
loops are FREE-class removals — so `core` is achievable by gating startup,
not by surgery. The pitch for `core`: **"Every conversation you have with
any Claude, remembered, searchable, and usable by every other Claude —
auto-captured, encrypted, on your machine."**

---

## 1. KEEP — ships in `core` (the product)

| What | Why it's in |
|---|---|
| Boot chain (super-carrier / carrier / craft) | The engine. Invisible to users; hot-swap is an ops feature, not a pitch. |
| DB: SQLCipher + events spine + FTS + sessions/recaps | The moat. Auto-capture is what markdown/Obsidian systems can't do. |
| Claude Code capture hooks (`/hooks/*`) | Verified FULL capture, ~50–100ms end-to-end. The product's heartbeat. |
| MCP layer: stdio + `/mcp/pan` HTTP + plugin manifest | The access point for every LLM surface. Cleanest seam in the codebase. |
| Router + LLM fallback chain (Cerebras → Claude → local) | The brain behind voice and chat. |
| Voice: Whisper, TTS, EoT detection, barge-in, prosody | The second pillar. Sub-second and near-done. |
| Intuition cortex | Runs fine on whatever signals exist (degrades, never crashes). Ships ON with text-only signals; gets better when user opts into presence. |
| Steward (deterministic service manager) | Keeps Whisper/services alive. Boring and necessary. |
| Memory search (FTS + vector RRF) | The retrieve step. Needs *an* Ollama or falls back to FTS-only. |
| client-manager + pan-client | Multi-device. Load-bearing for remote Ollama — this is HOW a weak PC gets strong models (the "diesel computer" answer). Optional at install, supported. |
| Quality log (Paean) | Small, clean, already shipped. Demonstrates the "log anything, score anything" pattern. |

## 2. KEEP but OPT-IN — shipped, OFF by default

| What | Consent framing |
|---|---|
| webcam-watcher + face identity | "Let PAN know who's at the desk." Camera permission, per-feature toggle, big visible indicator. |
| screen-watcher | "Let PAN see what you're working on." Same treatment. |
| activity-tracker | "Track foreground apps for context." Least invasive, still opt-in. |
| claude-control (computer use) | "Let PAN run a Claude terminal that can act on this machine." Power-user toggle. |

Dependency map verdict: every one of these is DEGRADE-class. Opt-in costs
zero engineering beyond the toggle + UX. Identity gates nothing
security-wise, so off-by-default loses nothing structural.

## 3. FULL-PROFILE ONLY — stays in the repo, never starts in `core`

| What | Why it stays personal |
|---|---|
| AutoDev / Forge / Crucible / ShadowCraft / Evolution | R&D loops, not user value. FREE-class removals. |
| Smart Steward | Experimental, still throwing alert-type errors. |
| Scout / Dream / Orchestrator | Long-horizon personal automation; confusing to strangers. |
| Sensors UI + 22 sensor registry, zones, orgs/teams, replication, audit | Enterprise/pendant vision. Not built out, no audience yet. |
| Mail / contacts / photos / messaging | Wanted (messaging especially) but 4/10. Ship when real. |
| Dashboard widget zoo + terminal panel | Work happens in Claude surfaces; UI is admin scaffolding. `core` gets ONE minimal status page (services up, capture working, toggles). |
| dashboard-watchdog, vision-verifier | Already disabled / internal QA. |

## 4. BUILD — the new work, in order

### Phase 1 — the profile mechanism ✅ SHIPPED 2026-06-12
`service/src/profiles.js` is the single source of truth (29 gated features).
server.js gates watcher startups, experimental loops, network extras, and 13
full-only route mounts via `featureEnabled()`; steward entries carry
`profiles: ['full']` and are filtered out of boot/health/status in core.
Verified: dev-server with `PAN_PROFILE=core` → /health reports core, all 8
sampled full-only routes 404, MCP (15 tools) + quality-log + intuition +
events spine + capture hooks all green, steward registry filters 16 → 6
(classifier, embeddings, intuition, ollama, pan-server, whisper). Prod swap
with no env → `profile: full`, 13/16 services up (same as pre-change),
watchers fire on stagger, full-only routes 200.

Notes for later phases:
- Static imports kept; gating is behavioral. Physical code exclusion =
  packaging (Phase 5).
- Discovered: `node server.js` standalone (outside Carrier, outside
  dev-server) wedges during module load before listen — pre-existing,
  likely the task #61 boot mystery. Installs always boot via
  super-carrier→carrier→craft so not blocking, but Phase 3's installer
  must not use bare `node server.js`.
- db.js legacy-migration path fires on any empty PAN_DATA_DIR when
  `service/data/pan.db` exists — surprising for fresh installs; revisit in
  Phase 3.

### Phase 2 — close the capture gap (CORE DONE 2026-06-16)
Cloud Claudes (desktop app, Claude.ai, Cowork) had ZERO write-back — the
biggest gap vs. the pitch. Now closed:
1. ✅ **Passive floor** — every `/mcp/pan` tools/call logs an `McpToolCall`
   event (tool, arg keys, UA), excluding pan_search (noise) + pan_log_exchange
   (redundant). Surfaces that never log exchanges still leave a trail.
2. ✅ **`pan_log_exchange` tool** — remote Claude saves an exchange (user +
   assistant summary + topic) → POST `/api/v1/exchange` → `CloudExchange`
   event. Server `instructions` (both transports) nudge the model to call it
   when something's worth remembering.
3. ✅ **Searchable like CLI sessions** — fixed `extractEventText` (db.js +
   embedding worker) which returned null for CloudExchange, so they're now
   FTS-indexed + embedded. Verified at the DB layer: a logged exchange is
   found by both `data LIKE` (the path pan_search uses) and `events_fts MATCH`.
4. TODO (stretch): desktop-app transcript import sidecar — bulk-import full
   conversations rather than model-summarized exchanges.

**Follow-up found (perf, not capture):** `/dashboard/api/events?q=` (what
pan_search proxies to) uses `data LIKE '%q%'` — a full-table scan on 260k+
rows that times out under load. The `events_fts` index exists but this
endpoint doesn't use it. Switching pan_search to an FTS-backed fast path
(LIKE fallback) would make the whole memory-search experience fast. Adjacent
to task #63 (SQLite off main thread). Out of scope for write-back; flagged
for a dedicated pass.

### Phase 3 — the install path (~2–4 weeks)
- `core` single-machine install: one command (npx/installer), no Tailscale,
  no SQLCipher hand-setup (key already auto-generates), hooks written into
  `~/.claude/settings.json` **with explicit consent prompt**, MCP plugin
  auto-registered.
- Tiered LLM story documented honestly: Cerebras key (free, fast) OR local
  Ollama (private, needs hardware) OR Claude subscription. No "diesel
  computer" required for `core`.
- pan-client hardening for multi-device (the SYSTEM-account credential and
  PATH battles from 2026-06-10 must be installer-handled, not user-handled).

### Phase 4 — consent UX + minimal surface (IN PROGRESS)
- ✅ **Capture-consent control plane shipped** (2026-06-15). `capture-consent.js`
  owns the three user-facing capture features — identity (camera), screen,
  activity — resolving each on/off via env > DB setting > profile default
  (identity OFF everywhere; screen+activity ON in full, OFF in core). Toggling
  writes consent + start/stops the watcher LIVE (no restart). New
  `/api/v1/capture` API + standalone `/privacy` page (no build step, served in
  every profile). Camera `/force` gates on the consent resolver. Verified:
  live screen off→stops / on→restarts, persistence, camera stays off
  throughout. profiles.js handed these three to capture-consent.
- ✅ **Single status console shipped** (2026-06-15). `/status` (+ `/privacy`
  alias) is now the one page that replaces the widget zoo for core: Memory
  stats (events / memories / sessions / db size — the "what PAN remembers"
  pitch), live Capture toggles, a Voice info row (verified there's NO
  continuous hub mic — voice is push-to-talk only, so it's an honest info
  row not a fake toggle), Services health grouped by category, and the MCP
  connector with a live reachability check + copy button. Standalone HTML, no
  build step. Verified all four data sources live (capture, /dashboard/api/
  stats, /dashboard/api/services, /mcp/pan tools/list = 15).
- TODO: cloud-Claude capture write-back (Phase 2) — surface it here as a
  consented item once built.
- TODO (optional): mic/voice toggle only if a continuous listener is ever
  added; today there's nothing to gate.
- README + docs that lead with the memory demo, not the architecture.

### Phase 5 — ship
- Public repo (mirror or main), `core` as default profile.
- Demo video: "Claude remembers everything across every device and chat."
- Post where the audience already is: HN, r/LocalLLaMA, Claude power users.

## 5. What we are explicitly NOT doing

- Not forking into two repos. Profiles, not forks.
- Not deleting anything from `full` — the personal system keeps evolving.
- Not shipping computer use as a headline (slow until apps ship MCPs).
- Not building the privacy-heavy features (camera/screen) into the first
  impression. They exist behind consent for those who want them.
- Not polishing the dashboard. One status page.

## 6. Open decisions (not blockers, decide by Phase 3)

1. Name/positioning of `core` ("PAN", "PAN Memory", something else).
2. License (MIT vs. something protective of a future paid tier).
3. Voice in v1 of `core`, or fast-follow? (It works, but support surface
   doubles. Leaning: ship it, flagged beta.)
4. Public repo = this repo cleaned, or fresh mirror with history squashed
   (there are credentials/personal data in old commits — audit before
   either).
