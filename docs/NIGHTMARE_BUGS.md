# PAN Nightmare Bugs

These bugs are called **nightmare bugs** because they keep coming back.
Every time one gets "fixed," it resurfaces. That's because they're symptoms of
deeper architectural problems — not one-off mistakes.

**If you see one of these issues, do NOT just patch the symptom and mark it done.
Read the root cause section and fix the architecture.**

---

## The 8 Nightmare Bugs

| # | Title | Status | Root Cause Category |
|---|-------|--------|-------------------|
| [#444](#444-terminal-missing-messages) | Terminal missing messages — output not rendering | **OPEN** | Svelte proxy/raw object split |
| [#439](#439-duplicate-messages--double-send) | Duplicate messages — double-send, AI responds twice | **OPEN** | Missing idempotency guard |
| [#438](#438-steward-not-recovering-failed-services) | Steward not recovering failed services | **OPEN** | Health check doesn't verify actual function |
| [#431](#431-memory-recall-unreliable) | Memory recall unreliable — search flaky, results incomplete | **OPEN** | FTS5 + embedding pipeline gaps |
| [#430](#430-message-send-delay) | Message send delay — enter key takes 30s | **OPEN** | LLM adapter / terminal pipe timing |
| [#435](#435-screen-watcher-incorrect) | Screen watcher incorrect — triggers bad refreshes | **OPEN** | Activity signal not debounced or gated |
| [#432](#432-crash-loop-stability) | Crash loop stability — things crash and come back broken | **OPEN** | Race conditions during Carrier/Craft restart |
| [#376](#376-phone-transcript-race-condition) | Phone transcript race condition — messages don't appear | **OPEN** | Poll-based phone vs WS-based desktop divergence |

---

## #444 — Terminal Missing Messages

**Symptom:** Messages visible in the Transcript panel (right side) don't appear in the
chat bubbles panel (left side), or vice versa. Content disappears or reverts to old data.

**Root cause: Svelte proxy vs raw object split.**

`tabData` is a plain JS object stored inside a Svelte 5 `$state([])` array.
This creates **two references** to the same data:
- `tabData` — raw JS object, lives in the WS closure
- `tabs.find(t => t.id === tabData.id)` — a Svelte 5 **Proxy**, which tracks its own
  internal value per property independently of the raw object

Writing to the raw object (`tabData.x = value`) does NOT update the Proxy's tracked value.
Interval-based `loadChatHistory()` calls `getActiveTab()` which returns the **Proxy** —
so it reads stale data, falls back to HTTP, and **overwrites live WS data with old DB data**.

**The fix that exists:** `_pushedMsgsCache` — a module-level Map outside Svelte's
reactive system. The WS handler writes to it after every push. `loadChatHistory` reads
the cache FIRST before touching the proxy or HTTP. See `docs/TRANSCRIPT_SYSTEM.md`.

**Why it keeps coming back:**
- New code that calls `renderTranscriptToTerminal(activeTab)` where `activeTab` is
  the Svelte proxy (not the raw `tabData`) will read stale `_pushedMessages`.
- New WS handlers that forget to write to `_pushedMsgsCache` after setting `tabData._pushedMessages`.
- Any new interval or timer that calls `loadChatHistory()` without checking the cache first.

**Rules:**
1. ALWAYS write to `_pushedMsgsCache.set(tabData.id, messages)` after setting `tabData._pushedMessages`
2. NEVER pass the Svelte proxy to `renderTranscriptToTerminal` — use the raw `tabData` from the WS closure
3. In `transcript_messages` handler, set `chatBubbles` directly — do NOT call `loadChatHistory`
4. Read `docs/TRANSCRIPT_SYSTEM.md` before touching ANYTHING in this area

---

## #439 — Duplicate Messages / Double-Send

**Symptom:** User sends one message but Claude responds twice, as if two sessions
merged or the message was delivered twice to the LLM adapter.

**Root cause: Missing idempotency guard on message dispatch.**

`pipeSend()` in `terminal.js` can be called twice for the same message if:
- The frontend sends two rapid requests (Enter key event fires twice)
- A retry mechanism fires before confirming the first delivery failed
- Two WebSocket sessions exist for the same terminal tab and both forward the message

The regression test for this (`p1-reg-double-send`) uses Playwright to verify
the double-send guard works. But the guard is in the **frontend** — if a client
bypasses the dashboard (e.g. phone, voice, `/api/v1/terminal/pipe` directly),
the guard doesn't apply.

**Why it keeps coming back:**
- The guard is UI-layer only, not enforced server-side
- Any new send path (voice, phone, MCP `terminal_send` tool) bypasses it entirely
- The regression test only covers the dashboard Enter key path

**The real fix needed:** Server-side idempotency key on `pipeSend()`.
Each send should include a client-generated UUID. The server rejects duplicates
within a 5-second window. This makes all send paths safe, not just the dashboard.

---

## #438 — Steward Not Recovering Failed Services

**Symptom:** A service crashes. Steward shows it as running. The service stays broken.
Or: Steward restarts the service but it comes back broken (can't bind port, etc).

**Root cause: Health check verifies process existence, not functional status.**

Steward's health checks confirm the process is alive (PID exists) but don't verify
the service is actually serving. A crashed-but-still-running process (zombie, hung)
passes the health check. Port-bound services that failed to bind also pass.

Related: **#443** — Steward shows ollama as running but the port is down.
Same root cause: process check ≠ functional check.

**Why it keeps coming back:**
- Health checks are cheap process checks — easy to write, wrong abstraction
- Restarting a crashed service doesn't guarantee port cleanup from the prior instance
- Steward has no concept of "this service has crashed 3 times in 2 minutes — escalate"

**The real fix needed:**
1. Health checks MUST probe the actual service endpoint (HTTP `/health`, TCP connect, etc.)
2. Steward needs a crash backoff — don't restart a service that keeps crashing every 10s
3. Port cleanup must happen before restart (kill whatever holds the port)
4. Status UI must reflect functional health, not process health

---

## #431 — Memory Recall Unreliable

**Symptom:** Asking PAN about something it was told doesn't surface the right result.
Search returns incomplete results, wrong results, or nothing at all.

**Root cause: Three-layer search pipeline with gaps at each layer.**

Memory search goes through:
1. **FTS5 full-text search** — keyword match against `memory_items`, `events`, `episodic_memories`
2. **Vector/embedding search** — semantic similarity via stored embeddings
3. **Classifier-assigned** memory items — Augur's 5-minute classification cycle

Gaps:
- Events ingested while Augur hasn't run yet aren't in `memory_items` — they're in `events` only
- FTS5 requires the exact indexed form of a word (stemming helps but isn't perfect)
- Embeddings are generated async — new events may not have embeddings yet
- The consolidation step (episodic/semantic/procedural) only runs at SessionEnd or scheduled —
  a long session has unprocessed events

**Why it keeps coming back:**
- Marking memory search "fixed" after one successful retrieval doesn't mean the pipeline is reliable
- The 5-minute Augur cycle means fresh information has a window where it's invisible to search
- No test verifies end-to-end recall latency (write event → search → find it within N seconds)

---

## #430 — Message Send Delay

**Symptom:** Pressing Enter to send a message sometimes takes 30+ seconds before
Claude starts responding. Feels like the message was swallowed.

**Root cause: Multiple possible chokepoints in the terminal pipe chain.**

The send path: Dashboard → POST `/api/v1/terminal/pipe` → `pipeSend()` → `ClaudeAdapter.send()`
→ LLM stream begins → `onMessage` callback fires → WS push → frontend renders

Delays can occur at:
- **LLM adapter initialization** — if the Claude process isn't warm, cold start adds latency
- **Terminal pipe queueing** — if a previous message is still being processed, the new one queues
- **WS push latency** — if the frontend's WS connection is unhealthy, pushes buffer
- **`claude -p` process startup** — 3-5s overhead for each session spawn

**Why it keeps coming back:**
- It's intermittent — hard to reproduce consistently, easy to declare "fixed" when it goes away
- No end-to-end timing is logged for the send path (what we can't measure, we can't fix)

**The real fix needed:** Instrument the entire path with timestamps logged to the DB.
Every `pipeSend()` call should log: queued_at, adapter_sent_at, first_token_at, complete_at.
Make delays visible before trying to fix them.

---

## #435 — Screen Watcher Incorrect

**Symptom:** Screen watcher triggers at the wrong time, causing bad page refreshes or
incorrect activity signals. The dashboard or UI refreshes when it shouldn't.

**Root cause: Activity signal is unbounced and not gated on meaningful change.**

`screen-watcher.js` takes a screenshot every 60s and sends it to a vision AI.
The result updates the `screen_activity` context. If the dashboard itself reacts
to changes in this context (e.g. refreshing panels or recalculating layout), any
false-positive activity signal causes a spurious refresh.

**Why it keeps coming back:**
- Vision AI output is non-deterministic — the same screen can produce different descriptions
- No diff/delta check — any new description triggers the signal, even if nothing changed
- The 60s screenshot cycle means the watcher is always "catching up" to stale state

**The real fix needed:**
1. Compare new description to previous — only signal if meaningfully different
2. Debounce reactions to `screen_activity` changes — don't react to every update
3. Gate dashboard refreshes on user-initiated actions, not background sensor changes

---

## #432 — Crash Loop Stability

**Symptom:** Something crashes. The restart mechanism kicks in. The restarted service
comes back broken or immediately crashes again. This repeats until manually killed.

**Root cause: Restart logic doesn't verify preconditions before re-spawning.**

The Super-Carrier → Carrier → Craft hierarchy is designed for resilience, but:
- Carrier kills stale processes on port 17700 **only if it detects them** — timing-sensitive
- After a crash, `pan-loop.bat` respawns immediately — no backoff, no health gate
- A Craft that crashes on startup (bad config, bad code) will loop infinitely
- Sleep/wake cycles leave the old Craft holding port 17700; the new one can't bind

**Why it keeps coming back:**
- Every fix addresses one specific crash scenario, not the general "restart safely" problem
- The three-tier architecture is complex — a fix at one tier can break another tier's assumptions

**The real fix needed:**
1. Exponential backoff in `pan-loop.bat` (2s, 4s, 8s... cap at 60s)
2. Pre-spawn health gate: before spawning new Craft, verify port 17700 is free
3. Exit code semantics: code 0 = healthy exit (stop loop), non-zero = crash (restart), specific codes = give up
4. Max crash count: after 5 crashes in 10 minutes, notify user and stop

---

## #376 — Phone Transcript Race Condition

**Symptom:** Messages sent from the phone don't appear in the phone dashboard,
or appear delayed/out of order. The phone shows an empty transcript when there should be content.

**Root cause: Phone dashboard is poll-based; server state updates are event-based.**

The phone dashboard (`/mobile/index.html`) polls `/api/v1/terminal/messages/<session_id>`
every 3 seconds. The desktop dashboard uses WebSocket push — it gets messages instantly.

Race conditions:
- Poll fires at T=0. Message arrives at T=1. Next poll at T=3. 3-second delay minimum.
- Session ID resolution: phone resolves session from `/api/v1/terminal/sessions` — if the
  session was just created, it might not be in the list yet
- Fingerprint-based re-render: if the fingerprint doesn't change (same messages),
  re-render is skipped — but the display might be stale from a prior render

**Why it keeps coming back:**
- Poll-based architecture has inherent race conditions that no patch can fully eliminate
- "Fixed" means "less frequent" — the race still exists, just less likely to hit

**The real fix needed:** WebSocket push for the phone dashboard, same as desktop.
The phone WebView supports WebSocket. This would eliminate all polling races.
Until then: reduce poll interval to 1s and add a session-ready gate before first poll.

---

## Architectural Patterns Causing Recurrence

These bugs recur because of **three systemic problems**:

### 1. Optimistic status marking
Tasks get marked "done" when a fix is committed, not when the fix is **verified working in prod**.
The regression test suite exists to prevent this — but the tests aren't run before every close.

**Rule: A bug is not done until the regression test passes in prod.**

### 2. Surface-level fixes
The fix addresses the symptom visible at the time, not the underlying cause.
Example: #438 gets "fixed" by adding a restart — but restart without port cleanup
causes #432. One bug's fix creates another bug.

**Rule: Before fixing, write down what the root cause is. If you can't, you don't understand it yet.**

### 3. No end-to-end observability
We can't measure what we can't see. Send delay (#430) is intermittent because
there's no timing log. Memory recall (#431) is flaky because there's no recall
latency metric. Screen watcher (#435) misfires because there's no diff log.

**Rule: If a bug is "intermittent," the first fix is adding instrumentation, not patching code.**

---

## Regression Tests

These tests exist to catch nightmare bugs before they ship:

| Test ID | Bug | File | What it tests |
|---------|-----|------|--------------|
| `p1-reg-double-send` | #439 | `service/src/routes/tests.js` | Sends a message twice rapidly, verifies Claude responds exactly once |
| `p1-reg-terminal-render` | #444 | `service/src/routes/tests.js` | Sends a message, verifies it appears in both left and right panels |

**More tests needed:** #438 (steward recovery), #431 (memory recall end-to-end), #430 (send timing)

---

## How to Add a Nightmare Bug

When a bug has come back 2+ times:
1. Add it to the table at the top of this file
2. Write a section with: Symptom, Root cause, Why it keeps coming back, Real fix needed
3. Add or update a regression test in `service/src/routes/tests.js`
4. Reopen the task with priority P1 and add a note explaining why it was incorrectly closed

**Do NOT mark a nightmare bug as done unless:**
- The root cause (not symptom) is fixed
- A regression test exists and passes
- The fix has been running in prod for at least 24 hours without recurrence
