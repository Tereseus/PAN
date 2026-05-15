# PAN Architecture

> **This is the architectural source of truth.** CLAUDE.md is a quick reference;
> FEATURES.md is the per-widget spec; this doc explains **what each section
> IS** and how the system is organized as a whole. Update this doc when you
> add a new module that doesn't fit cleanly into an existing section.

---

## TL;DR

PAN is **8 functional sections**. **Intuition is the cortex** — about half the
codebase by weight and the part that defines what PAN actually does. The
other seven exist to feed it, execute its decisions, or wrap it in safety.

```
                   ┌─── INTUITION (cortex) ───┐
                   │  perceives, decides       │
                   └──┬───────────────────┬────┘
               feeds  │                   │  commands
                      ▼                   ▼
        ┌──────────────────┐    ┌──────────────────┐
        │  MEMORY (food)   │    │ CAPABILITIES     │
        │                  │    │ (skills, MCP)    │
        └──────────────────┘    └────────┬─────────┘
                                         │ executed by
                                         ▼
                               ┌──────────────────┐
                               │ JOBS / ORCHESTR. │
                               └────┬──────┬──────┘
                                    │      │
                             uses ┌─┘      └─┐ over
                                  ▼          ▼
                             ┌────────┐  ┌────────┐
                             │DEVICES │  │ COMMS  │
                             └────────┘  └────────┘

        ┌── LEARNING / METABOLISM ──┐   ┌── SECURITY + GOV ──┐
        │  scout · dream · evolve   │   │   wraps all        │
        │  autodev · benchmark      │   │   ────────────     │
        └───────────────────────────┘   └────────────────────┘
               (self-loop on              (governs every
                every other layer)         section)
```

| # | Section | Role | Weight |
|---|---|---|---|
| 1 | **Intuition** | Perceive Commander's state, decide what (if anything) PAN should do | ~50% |
| 2 | **Memory** | Persistence that feeds Intuition with context, history, semantic facts | ~15% |
| 3 | **Capabilities** | The verb dictionary — what PAN *can* do (skills, MCP tools, modules) | ~8% |
| 4 | **Jobs / Orchestration** | Execution backbone — scheduling, queueing, watchdogs, runners | ~5% |
| 5 | **Devices** | Hardware reach — phone, desktop, client PCs, pendant, home assistant | ~7% |
| 6 | **Comms** | Channels in/out — TTS, push, chat, voice, email, Discord/Telegram | ~5% |
| 7 | **Learning / Metabolism** | PAN improving itself — model hunting, dreaming, evolution, auto-skills | ~7% |
| 8 | **Security + Governance** | Org isolation, encryption, anonymization, permissions, meta-rules | ~3% |

Cross-cutting (not a section, but shows up everywhere):
- **Three-tier process hierarchy** — Super-Carrier (7777, permanent) / Carrier
  (17760, restartable) / Craft (17700, hot-swappable). Deployment topology,
  not a functional layer. See `docs/SUPER-CARRIER.md`.
- **Event bus** — currently implicit via DB inserts to `events` + WS broadcasts.
  When/if it gets formalized, it belongs as its own subsection of Intuition.

---

## 1. Intuition (cortex)

The dominant section. About half of PAN. Intuition perceives Commander's
state, holds an opinion about that state, and decides whether to act.

### Sub-systems

| Subsystem | Role | Today | Status |
|---|---|---|---|
| **Sensors** | Multi-modal input — eyes, ears, presence | `screen-watcher.js`, `webcam-watcher.js`, `activity-tracker.js`, `transcript-watcher.js`, pendant (in dev), mic via `dictate-vad.py` / `whisper-server.py` | Live |
| **State** | The 6-axis snapshot of Commander right now: Where, Activity, Focus, Mood, Urgency, Engagement, Assumption | `intuition.js` snapshot builder + Cerebras classifier | Live |
| **Life Needs** | Sims-style motive bars (0–100) — Nourishment, Hydration, Rest, Social, Connection, Health-Physical, Health-Mental, Fun, Environment, Admin, Curiosity, Safety. Per-user weights so things the user never registers don't dominate. | — | **Planned** (next build) |
| **Identity** | Who is the person in front of PAN? Face + voice + body + behavior fusion into a single cluster. | `webcam-watcher.js` (face), voice enrollment, identity events. Fragments only. | Partial — fusion missing |
| **Mind** | First-person reasoning trace — modeled on Claude's extended thinking. Every reasoning event writes one short sentence describing what PAN concluded. | `thoughts.js` + `pan_thoughts` table + MCP tool + dashboard panel | Live |
| **Scorer** | Utility AI — ranks candidate actions by how well they satisfy current needs/signals given device, channel, and context | `smart-router.js` (currently scores devices/apps; will extend to actions) | Live for devices, **needs extension** for actions |
| **Action engine** | Picks the winning action, dispatches it through Comms+Devices, dedupes by candidate-identity (not by time) | — | **Planned** — currently no PAN-initiated dispatcher exists; only user-initiated `router.js` |

### Design rules

- **Event-driven, not timer-driven.** Every sensor event (new screen capture,
  utterance, sensor tick, mood change, calendar boundary) is a trigger to
  re-deliberate. There is no 60s clock.
- **Deliberation is cheap; action is rare.** Write a thought every time
  something changes. Only dispatch an action when score ≥ autonomy threshold.
- **No time-based cooldown.** Dedupe by candidate identity — the same
  interjection doesn't repeat until its underlying condition changes (or the
  user dismisses / completes it).
- **All channels, always.** When PAN acts, the message goes to every present
  channel (phone TTS, dashboard ΠΑΝ thread, desktop TTS, client-PC toast,
  phone push) — not pick-one.
- **Per-individual weighting.** If a user never registers loneliness, the
  Social need decays slower and weighs less in scoring. Learned from
  dismissals + thanks.

### Scoping rule — needs are body, snapshots are org

The unit of "who/where" inside Intuition is **NOT uniformly the user**. Two
different physical things live here and they scope differently:

| Subsystem | Scope unit | Why |
|---|---|---|
| **Life Needs** (`pan_needs`, `pan_need_events`) | **user_id only** | Hydration, hunger, rest are facts about one human body. Same body in personal-org vs work-org has the same hydration — no org column. Cross-user separation is handled by user_id (different humans = different rows). |
| **Needs-derived interjections** | **user_id only** | "Drink water" is for the body, not for a workspace. Delivered to the user's personal channel regardless of which org they're operating in. |
| **PAN's Mind / thoughts** (`pan_thoughts`) | **user_id only** | First-person reasoning trace is one person's PAN thinking about one person. Org-level reasoning (a work-PAN reasoning about a whole company) is a separate future feature. |
| **Individual snapshots** (`intuition_snapshots`) | **org_id + user_id** | The situational snapshot reflects the *context* the user is operating in — work meeting vs home cooking. Same body, different context → different snapshot. |
| **Org snapshots** (`org_intuition_snapshots`) | **org_id** | Aggregated view of all members + devices in an org. |
| **Org-derived interjections** (future) | **org_id** | "Your standup is in 5min" — origin is the work calendar, delivery scoped to that org's ΠΑΝ thread, members of that org see it. |

Federation between sovereign PAN nodes (your personal-PAN and a company's
work-PAN) is the layer above this — see `docs/FEDERATION.md` (planned) and
task #485. The above scoping holds *within one PAN server*. Cross-server
sharing is a separate, opt-in, signed-envelope protocol.

### File layout (planned refactor)

```
service/src/intuition/
  index.js          # tick loop + public API (replaces monolithic intuition.js)
  sensors.js        # subscribes to screen/webcam/activity/voice events
  state.js          # Where/Activity/Focus/Mood/Urgency/Engagement/Assumption
  needs.js          # Life Needs — motive bars, decay, weights, event hooks
  identity.js       # person ID — wraps webcam + voice + behavior fragments
  mind.js           # moved from thoughts.js — thought stream
  scorer.js         # utility AI — reuses smart-router scoring patterns
  dispatch.js       # action delivery — calls pan-notify + TTS + push
```

Until the refactor lands, the bullets above all live (uncomfortably) inside
`service/src/intuition.js` (1000+ lines), `thoughts.js`, `smart-router.js`,
`screen-watcher.js`, and `webcam-watcher.js`.

---

## 2. Memory (food for Intuition)

Persistence layer. Exists so Intuition has context, history, and semantic
recall. Memory doesn't make decisions; it answers questions Intuition asks.

### Sub-systems

| Subsystem | Role | Files |
|---|---|---|
| Event log | Append-only stream of everything that happened | `db.js`, `events` table, `wrap_messages` |
| Three-tier vector memory | Episodic (what happened), Semantic (facts), Procedural (how) | `memory/episodic.js`, `memory/semantic.js`, `memory/procedural.js`, `memory/embeddings.js` |
| FTS5 search | Full-text query across all memory | `memory-search.js`, `events_fts` |
| Memory pipeline | capture → classify → consolidate → evolve → dream → inject | `memory/consolidation.js`, `evolution/engine.js`, `dream.js`, `memory/context-builder.js` |
| Context injection | Builds the SessionStart bundle for fresh Claude sessions | `memory/context-builder.js`, `routes/hooks.js` |
| Per-org isolation | Each org has its own encrypted DB | `org-db.js`, `db-registry.js` |

See `docs/MEMORY-PIPELINE.md` for the full pipeline detail.

---

## 3. Capabilities (the verb dictionary)

What PAN *can do*, as a function library. A capability is a verb —
distinct from a device (where it runs) and a job (when it runs).

| Subsystem | Files |
|---|---|
| Skills (Anthropic-style autoloaded capabilities) | `skills/`, `skills.js` |
| Modules (plug-in features) | `modules/`, `modules.js` |
| Wrappers (action shims) | `wrappers/` |
| MCP server (exposes capabilities to Claude Code) | `mcp-server.js` |
| Voice command router (maps user utterance → capability) | `router.js`, `context-router.js` |
| Skill auto-generation | `hooks/skill-learner.js` |

---

## 4. Jobs / Orchestration (execution backbone)

The plumbing that turns a "PAN should X" decision into actual work running on
a device. Owns scheduling, queueing, retries, watchdogs.

| Subsystem | Files |
|---|---|
| Job scheduler | `jobs.js` |
| Orchestrator | `orchestrator.js` |
| Service health (auto-restart) | `steward.js`, `dashboard-watchdog.js` |
| Task runner | `routes/runner.js`, `project-runner.js` |

---

## 5. Devices (hands & feet)

Hardware reach. Where work executes.

| Tier | Files / endpoints |
|---|---|
| Phone (Android/Kotlin) | `android/`, LogShipper, voice pipeline |
| Desktop (Tauri shell, port 7790) | AHK hotkeys, PTY tabs, screen capture |
| Server (Node.js, 7777) | this codebase |
| Client PCs | `pan-client/`, `client-manager.js`, `routes/client.js` |
| Pendant (ESP32-S3, in dev) | `docs/PENDANT*`, BLE → phone |
| Home Assistant bridge | `home-assistant` skill |
| Cross-platform abstractions | `platform.js` |
| Discovery / handoff | `discovery.js`, `hub-client.js`, `hub-crypto.js` |
| Process tiers | `super-carrier.js`, `carrier.js`, `server.js` (Craft) — see `docs/SUPER-CARRIER.md` |

---

## 6. Comms (mouth & ears)

Message channels in/out. Distinct from Devices: a channel can ride multiple
devices, and one device can host multiple channels.

| Channel | Files |
|---|---|
| TTS (out) | `tts.js`, `tts-worker.py`, Android TTS, `pan-voice.cs/.exe` |
| STT (in) | `dictate-vad.py`, `whisper-server.py`, Google streaming STT (phone) |
| Dashboard chat threads | `routes/chat.js`, ΠΑΝ system thread |
| Phone push / notifications | mobile dashboard, LogShipper |
| Email | `routes/email.js`, `email.js` |
| Discord | `discord` skill |
| Telegram | `telegram` skill |
| Service messaging | `pan-notify.js` (Scout/Dream/Pipeline → user) |
| Messaging preferences | `routes/messaging-prefs.js` |

---

## 7. Learning / Metabolism (PAN improving itself)

The self-loop. PAN finds better models for itself, dreams to reorganize its
own memory, evolves stale memory away, scans its own stack for issues,
auto-generates skills from novel sessions.

This is where PAN is the *subject*, not the user.

| Subsystem | Role | Files |
|---|---|---|
| Scout | Hunts better models when Intuition Test scores drop, submits as config change | `scout.js` |
| Dream cycle | 6-hourly memory reorganization | `dream.js` |
| Evolution engine | Merges, decays, bumps memory items | `evolution/engine.js` |
| AutoDev | Autonomous development loop | `autodev.js` |
| Benchmarks | Performance tracking over time | `benchmark.js`, `perf/` |
| Stack scanner | Dependency / vulnerability awareness | `stack-scanner.js` |
| Self-monitoring | GitHub issues, error patterns | `github-monitor.js`, `issue-checker.js` |
| Skill auto-gen | Stop-hook generates `SKILL.md` for novel sessions | `hooks/skill-learner.js` |
| Operating modes | dev / prod / incognito / etc | `mode.js` |
| Resistance | rate limiting + back-pressure | `resistance.js` |

---

## 8. Security + Governance (skin & meta-rules)

Wraps every other section. Two adjacent concerns kept together:

- **Security** = who can see what, where data lives, how it's encrypted
- **Governance** = what PAN is allowed to do on the user's behalf

| Subsystem | Files |
|---|---|
| Orgs (per-org DBs, roles, ACL) | `routes/orgs.js`, `org-db.js`, `org-policy.js` |
| Auth + tokens | `routes/auth.js`, `api_tokens` table |
| Audit log | `routes/audit.js` |
| Privacy controls + anonymization | `routes/privacy.js`, `anonymize.js`, `anonymizer.js`, `sensitivity.js` |
| Incognito sessions | `routes/incognito.js` |
| Permissions (action-level gating) | `permissions.js`, `routes/preferences.js` |
| Zones (geofencing) | `routes/zones.js` |
| Guardian (guardrails on outputs) | `guardian.js`, `routes/guardian.js` |
| Hooks (SessionStart/End, etc.) | `routes/hooks.js`, `hooks/` |
| SQLCipher encryption | DB layer |
| Tailscale VPN | infra |
| Cloudflare tunnel | `cloudflare-tunnel.js` |

---

## Where to find things — file-to-section map (quick reference)

| File / dir | Section |
|---|---|
| `intuition.js`, `thoughts.js`, `screen-watcher.js`, `webcam-watcher.js`, `activity-tracker.js`, `transcript-watcher.js`, `face-id.js`, `classifier.js`, `verifier.js` | Intuition |
| `smart-router.js` | Intuition (scorer) — currently also serves Devices |
| `memory/`, `memory-search.js`, `evolution/`, `dream.js`, `db.js`, `org-db.js`, `db-registry.js`, `schema.sql`, `migrations/` | Memory |
| `skills/`, `skills.js`, `modules/`, `modules.js`, `wrappers/`, `mcp-server.js`, `router.js`, `context-router.js`, `hooks/skill-learner.js` | Capabilities |
| `jobs.js`, `orchestrator.js`, `steward.js`, `dashboard-watchdog.js`, `project-runner.js`, `routes/runner.js` | Jobs |
| `terminal.js`, `super-carrier.js`, `carrier.js`, `platform.js`, `wezterm.js`, `playwright-bridge.js`, `discovery.js`, `hub-client.js`, `hub-crypto.js`, `client-manager.js`, `routes/client.js`, `routes/devices.js`, `screen-recorder.js`, `screen-buffer.js`, `remote-screen-watcher.js`, `pan-client/` | Devices |
| `tts.js`, `tts-worker.py`, `whisper-server.py`, `dictate-vad.py`, `audio-recorder.py`, `pan-voice.cs/.exe`, `pan-notify.js`, `routes/email.js`, `routes/chat.js`, `routes/messaging-prefs.js`, `email.js` | Comms |
| `scout.js`, `dream.js`, `evolution/`, `autodev.js`, `benchmark.js`, `perf/`, `stack-scanner.js`, `github-monitor.js`, `issue-checker.js`, `hooks/skill-learner.js`, `mode.js`, `resistance.js` | Learning |
| `routes/orgs.js`, `routes/auth.js`, `routes/audit.js`, `routes/privacy.js`, `routes/incognito.js`, `routes/zones.js`, `routes/guardian.js`, `routes/preferences.js`, `routes/hooks.js`, `anonymize.js`, `anonymizer.js`, `sensitivity.js`, `permissions.js`, `org-policy.js`, `guardian.js`, `cloudflare-tunnel.js` | Security + Governance |

---

## Judgment calls

Real architectures have fuzzy edges. Calling them out so the next person
doesn't think the table above is more precise than it is:

- **`smart-router.js` straddles Intuition and Devices.** It scores devices
  AND will score actions. Filed under Intuition (scorer) but it also belongs
  to Devices when picking *which* device runs an action. Don't try to clean
  this up — the overlap is real.
- **`steward.js` is in Jobs but also Devices.** It restarts services
  (Devices) on a schedule (Jobs).
- **`router.js` is in Capabilities but also Comms** — it parses user voice
  input (Comms) and dispatches it to capabilities.
- **`hooks/skill-learner.js` is in Learning but also Capabilities** — it
  generates capabilities through learning.
- **The MCP server is the bridge** between PAN's capabilities and external
  Claude Code instances. Lives in Capabilities, but functionally it's a
  cross-process integration layer.

When in doubt: a file belongs where its *primary mutation* happens. If it
writes mostly to `pan_thoughts` or `intuition_snapshots`, it's Intuition.
If it writes to `memory_items` or `episodic_memories`, it's Memory.

---

## Relationship to other docs

- **`CLAUDE.md`** — onboarding + commands + recent-session context. Links here for "what is each section".
- **`docs/FEATURES.md`** — per-widget, per-endpoint, per-button feature spec. Says what each UI element does and what it calls.
- **`docs/MEMORY-PIPELINE.md`** — deep dive into Memory section.
- **`docs/SUPER-CARRIER.md`** — deep dive into the 3-tier process hierarchy (deployment, not function).
- **`docs/MULTI-DEVICE-ROUTING.md`** — deep dive into Devices section.
- **`docs/NIGHTMARE_BUGS.md`** — recurring bugs whose root causes are architectural; read before fixing any of them.
- **This doc** — the only one that says **what each functional section IS** and how they relate.
