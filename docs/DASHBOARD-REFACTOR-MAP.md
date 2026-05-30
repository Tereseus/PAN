# Dashboard Terminal Refactor — Working Map

**Started:** 2026-05-27. Owner: in-progress Shape-2 refactor breaking `terminal/+page.svelte` (13,048 lines) into per-widget components.

> **For the full per-widget reference — file paths, props, WS events, API endpoints, line counts — see [`DASHBOARD-WIDGETS.md`](./DASHBOARD-WIDGETS.md).** This file is the chronological progress log; that one is the authoritative catalog.

## Cumulative progress

**File size journey:** `terminal/+page.svelte` **13,048 → 7,341 lines** (−5,707 / −44%). 28 widget components + 1 modal + 11 domain stores + 2 utility modules. All build-green.

### Center column + Usage extraction (2026-05-28, fourth push)

Five more widgets out, plus one more store:

- **PtyStatusBar.svelte** (~50 lines): the status pill under the center column (Ready / Thinking / no-PTY + pid + uptime + last-input/output ago + client count). Reads `terminal` store.
- **ApprovalBar.svelte** (~25 lines): the 1/2/3 approval-prompt buttons. Reads `terminal.approvalOptions`. `onApprove(num)` callback.
- **CenterChatView.svelte** (~50 lines): center-column chat bubble view + scroll-position persistence. Bindable `scrollElBind` so parent can pin-scroll.
- **ImagePreviewBar.svelte** (~35 lines): pasted-image thumbnails with ✕ to remove. Reads `terminal.pastedImages`. `onRemove(idx)` callback.
- **UsagePanel.svelte** (~190 lines): right-column usage view — This Session / Claude Plan Limits or Gemini / Burn Rate / All Sessions (today + week) / PAN Stats. Reads `usage` + `terminal` stores. The `sessionCost` $derived inside the component reads the active tab's `getPushed` from the terminal store (last `turn_stats` message) — no more parent-derived state.
- **`lib/stores/usage.svelte.js` (new)**: usage data + 30s polling + `formatTokens` + `formatResetTime`.
- **`terminal` store extended** with `pipeSending`, `approvalOptions`, `centerChatMessages`, `centerChatLoading`, `centerChatUserScrolledUp`, `pastedImages` so the new widgets have a single source of truth.

The center column's remaining inline pieces (xterm-style HTML container with `termContainerEl` ref, the input bar with model dropdown + send + voice mic + Call Π) **stay in parent** — they're tied to native DOM refs and the WS send path. Cleaning these out without rewriting WS logic was out of scope for this session.

### Atlas + Perf extraction (2026-05-28, third push)

- **AtlasPanel.svelte** (~250 lines): center-column SVG orrery (`centerView === 'atlas'`). Planets/moons/devices/projects orbit the central PAN-server sun with data-flow particles, pan + zoom + drag, detail panel on click. Reads from `atlas` store; uses `setLeftSection` from terminal store for the "Go to Devices/Projects" nav buttons.
- **`lib/stores/atlas.svelte.js`** (new): all orrery state + `loadAtlasData` (30s refresh) + animation tick + `buildAtlasGraph` (planet/moon/device topology) + pan/zoom handlers.
- **PerfPanel.svelte** (~280 lines): the Performance widget, lifted out of the `{#snippet perfPanelContents()}` block. Same template, rewired to read everything from the perf store.
- **`lib/stores/perf.svelte.js`** (new): the comprehensive perf store — `loadTimings`, `sendTimings`, `widgetHealth`, `wsMsgCounts`/`wsTotalMsgs`/`wsLastMsgTs`, plus the carrier perf engine data (`data`, `processes`, `services`, `other`, `server`, `trace`, `traceLoadedOnce`, `panelView`). Exports `markLoad`/`markSend`/`markSendPhase`/`trackWidget`/`trackWsMsg` for parent's 27+ instrumentation call sites to import as aliases (no callsite rewrites needed). Plus loaders, pollers, constants (`STAGE_LABELS`, `LOAD_STAGE_ORDER`, `PERF_PHASE_LABELS`, `PERF_PHASE_ORDER`), and `fmtMs` helper.

Saved ~982 more lines from `+page.svelte` this push (Atlas template + state ~430, Perf state + functions + snippet template ~552).

### Mail + Contacts extraction (2026-05-28, second push)

Two more widgets out of `+page.svelte`, plus two new domain stores:

- **ContactsPanel.svelte** (~190 lines): DM thread view + add-contact form + contacts list (Π pinned + favorites + others). Single prop `switchCenterView` so opening a DM can flip the center column to `'chat'`. Everything else flows through the chat store.
- **MailPanel.svelte** (~75 lines): inbox view with sync button, connect-status pill, message list with subject/preview, pagination. No props.
- **`lib/stores/chat.svelte.js` expanded**: now also holds `threads`, `inputText`, `callActive`, `addContactOpen`, the four `newContact*` form fields. Mutators added: `loadContacts`, `loadChatThreads`, `loadChatMessages`, `openChat`, `sendChatMessage`, `addContact`, `deleteContact`, `toggleFavorite`, `startCall`, `endCall`. Component registers its DM scroll-container ref via `setChatMessagesEl(el)` so the store can pin scroll-to-bottom after a fetch.
- **`lib/stores/mail.svelte.js` (new)**: full inbox state + `loadMail` / `loadMailStatus` / `syncMail` / `formatMailDate` exports.
- **`lib/compose.js` (new)**: `openCompose(contact, prefillSubject, prefillEmail)` and `openExpandedView(section)` — spawn Tauri popout windows with browser-popup fallback.

Parent's call overlay (top-level modal) updated to read `chat.callActive` + `chat.activeThread` from the store and call `storeEndCall` instead of the deleted local function.

Saved 387 lines from the inline templates plus ~200 lines of state/function declarations.

### Centralized state architecture (2026-05-28)

### Centralized state architecture (2026-05-28)

User pushed back on the prop-drilling approach. Built per-domain stores so
shared state has one canonical home each:

| New store | Owns | Replaced prop on |
|---|---|---|
| `org.svelte.js` | `org.data` (org context), `org.permsMatrix` | IntuitionPanel, UsersPanel |
| `voice.svelte.js` | `voice.settings`, `voice.availableModels`, `voice.localModels` | BenchmarksPanel |
| `project.svelte.js` | `project.data`, `project.tasks`, `project.sections`, `project.milestoneFilter` | ProjectPanel, TasksPanel, BugsPanel |
| `devices.svelte.js` | `devices.all`, `devices.panClients`, `devices.metrics` (+ `approveClient`/`denyClient` mutators) | DevicesPanel, AppsPanel |
| `services.svelte.js` | `services.list`, `services.lifeboat` | ServicesPanel |
| `chat.svelte.js` | `chat.bubbles`, `chat.activeThread`, `chat.messages`, `chat.contacts`, `chat.searchQuery`, `chat.unreadTotal` | TranscriptPanel |
| `lib/stores/index.js` | barrel re-export so widgets can `import { org, devices } from '$lib/stores'` | — |

**Migration shape:** parent's local `let foo = $state(...)` declarations stay
as the canonical write site (the WS handlers and fetch loaders already
target them). A single block of `$effect(() => { storeName.field = foo; })`
mirror declarations near the top of the script copies each one into the
matching domain store on change. Widgets now `import` directly from the
stores instead of receiving props.

Widgets re-shaped this session to read from stores instead of taking props:

- **ServicesPanel** — `services.list`
- **TranscriptPanel** — `chat.bubbles`
- **UsersPanel** — `org.permsMatrix`
- **IntuitionPanel** — `org.data`
- **BenchmarksPanel** — `voice.settings`
- **DevicesPanel** — `devices.all` / `devices.panClients` / `devices.metrics` (+ `approveClient`/`denyClient` mutators)
- **AppsPanel** — `devices.all`
- **ProjectPanel** — `project.data` + `filterByMilestone` mutator
- **TasksPanel** — `project.tasks` + `project.milestoneFilter`
- **BugsPanel** — `project.tasks`

`+page.svelte` mounts simplified accordingly: `<DevicesPanel />` instead of
`<DevicesPanel {allDevices} {panClientDevices} {deviceMetrics} onApprove=… onDeny=… />`. The "what props does this widget take" mental overhead is gone.

Confirmed by inspecting `package.json`: **xterm.js is loaded as a dep but NOT imported in any Svelte source**. The server uses `@xterm/headless` to render terminal output into HTML chunks delivered over WS; the dashboard just innerHTMLs them into the `term-container` div. This significantly de-risks the eventual Center column extraction — no canvas binding to be careful around.

### Bugs fixed in place (this session)

| Bug | Symptom | Fix |
|---|---|---|
| Model dropdown stuck on old value after switch | User picks new model, dropdown still shows old | `tabs = tabs` self-assignment is a no-op on Svelte 5 proxies. Changed to `tabs = [...tabs]` so the `value={...}` re-evaluates. See L6091. |
| "Claude is thinking…" stuck after Escape | Input stayed disabled until page refresh | Escape now optimistically resets local state (`claudeReady = true`, `pipeSending = false`, `pendingSendCount = 0`, `_sendTimings.awaitingAssistant = false`) in BOTH the main terminal input handler (L3482) and the center chat input handler (L3541). The server's confirming state push will reconcile when it arrives, but the user can type again immediately. |

**Backup:** Full pre-refactor repo at `%USERPROFILE%/Desktop/PAN-backup-2026-05-27/` (35 GB).

| Status | Item | Lines |
|---|---|---|
| ✅ | CLAUDE.md banner overrides (Svelte file-creation + Dashboard widgets reference) | — |
| ✅ | `lib/stores/terminal.svelte.js` foundation store + #444 message-store helpers | 172 |
| ✅ | `lib/components/widgets/IntuitionPanel.svelte` | 811 |
| ✅ | `lib/components/modals/ImpersonatePanel.svelte` | 381 |
| ✅ | `lib/components/widgets/TestsPanel.svelte` (this session) | ~340 |
| ✅ | `lib/components/widgets/DevicesPanel.svelte` (this session) | ~190 |
| ✅ | `lib/components/widgets/AppsPanel.svelte` | 160 |
| ✅ | `lib/components/widgets/LifeboatPanel.svelte` | 146 |
| ✅ | `lib/components/widgets/AlertsPanel.svelte` | 145 |
| ✅ | `lib/components/widgets/BenchmarksPanel.svelte` | 135 |
| ✅ | `lib/components/widgets/UsersPanel.svelte` | 121 |
| ✅ | `lib/components/widgets/PipelinePanel.svelte` | 100 |
| ✅ | `lib/components/widgets/TeamsPanel.svelte` | 85 |
| ✅ | `lib/components/widgets/LibraryPanel.svelte` | 82 |
| ✅ | `lib/components/widgets/ApprovalsPanel.svelte` | 67 |
| ✅ | `lib/components/widgets/InstancesPanel.svelte` | 55 |
| ✅ | `lib/components/widgets/TasksPanel.svelte` | 55 |
| ✅ | `lib/components/widgets/ServicesPanel.svelte` | 46 |
| ✅ | `lib/components/widgets/ProjectPanel.svelte` | 43 |
| ✅ | `lib/components/widgets/BugsPanel.svelte` | 29 |
| ✅ | `lib/components/widgets/SetupPanel.svelte` | 11 |
| ⏸ | **Center column** (Terminal + Transcript + chat send) — Task #6, where the 4 bugs live | ~1500 inline |
| ⏸ | Mail + Compose + Contacts | ~700 inline |
| ⏸ | Perf (the `{#snippet perfPanelContents()}` block + ~25 state vars) | ~315 + state |
| ⏸ | Usage (right-column body inline rendering, uses `sessionCost` $derived) | ~250 inline |

## Folder layout (this session)

Moved from flat `lib/components/*.svelte` to:

```
lib/
├── stores/
│   └── terminal.svelte.js         (was lib/stores-terminal.svelte.js)
└── components/
    ├── widgets/                   (18 dashboard panel widgets)
    └── modals/                    (1 modal — ImpersonatePanel)
```

All `$lib/components/*.svelte` imports in `+page.svelte` were updated to the new subfolder paths.

## File anatomy (current monolith)

| Section | Line range | Approx lines | Notes |
|---|---|---|---|
| `<script>` | 1 – 6166 | ~6,170 | State, runes, fetches, handlers, 24 setInterval, 57 setTimeout |
| Template HTML | 6168 – 10227 | ~4,060 | Lots of `{#snippet}` blocks already (good — easy lift point) |
| `<style>` | 10228 – 13048 | ~2,820 | Global + scoped styles. Most can stay until each component takes its own |

## Script section headers (the natural seams)

| Line | Section | Move to |
|---|---|---|
| L1–148 | Load/send timers, widget health tracker, WS msg counter | `lib/stores/perf.svelte.js` + `lib/components/PerformancePanel.svelte` |
| L181–212 | tabs / activeTabId / projects / left+right panel selectors | `lib/stores/terminal.svelte.js` (the foundation store, Task #2) |
| L214 | Permission matrix | `lib/stores/perms.svelte.js` + helper |
| L218–301 | Impersonation modal | `lib/components/ImpersonatePanel.svelte` |
| L469–~750 | Intuition state ("DEAD SIMPLE" block) | `lib/components/IntuitionPanel.svelte` (Task #3) |
| L762–~950 | Widget self-identification contract (task #504, dashboard self-heal L1) | `lib/components/widget-health/` — separate concern |
| L950–~995 | Beta Pipeline state | `lib/components/PipelinePanel.svelte` |
| L996–1011 | Chat / Contacts state | `lib/components/ChatContactsPanel.svelte` |
| L1012–1238 | Mail + Compose (opens Tauri windows) | `lib/components/MailPanel.svelte` + `ComposePanel.svelte` |
| L1264–~1500 | Call Π (Comms quick-action) | `lib/components/CallPiPanel.svelte` |
| L3531–3554 | Architectural fix for nightmare bug #444 (the proxy/raw split fix) | Carries into `lib/stores/terminal.svelte.js` — single source of truth for chatBubbles |
| L3983–4043 | Slash command interception | `lib/components/TerminalPanel.svelte` (Task #6) |
| L5574–~5870 | Desktop dashboard telemetry (task #505) | Separate utility module — not a UI panel |
| L5874–6166 | UNIFIED RESTORE (tab state restoration on load) | Foundation store init logic |

## Template structure (high-level, lines 6168–10227)

The template uses Svelte 5 `{#snippet name()}` / `{@render name()}` heavily for the sidebar widgets, so panels can already be picked from left or right column dropdowns. This is good — it means each snippet is a near-extractable component.

Known snippets observed (need full template scan to enumerate):
- `perfPanelContents` (L6178) — Performance panel body
- (more to be enumerated when reading lines 6168–10227 in extraction steps)

## Shared state (what goes in the foundation store, Task #2)

These are referenced by 2+ widgets, so they belong in `lib/stores/terminal.svelte.js`:

| State | Currently at | Used by |
|---|---|---|
| `projects` | L182 | project picker, terminal, intuition |
| `tabs`, `activeTabId`, `allProjectTabs` | L183–185 | tabs strip, terminal, transcript |
| `claudeReady`, `ptyStatus`, `pendingSendCount` | L366, L374, L368 | terminal, intuition (status badge), perf panel |
| `permsMatrix` | L216 | every panel's visibility check |
| `terminalInputText` | L361 | terminal panel — persisted via store already |
| `leftSection`, `rightSection`, `centerView` | L207–209 | layout shell — stays in `+page.svelte` after refactor |
| `_widgetHealth`, `_wsMsgCounts`, `_wsTotalMsgs`, `_wsLastMsgTs` | L121–134 | perf panel + cross-widget health |
| `_loadTimings`, `_sendTimings` | L10, L41 | perf panel |
| WS connection lifecycle | scattered | EVERYTHING — must be single canonical WS in the store |
| `_pushedMsgsCache` (per `terminal.js` nightmare-bug #444 fix) | search for `_pushedMsgsCache` | terminal + transcript panels |

## Bug-fix hit list for Task #6 (TerminalPanel extraction)

While extracting `TerminalPanel.svelte`, fix these in the same pass — they're all rooted in the monolith's shared mutable state:

1. **13 `loadChatHistory` call sites** → collapse to one, gated on "WS empty AND no `_pushedMsgsCache` hit"
2. **`claudeRunning` read from 4 places** → make it a single `$derived` from `ptyStatus` + adapter state
3. **Escape → IDLE transition** stuck WORKING after interrupt → on `interrupt` event, force `claudeReady = true` after server ACK
4. **Model dropdown** doesn't actually trigger `pipeSetModel` on change → wire onchange to WS send
5. **5 `transcript_messages` handlers** → exactly one, in the foundation store, all other components subscribe via `$derived`

## Test gate after each step

After every extraction step, verify in Electron dev window:
- Dashboard renders without console errors
- The extracted widget shows the same data as before
- No other widget regressed (clicking around the dashboard works)
- The PTY session in the active tab still receives keystrokes

Don't move to the next step until all four pass.

## Build reminder

After ANY .svelte edit: `cd service/dashboard && npm run build` — prod and dev both serve from `service/public/v2/`. Forgetting this is why "I changed the file but nothing happened" appears in transcripts.
