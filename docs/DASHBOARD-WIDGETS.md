# Dashboard Widgets — Reference

The PAN dashboard (`service/dashboard/`) is a SvelteKit app. The terminal
page hosts a layout shell with three columns (left sidebar / center
terminal / right sidebar) and a dropdown on each sidebar lets the user pick
which **widget** to display. Each widget is its own Svelte 5 component with
its own state, polling, and WebSocket subscriptions.

Before the Shape-2 refactor (2026-05-27) every widget lived inline inside
one 13,048-line `terminal/+page.svelte`. That file is now 9,356 lines and
shrinking — see the table at the bottom for what's still inlined.

> **Working on a widget?** First check `docs/DASHBOARD-CSS-SCOPING.md` (the
> Svelte CSS-stripping trap for `{@html}` content) and `docs/NIGHTMARE_BUGS.md`
> (the 8 recurring bugs that have architectural causes — #444 in particular
> is the per-tab message-store proxy issue, which is fixed in the foundation
> store). Then read this file.

## Folder structure

```
service/dashboard/
├── src/
│   ├── app.html
│   ├── lib/
│   │   ├── api.js                          # fetch wrapper + wsUrl helper
│   │   ├── markdown.js                     # renderMarkdown(text) — shared by chat + xterm output
│   │   ├── stores.svelte.js                # cross-page state (active project, sidebar, etc.)
│   │   ├── stores/                         # ← 10 per-domain Svelte 5 stores (see "Centralized state" below)
│   │   │   ├── index.js                    # barrel re-export
│   │   │   ├── terminal.svelte.js          # PTY tabs + WS + #444 message map (foundation store)
│   │   │   ├── org.svelte.js               # org context + permissions matrix
│   │   │   ├── voice.svelte.js             # voice settings + model lists
│   │   │   ├── project.svelte.js           # active project + tasks + milestone filter
│   │   │   ├── devices.svelte.js           # device roster + pan-client list + metrics
│   │   │   ├── services.svelte.js          # system services + carrier/lifeboat
│   │   │   ├── chat.svelte.js              # chat bubbles + DM thread + contacts + calls
│   │   │   ├── mail.svelte.js              # inbox messages + sync status
│   │   │   ├── atlas.svelte.js             # SVG orrery view + pan/zoom + 30s refresh + animation tick
│   │   │   ├── perf.svelte.js              # all timing/health observation + perf-engine state
│   │   │   └── usage.svelte.js             # Claude/Gemini token + rate-limit usage
│   │   ├── components/
│   │   │   ├── widgets/                    # 18 panel widgets that mount in left/right column dropdowns
│   │   │   │   ├── AlertsPanel.svelte
│   │   │   │   ├── ApprovalsPanel.svelte
│   │   │   │   ├── AppsPanel.svelte
│   │   │   │   ├── BenchmarksPanel.svelte
│   │   │   │   ├── BugsPanel.svelte
│   │   │   │   ├── DevicesPanel.svelte
│   │   │   │   ├── InstancesPanel.svelte
│   │   │   │   ├── IntuitionPanel.svelte
│   │   │   │   ├── LibraryPanel.svelte
│   │   │   │   ├── LifeboatPanel.svelte
│   │   │   │   ├── PipelinePanel.svelte
│   │   │   │   ├── ProjectPanel.svelte
│   │   │   │   ├── ServicesPanel.svelte
│   │   │   │   ├── SetupPanel.svelte
│   │   │   │   ├── TasksPanel.svelte
│   │   │   │   ├── TeamsPanel.svelte
│   │   │   │   ├── TestsPanel.svelte
│   │   │   │   └── UsersPanel.svelte
│   │   │   └── modals/
│   │   │       └── ImpersonatePanel.svelte # owner-only impersonate modal
│   │   └── assets/                         # theme.js, icons, helpers
│   └── routes/
│       └── terminal/
│           └── +page.svelte                # layout shell + remaining inline panels (Mail/Compose/Contacts/Perf/Center)
└── package.json
```

## Widget catalog

Every widget below is a Svelte 5 component (`.svelte`) using runes
(`$state`, `$derived`, `$effect`) for fine-grained reactivity. Each one owns
its own state lifecycle — the parent never reaches into a widget's internals.

Communication patterns:
- **Reads from parent** via `$props()` for cross-cutting state the parent
  already owns (`orgData`, `voiceSettings`, `permsMatrix`, `isDev`, etc.).
- **Writes back to parent** via callback props (`onCycle`, `onApprove`).
- **Bindable counters** for badges in the dropdown (`bind:count`,
  `bind:openCount`).
- **WS events** flow parent → widget via `window.dispatchEvent(new
  CustomEvent('pan:<widget>-update'))`. The parent's WebSocket handler fires
  this when a `widget_update` frame arrives; the widget listens in
  `onMount` and re-fetches on receipt.

| Widget | File | Lines | Owns | Reads (props) | Writes (callback props / bindable) | WS event listened | API endpoints hit |
|---|---|---:|---|---|---|---|---|
| IntuitionPanel | `widgets/IntuitionPanel.svelte` | 811 | intuition roster + per-commander snapshots, PAN's Mind / Synthesis / thought stream / Motives, voice enrollment, force-cam-capture | `orgData` | — | `pan:intuition-update` | `/api/v1/orgs/:id/members`, `/api/v1/intuition/org/members`, `/api/v1/intuition/org/current`, `/api/v1/intuition/current`, `/api/v1/thoughts/recent`, `/api/v1/needs`, `/api/v1/pan/synthesis`, `/api/v1/voice/{status,speakers,record-enroll,speaker/:label}`, `/api/v1/webcam-watcher/{force,status}` |
| ImpersonatePanel | `modals/ImpersonatePanel.svelte` | 381 | modal open state, tab/slider/user/org selection, applying flag | — | `bind:open`, `onApplied()` | — | `/api/v1/users`, `/api/v1/orgs`, `/api/v1/roles`, `/api/v1/impersonate` |
| AppsPanel | `widgets/AppsPanel.svelte` | 160 | view mode (`'root'` / `'device:<host>'`), wrap services, opening state, APP_META catalog | `allDevices` | — | — | `/api/v1/wrap/services`, `/api/v1/wrap/open/:id`, `/api/v1/ui-commands` |
| LifeboatPanel | `widgets/LifeboatPanel.svelte` | 146 | carrier status, rollback countdown, swap-in-progress flag | — | — | — (polls every 30s) | `/api/carrier/status`, `/lifeboat/{status,rollback,confirm}`, `/api/carrier/swap` |
| AlertsPanel | `widgets/AlertsPanel.svelte` | 145 | alert list, types, status/type filters | — | `bind:openCount` | `pan:alerts-update` | `/dashboard/api/alerts`, `/dashboard/api/alerts/count`, `/dashboard/api/alerts/types`, `/dashboard/api/alerts/:id` (PATCH) |
| BenchmarksPanel | `widgets/BenchmarksPanel.svelte` | 135 | benchmark suite results, AutoDev report, running flag | `voiceSettings` | — | — (polls every 30s) | `/dashboard/api/benchmarks/latest`, `/dashboard/api/autodev/report`, `/api/v1/ai/benchmark{,/all}` |
| UsersPanel | `widgets/UsersPanel.svelte` | 121 | user list (per role/group), add-user form | `permsMatrix` | — | `pan:users-update` | `/api/v1/auth/users` |
| PipelinePanel | `widgets/PipelinePanel.svelte` | 100 | beta pipeline state, starting flag | — | — | `pan:pipeline-update` (+ polls every 10s) | `/api/carrier/pipeline/{status,start,abort,promote}` |
| TeamsPanel | `widgets/TeamsPanel.svelte` | 85 | teams list, selected team detail, member list | — | — | `pan:teams-update` | `/api/v1/teams`, `/api/v1/teams/:id` |
| LibraryPanel | `widgets/LibraryPanel.svelte` | 82 | items, type filter, search query | — | — | `pan:library-update` | `/api/v1/library`, `/api/v1/library/view`, `/api/v1/ui-commands` |
| ApprovalsPanel | `widgets/ApprovalsPanel.svelte` | 67 | pending PTY permission requests | — | `bind:count` | `pan:approvals-update` | `/api/v1/terminal/permissions{,/respond}` |
| InstancesPanel | `widgets/InstancesPanel.svelte` | 55 | (none — static) | `isDev` | — | — | `/api/v1/dev/{start,restart}`, `/api/v1/ui-commands` |
| TasksPanel | `widgets/TasksPanel.svelte` | 55 | (none — pure render of props) | `tasksData`, `milestoneFilter` | `onCycle(taskId, status)` | — | — |
| ServicesPanel | `widgets/ServicesPanel.svelte` | 46 | (none — pure render of props) | `servicesData` | — | — | — |
| ProjectPanel | `widgets/ProjectPanel.svelte` | 43 | (none — pure render of props) | `projectData` | `onMilestoneFilter(id)` | — | — |
| BugsPanel | `widgets/BugsPanel.svelte` | 29 | (none — derived bug filter of tasksData) | `tasksData` | `onCycle(taskId, status)` | — | — |
| SetupPanel | `widgets/SetupPanel.svelte` | 11 | (none — pure static) | — | — | — | — |

(TestsPanel + DevicesPanel — extracted this session. See "Recent additions" below.)

### Recent additions

| Widget | File | Lines | Notes |
|---|---|---:|---|
| TestsPanel | `widgets/TestsPanel.svelte` | ~340 | Full test runner — `runAllTests`, `runSuite`, plus all four client-side suite executors (`executePageRefreshTest` / `executeProtocolTest` / `executeWidgetTest` / `executeInputBoxTest`). Props: `isDev`, `getActiveTab`. |
| DevicesPanel | `widgets/DevicesPanel.svelte` | ~190 | Pending approvals + filter bar + category-grouped device rows with CPU/RAM/disk metric bars. Reads from `devices` store; mutators `approveClient` / `denyClient` are exported by the same store. No props. |
| TranscriptPanel | `widgets/TranscriptPanel.svelte` | 54 | Left-column chat-bubble view (user / assistant / tool / token-stats). Reads `chat.bubbles` from the chat store. Uses `renderMarkdown` from `$lib/markdown.js`. |
| ContactsPanel | `widgets/ContactsPanel.svelte` | ~190 | DM/contacts widget — three states: active DM thread (header + scrollable messages + input bar), add-contact form modal, or contacts list (Π pinned + favorites + others). Reads from `chat` store. Takes one callback prop `switchCenterView(view)` so opening a DM can flip the center column to `'chat'`. |
| MailPanel | `widgets/MailPanel.svelte` | ~75 | Inbox view — sync button, connect-status pill, message list with subject/preview, pagination. Reads from `mail` store. Click a row to open Compose pre-filled for reply. No props. |
| **AtlasPanel** | `widgets/AtlasPanel.svelte` | ~250 | Animated SVG orrery shown when `centerView === 'atlas'`. Planets / moons / devices / projects orbit around a central PAN-server sun with data-flow particles, pan + zoom + drag, click-to-select detail panel, and "Go to Devices/Projects" nav buttons (uses `setLeftSection` from terminal store). Reads from `atlas` store. No props. |
| **PerfPanel** | `widgets/PerfPanel.svelte` | ~280 | The Performance widget — readiness summary, List/Gantt of the carrier perf-trace DAG, send-timing breakdown, page-load trace, server/memory/uptime/connection metrics, slow-route bottlenecks, process liveness with kill buttons, widget-health tracker (push vs poll, stale flag), WS message-rate counter. Reads from `perf` store. No props. |
| **PtyStatusBar** | `widgets/PtyStatusBar.svelte` | ~50 | Thin status pill under the center column. Shows Ready / "Claude is thinking" / current tool / PTY metadata (pid, uptime, last-input-ago, last-output-ago, client count). Only renders when no approval prompt active. Reads `terminal` store. No props. |
| **ApprovalBar** | `widgets/ApprovalBar.svelte` | ~25 | The 1/2/3 (etc) buttons that replace the status pill when Claude shows a permission menu. Reads `terminal.approvalOptions`. Routes clicks back via `onApprove(num)` callback. |
| **CenterChatView** | `widgets/CenterChatView.svelte` | ~50 | Center-column chat view when `terminal.centerView === 'chat'`. Bubbles (user / assistant / tool) + "Thinking…" placeholder + scroll-position persistence. Reads `terminal.centerChatMessages`. Bindable `scrollElBind` so parent can pin scroll-to-bottom. |
| **ImagePreviewBar** | `widgets/ImagePreviewBar.svelte` | ~35 | Thumbnails of pasted images not yet sent. ✕ to remove. Reads `terminal.pastedImages`. `onRemove(idx)` callback. |
| **UsagePanel** | `widgets/UsagePanel.svelte` | ~190 | Right-column usage view. Five sections: This Session (derived from active tab's per-tab message map via `getPushed`), Claude Plan Limits OR Gemini CLI Usage, Burn Rate, All Sessions (today/week with cost estimate), PAN Stats. Reads `usage` + `terminal` stores. No props. |

### Shared utilities

| File | Lines | What |
|---|---:|---|
| `lib/markdown.js` | 67 | `renderMarkdown(text)` — light Markdown → HTML used by chat bubbles, transcript view, and xterm assistant-output styling. Lifted from the inline definition in `+page.svelte` so 4 use sites no longer duplicate the body. |
| `lib/compose.js` | ~50 | `openCompose(contact?, prefillSubject?, prefillEmail?)` and `openExpandedView(section)`. Both spawn a Tauri popout window (`POST` to `127.0.0.1:7790/open` or `/api/v1/popout`) with a browser-popup fallback. The actual compose UI lives at `/v2/compose`; these utils just open it. Used by ContactsPanel + MailPanel + parent toolbar buttons. |

## Centralized state — `lib/stores/`

The dashboard uses **per-domain Svelte 5 stores** so widgets read shared
state directly instead of receiving it via prop drilling. Each store is a
single `$state` object exported from a `.svelte.js` module, plus the
loaders/mutators that own its lifecycle.

```js
// Read in a widget
import { devices, approveClient } from '$lib/stores/devices.svelte.js';
devices.all;            // reactive — re-renders when parent updates
approveClient(deviceId); // mutator — updates the store
```

| Store file | Domain | Exported state | Used by widgets |
|---|---|---|---|
| `terminal.svelte.js` | PTY tabs + WS lifecycle + #444 message map | `terminal` ($state with tabs, activeTabId, ws, claudeReady, ptyStatus, permsMatrix, layout selectors) | (none yet — center column extraction will use this) |
| `org.svelte.js` | Org context + permissions | `org` ($state with `data`, `permsMatrix`) | IntuitionPanel, UsersPanel, ImpersonatePanel (modal) |
| `voice.svelte.js` | Voice settings + model lists | `voice` ($state with `settings`, `availableModels`, `localModels`) | BenchmarksPanel (and parent's UsagePanel inline rendering) |
| `project.svelte.js` | Active project + tasks + milestone filter | `project` ($state with `data`, `tasks`, `sections`, `milestoneFilter`) | ProjectPanel, TasksPanel, BugsPanel |
| `devices.svelte.js` | Device roster + pan-client list + metrics | `devices` ($state with `all`, `panClients`, `metrics`) | DevicesPanel, AppsPanel |
| `services.svelte.js` | System services + carrier/lifeboat state | `services` ($state with `list`, `lifeboat`) | ServicesPanel (LifeboatPanel still self-fetches but should migrate) |
| `chat.svelte.js` | Chat bubbles + DM thread + contacts + add-contact form + call state | `chat` ($state with `bubbles`, `activeThread`, `messages`, `contacts`, `threads`, `searchQuery`, `unreadTotal`, `inputText`, `callActive`, `addContactOpen`, new-contact form fields) + mutators (`loadContacts`, `openChat`, `sendChatMessage`, `addContact`, `deleteContact`, `toggleFavorite`, `startCall`, `endCall`) | TranscriptPanel, ContactsPanel; parent's call-overlay reads `chat.callActive` |
| `mail.svelte.js` | Inbox messages + sync status + pagination | `mail` ($state with `messages`, `loading`, `total`, `page`, `status`) + mutators (`loadMail`, `loadMailStatus`, `syncMail`, `formatMailDate`) | MailPanel |
| `atlas.svelte.js` | SVG orrery view data + interaction state | `atlas` ($state with `data`, `loading`, `transform`, `dragging`, `dragStart`, `hovered`, `selected`, `elapsed`) + mutators (`loadAtlasData`, `stopAtlasTimers`, `atlasNodeColor`, `atlasStatusDot`, `handleAtlasWheel`, `handleAtlasPointerDown`/Move/Up, `atlasResetView`) | AtlasPanel |
| `perf.svelte.js` | Page-load + send timings + widget health + WS counter + carrier perf engine data + UI state | `perf` ($state with `loadTimings`, `sendTimings`, `widgetHealth`, `wsMsgCounts`, `wsTotalMsgs`, `wsLastMsgTs`, `data`, `processes`, `services`, `other`, `server`, `trace`, `traceLoadedOnce`, `panelView`) + constants (`STAGE_LABELS`, `LOAD_STAGE_ORDER`, `PERF_PHASE_LABELS`, `PERF_PHASE_ORDER`) + helpers (`fmtMs`) + mutators (`markLoad`, `markSend`, `markSendPhase`, `trackWidget`, `trackWsMsg`, `loadPerfTrace`, `loadPerfProcesses`, `forceProbeStage`, `killProcess`, `postPerfEvent`, `startPerfPolling`, `stopPerfPolling`, `persistPanelView`) | PerfPanel; parent's 27+ instrumentation call sites import the `markLoad`/`markSend`/`markSendPhase`/`trackWidget`/`trackWsMsg` aliases |

**How the parent's local state stays in sync with the stores:** `+page.svelte`
keeps `let foo = $state(...)` as the canonical write site for its fetch
handlers and WS pushes. A single block of `$effect(() => { storeName.field
= foo; })` mirror declarations near the top of the script copies each one
into the matching domain store on change. Widgets read the stores and
always see what the parent last wrote. Look for `// Domain store mirroring`
in `+page.svelte`.

This pattern is deliberately one-way (parent → store). When a widget needs
to mutate shared state, it calls a **mutator function exported from the
store** (e.g. `approveClient`, `cycleTask`, `filterByMilestone`,
`stopImpersonation`). The mutator hits the API and updates the store
field, which re-flows through any other widget reading it. The parent's
`$effect` mirror catches the same change on the next tick.

### Foundation store — `lib/stores/terminal.svelte.js`

The first store created (originally as `stores-terminal.svelte.js`, since
moved into the stores folder). Module-level Svelte 5 reactive store that
holds state which crosses widget boundaries. Widgets import directly:

```js
import { terminal, getPushed, setPushed } from '$lib/stores/terminal.svelte.js';
terminal.tabs;        // read
terminal.tabs.push(t); // write — reactive
```

Owned state:
- **Tabs & projects**: `tabs`, `activeTabId`, `allProjectTabs`, `restoringTabs`, `projects`
- **WebSocket lifecycle**: `ws`, `wsState`, `wsLatencyMs`, `wsLastMsgAt`
- **PTY / Claude status**: `claudeReady`, `ptyStatus`, `ptyStatusNow`, `pendingSendCount`
- **Permissions**: `permsMatrix`
- **Layout**: `leftSection`, `rightSection`, `centerView`
- **Reactive version counter**: `_storeVersion` (bumped by message-store mutations)

**The per-tab message store (nightmare-bug #444 fix)** lives here too. Three
parallel maps per tab — `pushed[]`, `echoes[]`, `btws[]` — accessed only via
helper functions: `setPushed(tabId, msgs)`, `getPushed(tabId)`,
`pushEcho(tabId, msg)`, `getEchoes(tabId)`, `setEchoes(tabId, msgs)`,
`pushBtw(tabId, msg)`, `getBtws(tabId)`, `clearTabStore(tabId)`. **Never put
messages on the tab object directly** — that's the Svelte-proxy-vs-raw split
that caused #444. See `docs/NIGHTMARE_BUGS.md` #444.

## Central WS event registry

When the parent's WebSocket handler receives a `widget_update` frame, it
dispatches a `window` CustomEvent. Widgets listen in `onMount` and unbind in
`onDestroy`.

| Event name | Dispatched from | Listened by |
|---|---|---|
| `pan:intuition-update` | parent WS handler on `widget_update:'intuition'` | IntuitionPanel |
| `pan:alerts-update` | parent WS handler on `widget_update:'alerts'` (+ 2 min poll fallback) | AlertsPanel |
| `pan:approvals-update` | parent WS handler on `widget_update:'approvals'` (+ 2 min poll fallback) | ApprovalsPanel |
| `pan:library-update` | parent WS handler on `widget_update:'library'` | LibraryPanel |
| `pan:users-update` | parent WS handler on `widget_update:'users'` | UsersPanel |
| `pan:teams-update` | parent WS handler on `widget_update:'teams'` | TeamsPanel |
| `pan:tests-update` | parent WS handler on `widget_update:'tests'` | TestsPanel |
| `pan:pipeline-update` | parent WS handler on `pipeline_event` | PipelinePanel |

Don't invent new event names. If a new widget needs a WS push, follow the
`pan:<widget>-update` convention and add a row to this table.

## How to extract a new widget (the pattern)

When `+page.svelte` still has a panel inlined and you want to extract it:

1. **Create the component file** under `lib/components/widgets/<Name>Panel.svelte`.
2. **Move the state** (`let foo = $state(...)`) into the component's `<script>` block.
3. **Move the loaders** (`async function loadFoo() { ... }`). If they have to
   call back into the parent (e.g. need `getActiveTab`), make those callbacks
   props with safe defaults.
4. **Move the template block** out of the giant `{:else if leftSection === 'foo'}`
   chain in `+page.svelte`, and replace both render sites (left + right
   column) with `<FooPanel ... />`.
5. **Subscribe to WS pushes** in `onMount`:
   ```js
   let _wsHandler = null;
   onMount(() => {
     loadFoo();
     _wsHandler = () => loadFoo();
     window.addEventListener('pan:foo-update', _wsHandler);
   });
   onDestroy(() => window.removeEventListener('pan:foo-update', _wsHandler));
   ```
6. **Update the parent's WS handler** for `widget_update:'foo'`:
   ```js
   } else if (w === 'foo') {
     window.dispatchEvent(new CustomEvent('pan:foo-update'));
   }
   ```
7. **Move panel-scoped CSS** into the component's `<style>` block. For
   styles shared with the parent (`.svc-*`, `.empty-state`, `.approval-*`),
   keep them in `+page.svelte` but wrap with `:global(.classname)` so they
   reach the child component's DOM. See `docs/DASHBOARD-CSS-SCOPING.md`.
8. **Build & verify**: `cd service/dashboard && npm run build` — the terminal
   page bundle should shrink by approximately the lines you moved.
9. **Add the widget to this doc's catalog table.**

The `Svelte file-creation override` banner at the top of `CLAUDE.md` was added
specifically to make this pattern the default for future sessions.

## Remaining inline panels in `+page.svelte`

These widgets still live inline in `service/dashboard/src/routes/terminal/+page.svelte`.
Ranked roughly by size / extraction effort:

| Inline panel | Approx lines | Why not extracted yet | Complexity |
|---|---:|---|---|
| **Center column** (Terminal + Transcript + chat send) | ~1500 | Task #6 — this is where the 4 specific bugs live (stuck "Claude is thinking", Escape→IDLE, model dropdown, transcript desync). Needs careful work. | hardest |
| **Mail + Compose + Contacts** | ~700 | Tangled with own modals (`addContactModal`, compose-in-Tauri-window), chat state, DM thread view | hard |
| **Perf** | ~315 (snippet) | Reads ~25 state vars (`_loadTimings`, `_sendTimings`, `_widgetHealth`, `perfData`, `perfTrace`, …) — some are written by other parts of the dashboard | medium-hard |
| **Usage** (right-column body) | ~250 | Tangled with `sessionCost $derived` which reads `getPushed` from the foundation store; Claude vs Gemini conditional rendering | medium |

Plus a couple of structural blocks the layout uses:
- The top toolbar (project selector + tab strip + impersonate banner)
- The image-paste preview bar
- A handful of small inline modals (add-contact, dev-server-error)

The center column is Task #6 in the project's TaskList. **That's where the
performance complaints actually live** (stuck input, full-page refresh feel,
transcript desync). The right call is to do it as its own focused session —
extracting it cleanly *and* fixing the four bugs in the same pass.

## Why component boundaries matter (Svelte 5 reactivity)

Svelte 5's fine-grained reactivity (`$state`, `$derived`, `$effect`) only
updates the parts of the DOM that depend on the state that changed — **but
only at component boundaries**. A single 13k-line `+page.svelte` defeats
this because every state mutation has to re-evaluate the whole template
tree. That's why the dashboard felt like it was constantly "refreshing
itself" before this refactor.

The user-visible wins from the Shape-2 refactor:
- Stuck-input bugs are mechanically less likely (single source of state per widget).
- Page-load time improves (the terminal page bundle dropped from ~311KB to ~236KB).
- New panels added by Claude sessions go to their own files instead of swelling the monolith — enforced by the `CLAUDE.md` "Svelte file-creation override" banner.

## See also

- `docs/DASHBOARD-REFACTOR-MAP.md` — session-by-session refactor progress log.
- `docs/NIGHTMARE_BUGS.md` — the 8 recurring bugs (especially #444 for the
  message-store proxy issue).
- `docs/DASHBOARD-CSS-SCOPING.md` — Svelte's CSS-stripping trap for
  `{@html}`-injected and `document.createElement`-built elements.
- `docs/TRANSCRIPT_SYSTEM.md` — chat-bubble lifecycle (the system Task #6
  needs to preserve while fixing the bugs).
- `CLAUDE.md` (project root) — the Svelte file-creation override banner +
  general project rules.
