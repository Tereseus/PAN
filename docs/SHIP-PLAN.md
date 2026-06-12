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

### Phase 1 — the profile mechanism (~1–2 weeks) ← everything depends on this
The 26 route imports in server.js are boot-fatal, so `core` requires a
mechanical pass: convert static imports to a profile-driven mount table
(lazy `await import()` per route group), and filter Steward's 16-service
registry by profile. Acceptance: `PAN_PROFILE=core` boots with zero
watchers, zero experimental loops, all memory/MCP/voice endpoints green;
`PAN_PROFILE=full` (default for this machine) behaves byte-identically to
today.

### Phase 2 — close the capture gap (~2–3 weeks)
Cloud Claudes (desktop app, Claude.ai, Cowork) currently have ZERO
write-back — the biggest gap vs. the pitch.
1. Cheap + immediate: every `/mcp/pan` tool invocation logs an event
   (tool, args summary, caller) — partial visibility for free.
2. Real fix: `pan_log_exchange` MCP tool + plugin instruction so remote
   Claudes write each user/assistant exchange back to events.
3. Stretch: desktop-app transcript import sidecar.

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

### Phase 4 — consent UX + minimal surface (~1–2 weeks)
- Opt-in toggles for §2 with plain-language explanations and indicators.
- One status page replaces the widget zoo in `core`.
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
