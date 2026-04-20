# Transcript System Architecture

**Read this before touching anything in `terminal/+page.svelte` related to
transcripts, chat bubbles, or message rendering.**

---

## Two Panels, Two Renderers

The terminal page has two panels that both show transcript content:

| Panel | Renderer | Data source | DOM target |
|-------|----------|-------------|------------|
| **Right** (terminal) | `renderTranscriptToTerminal(tabData)` | `tabData._pushedMessages` (raw object) | `tabData.scrollbackDiv.innerHTML` |
| **Left** (chat bubbles) | `bubblesFromMessages(messages)` → `chatBubbles = b` | `_pushedMsgsCache` Map (bypasses proxy) | Svelte `{#each chatBubbles}` template |

They use the **same underlying message data** but different renderers.
`renderTranscriptToTerminal` produces tight terminal-style HTML lines.
`bubblesFromMessages` produces structured bubble objects for the Svelte template.

---

## The Raw Object vs Svelte Proxy Problem

**This is the #1 cause of "transcript not updating" bugs. Read carefully.**

`tabData` is a plain JS object created in `createTab()` and stored in
`tabs = [...tabs, tabData]` where `tabs` is a Svelte 5 `$state([])`.

There are now **two references** to the tab's data:
- `tabData` — the raw JS object, captured in the WS closure
- `tabs.find(t => t.id === tabData.id)` — a Svelte 5 reactive **Proxy** wrapping the same object

In Svelte 5, the Proxy maintains its own **internal tracked value** per property.
Writing through the Proxy updates both the tracked value AND the raw object.
But writing directly to the raw object (`tabData.x = value`) **only** updates the raw
object — the Proxy's tracked value stays stale.

### Consequence

```
WS handler:          tabData._pushedMessages = msg.messages   ← raw write
                                                               ↓
renderTranscriptToTerminal(tabData):  reads raw tabData       ✓ sees new data
                                                               ↓
BUT interval-based loadChatHistory() calls getActiveTab()
which returns the Svelte PROXY — proxy._pushedMessages is STALE
→ falls back to HTTP endpoint → returns older DB data
→ chatBubbles = oldData  ← left panel REVERTS to stale content
```

This is why the left panel would randomly revert: the 5s/15s refresh interval
overwrote live WS data with a stale HTTP response.

### The Fix: `_pushedMsgsCache`

A module-level `Map` lives **outside** the Svelte reactive system entirely:

```javascript
const _pushedMsgsCache = new Map(); // tabId → messages[]
```

The WS handler writes to it immediately after setting `tabData._pushedMessages`:

```javascript
tabData._pushedMessages = msg.messages || [];
_pushedMsgsCache.set(tabData.id, tabData._pushedMessages); // bypass proxy
```

`loadChatHistory` reads from the cache **first**, before any proxy or HTTP fallback:

```javascript
const pushed = _pushedMsgsCache.get(active?.id) || active._pushedMessages || [];
```

Result: **no interval call can ever overwrite live data with stale HTTP data.**
If the cache has data, it's used. The HTTP path only fires on fresh load before
the first `transcript_messages` event arrives.

---

## Message Flow: Server → Client

```
User sends message
      ↓
POST /api/v1/terminal/pipe
      ↓
terminal.js pipeSend() → ClaudeAdapter.send()
      ↓
ClaudeAdapter onMessage(messages) callback fires on every streaming chunk
      ↓
WS push: { type: 'transcript_messages', messages }
      ↓
Frontend handleMessage() → case 'transcript_messages'
      ↓
  tabData._pushedMessages = msg.messages
  _pushedMsgsCache.set(tabData.id, messages)      ← cache for proxy bypass
  tabData._echoMessages = (dedup filtered array)
  renderTranscriptToTerminal(tabData)              ← right panel (direct DOM write)
  if (activeTabId === tabData.id):
    chatBubbles = bubblesFromMessages(messages)    ← left panel (direct Svelte state)
```

**There is no file watcher** for real-time push. `subscribeToTranscript` is imported
but not used for live updates. Messages come directly from the LLM adapter's
`onMessage` callback in `terminal.js`.

---

## Tab Identity

```javascript
const tabId = 'tab-' + (++tabCounter);  // 'tab-1', 'tab-2', etc.
const tabData = {
  id: tabId,          // used to find the tab: tabs.find(t => t.id === tabId)
  sessionId,          // e.g. 'dash-pan-1714000000000' — the WS/PTY session
  claudeSessionIds,   // e.g. ['abc123'] — the Claude JSONL session ID(s)
  ...
};
activeTabId = tabId;  // tracks which tab is visible
```

`tabData.id !== tabData.sessionId`. Don't confuse them.
`tabData.id` is `'tab-N'`. `tabData.sessionId` is the long dash-prefixed string.

---

## WS Event Types That Touch Transcript

| Event | What it does |
|-------|-------------|
| `transcript_messages` | Full message push from LLM adapter. Updates cache + raw object, renders both panels directly. |
| `chat_update` | Claude session ID registered. Updates `claudeSessionIds`, calls `loadChatHistory(tabData)` and `renderTranscriptToTerminal`. |
| `user_echo` | Immediate echo before JSONL lands. Pushes to `_echoMessages`, renders right panel only. |

---

## The `loadChatHistory` Function

`loadChatHistory(tabOverride?)` builds `chatBubbles` for the left panel.
Called by: intervals (5s/15s), `switchToTab`, `loadTerminalSidebar`, `chat_update`.

**Read path (in priority order):**
1. `_pushedMsgsCache.get(active.id)` — always current, set by WS handler
2. `active._pushedMessages` — proxy read, may be stale (fallback only)
3. HTTP API `/dashboard/api/transcript` — only if both above are empty (fresh page load)

**The `tabOverride` parameter**: Pass `tabData` (the raw closure object) when calling
from a WS handler. This skips `getActiveTab()` (Svelte proxy) and reads directly
from the raw object. But in the `transcript_messages` handler, we skip `loadChatHistory`
entirely and set `chatBubbles` directly — faster and simpler.

```javascript
// ✓ BEST — in transcript_messages WS handler (direct, no lock, no async)
if (activeTabId === tabData.id) {
  const b = bubblesFromMessages(tabData._pushedMessages);
  if (b !== null) { chatBubbles = b; chatServerLoaded = true; }
}

// ✓ OK — from chat_update or other WS handlers (uses raw tabData)
loadChatHistory(tabData);

// ✗ RISKY — interval call without override; safe ONLY because _pushedMsgsCache
//   prevents the stale HTTP fallback from overwriting live data
loadChatHistory(); // reads cache first, so this is now safe
```

---

## The `bubblesFromMessages` Function

`bubblesFromMessages(messages)` → returns `Bubble[]` or `null` (null = don't clear).

- **Synchronous.** No async, no HTTP, no `chatLoadInProgress` lock.
- Shared by both the real-time WS path AND `loadChatHistory`.
- Handles roles: `user`, `assistant` (text/output), `tool`, `turn_stats`.
- Does **NOT** include `_btwMessages` (right-panel-only annotations).
- Returns `null` when `messages` is empty — caller must not clear existing bubbles.

---

## The `/btw` Command

`/btw <text>` sends an aside to Claude without waiting for the current response.

- Stored in `active._btwMessages` (written through Svelte proxy → writes raw too).
- Included in `renderTranscriptToTerminal` as styled aside lines in the right panel.
- **NOT** in `bubblesFromMessages` / left panel chat bubbles.
- Sent to Claude via `/api/v1/terminal/pipe` (inline, Claude sees it as a user message).

**Why the handler uses DOM-append, not `renderTranscriptToTerminal`:**

Calling `renderTranscriptToTerminal(active)` where `active` is the Svelte proxy
would read `active._pushedMessages` — which may be stale (proxy's tracked value
hasn't been updated by the raw WS write). Result: right panel briefly shows **only**
the btw message, wiping the entire real transcript.

Fix: append the btw note directly to the scrollback DOM for instant visual feedback.
The `_btwMessages` store ensures it's included in the next full re-render.

```javascript
// ✓ CORRECT — immediate DOM append, no full re-render
if (active.scrollbackDiv) {
  active.scrollbackDiv.innerHTML +=
    `<div ...>btw → ${escapeHtml(arg)}</div>`;
}
// _btwMessages handles persistence through next renderTranscriptToTerminal call
```

---

## Craft Swap Behavior

On Craft swap, the Carrier sends `server_swap` to all WS clients. The dashboard:

1. Sets `window._panSwapReloading = true`
2. Calls `waitForServerAndReload()` — polls `/health` every 600ms
3. Waits for **2 consecutive healthy** responses (avoids reloading before WS is ready)
4. `window.location.reload()` — page reloads fresh
5. `#pan-loading` splash in `app.html` shows; force-dismissed after 5s if needed
6. New page connects WS → receives first `transcript_messages` → both panels populate

The `_pushedMsgsCache` is cleared on page reload (it's in-memory, page-scoped).
On first load, `loadChatHistory` takes the HTTP path to populate initial history,
then the cache takes over once the first WS push arrives.

**Safety timeout**: `waitForServerAndReload` clears `_panSwapPolling` after 30s
so a future swap is never blocked by a stale flag.

---

## Key Files

| File | Role |
|------|------|
| `service/dashboard/src/routes/terminal/+page.svelte` | All frontend logic. 6000+ lines. |
| `service/src/terminal.js` | WS server, session management, `pipeSend()` |
| `service/src/adapters/ClaudeAdapter.js` | Claude SDK streaming, calls `onMessage` |
| `service/src/transcript-watcher.js` | JSONL parser (used for MCP/history, NOT real-time push) |

---

## Common Bugs and Their Causes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Left panel randomly reverts to old content | Interval-based `loadChatHistory()` reads stale proxy → takes HTTP path → returns older DB data → overwrites live `chatBubbles` | `_pushedMsgsCache` — cache always wins over HTTP fallback |
| Left panel not updating in real time | `chatBubbles` set from proxy (stale) or HTTP (slow) instead of raw data | Direct `bubblesFromMessages(tabData._pushedMessages)` in `transcript_messages` handler |
| Right panel wipes on `/btw` | `renderTranscriptToTerminal(proxy)` reads stale `_pushedMessages` → allMessages = [btw only] | DOM-append instead of full re-render in `/btw` handler |
| Left panel never shows anything | No messages in cache yet; `loadChatHistory` HTTP fallback needs session IDs | Normal on fresh tab; populates on first `transcript_messages` event |
| `chatBubbles` stale after tab switch | `loadChatHistory` called, cache has no entry for new tab yet | Normal; populates once first WS push for that tab arrives |
