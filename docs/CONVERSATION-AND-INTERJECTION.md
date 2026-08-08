# Conversation & Interjection Flow

> **What this doc is.** A unified map of how a phone/dashboard utterance, the intuition tick loop, PAN's-Mind, the scorer, and the action engine all play together to (a) reply to the user when spoken to, and (b) interrupt the user when PAN has something worth saying.
>
> **Why it exists.** The pieces are documented separately in [PAN-ARCHITECTURE.md](./PAN-ARCHITECTURE.md) (Intuition cortex, sub-sections 1–5), but no doc connects them. The Atlas panel does not render this wiring. New contributors keep asking "where does the router read intuition?" — the answer until today was "it doesn't." This document is the single source of truth for the wiring, the status of every wire (✅ live / ⚠️ partial / ❌ missing), and the gaps to file as tasks.
>
> Pair with: [PAN-ARCHITECTURE.md](./PAN-ARCHITECTURE.md) for *what each part IS*, [FEATURES.md](./FEATURES.md) for *what each UI element does*.

## TL;DR

Two independent loops produce the user-facing PAN voice:

1. **Reactive (user-initiated)** — Phone or dashboard utterance → `router.js` → classify+handle in one Cerebras call → reply. Writes one thought. **Today: does NOT read intuition snapshot, does NOT read recent thoughts.**
2. **Proactive (PAN-initiated)** — Intuition tick every 60s → snapshot → classifier verdict → deliberation → if `act`, `dispatchAction()` fans out to chat thread + WS broadcast + connected clients (phone/desktop TTS). Writes one thought per tick (when verdict changes). **Today: only fires for need-class candidates (nourishment, hydration, rest, social, focus) and state-class (emergency, not_ok, quiet). Does NOT fire for conversational triggers.**

The two loops barely talk to each other. That's the gap.

## The wire map

```
┌─────────────────────── REACTIVE LOOP (user → PAN) ──────────────────────────┐
│                                                                              │
│   USER UTTERANCE (phone STT, dashboard input)                                │
│         │                                                                    │
│         ▼                                                                    │
│   router.js handleUnified()                                                  │
│         │                                                                    │
│         ├──► quickAmbientCheck()                       ✅ regex pre-filter   │
│         ├──► serverClassify()                          ✅ regex pre-filter   │
│         ├──► tryQuickSystem()                          ✅ no-LLM fast path   │
│         ├──► searchMemory(text)                        ⚠️ UNCONDITIONAL — bug│
│         ├──► getCurrentSnapshot()                      ❌ NOT CALLED         │
│         ├──► recentThoughts({source:'intuition'})      ❌ NOT CALLED         │
│         ├──► claude(prompt, …)                         ✅ Cerebras Qwen 235B │
│         ├──► writeThought('router', "Commander said …")✅ → pan_thoughts     │
│         ├──► noteMealMention / noteSignalsInUtterance  ✅ → Needs state      │
│         └──► response → TTS / dashboard chat                                 │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────── PROACTIVE LOOP (PAN → user) ─────────────────────────┐
│                                                                              │
│   INTUITION TICK (every 60s — intuition/index.js startIntuition())          │
│         │                                                                    │
│         ▼                                                                    │
│   buildSnapshot()                                                            │
│         │                                                                    │
│         ├──► reads events, presence, sensors, sessions, screen, webcam       │
│         ├──► reads recent UserPromptSubmit (terminal traffic)                │
│         ├──► reads recent wrap_messages (cross-app chat)                     │
│         ├──► askAI({caller:'intuition-classifier'}, …)  ✅ Cerebras 148/day  │
│         │       → 6-axis verdict: Where, Activity, Focus, Mood, Urgency,     │
│         │         Engagement (+ direction, need, complexity, recent_topics)  │
│         ├──► persistSnapshot()                          ✅ intuition_snapshots│
│         ├──► writeThought('intuition', …)               ✅ → pan_thoughts    │
│         │                                                                    │
│         ▼                                                                    │
│   DELIBERATION (inline in intuition/index.js)                                │
│         │                                                                    │
│         ├──► score candidates (from Needs + state markers)                   │
│         ├──► verdict ∈ {act, suppress, hold}                                 │
│         ├──► dedupe by (verdict, top-candidate) identity                     │
│         └──► if verdict==='act':                                             │
│                  │                                                           │
│                  ▼                                                           │
│         dispatchAction(candidate)  — intuition/action.js                     │
│                  │                                                           │
│                  ├──► panNotify('intuition', subject, body) ✅ ΠΑΝ thread    │
│                  ├──► broadcastNotification('pan_interjection') ✅ WS toast  │
│                  ├──► sendToClient(device_id, 'speak', {text, …}) ✅ TTS     │
│                  │      → phone client, desktop popup, pendant (when up)     │
│                  └──► INSERT pan_interjections (dedupe key, 30min window)    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

┌─────────────────── FEEDBACK LOOP (interjection → Needs) ────────────────────┐
│                                                                              │
│   user reacts to interjection (accept / dismiss / snooze / thanks)           │
│         │                                                                    │
│         ▼                                                                    │
│   recordFeedback(interjectionId, feedback)  — intuition/action.js            │
│         │                                                                    │
│         ├──► UPDATE pan_interjections SET status=…                           │
│         └──► if candidate_id starts with 'need:' :                           │
│                  adjustWeight(user, need, delta) — intuition/needs.js        │
│                    accept   →  +0.10                                         │
│                    thanks   →  +0.15                                         │
│                    dismiss  →  −0.10                                         │
│                    snooze   →   0  (dedupe extends to 2h)                    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Wire-by-wire status

### Reactive loop (router)

| # | Wire | Status | Source | Notes |
|---|---|---|---|---|
| R1 | Utterance → router.handleUnified | ✅ | `router.js:728` | Phone /api/v1/listen, dashboard /api/v1/terminal/send |
| R2 | Pre-filter: quickAmbientCheck | ✅ | `router.js:50` | Regex catches "hey John", "I'll call you back" |
| R3 | Pre-filter: serverClassify | ✅ | `router.js:33` | Regex catches obvious system/music/memory intents |
| R4 | Pre-filter: tryQuickSystem | ✅ | `router.js:67` | "status", "sleep", "incognito", "record" no-LLM path |
| R5 | Memory lookup: searchMemory | ⚠️ **BUG** | `router.js:145, 870` | Unconditional FTS5+vector lookup on every utterance, even pure conversation. See **#NEW-1** below |
| R6 | Snapshot read: getCurrentSnapshot | ❌ **MISSING** | (would be `router.js:~144`) | Router has zero access to live commander state. See **#NEW-2** |
| R7 | Recent-thoughts read: recentThoughts | ❌ **MISSING** | (would be `router.js:~144`) | Router can't ground reply in what intuition just concluded. See **#NEW-3** |
| R8 | Claude call (classify+handle) | ✅ | `router.js:204` | Cerebras Qwen 235B by default, ~580ms |
| R9 | Mind write: writeThought('router', …) | ✅ | `router.js:260, 270` | One thought per utterance, importance 0.1 ambient / 0.7 command |
| R10 | Needs write: noteMealMention | ✅ | `router.js:257` | Scans utterance for meal/hunger phrases regardless of intent |
| R11 | Needs write: noteSignalsInUtterance | ✅ | `router.js:258` | General-purpose signal scanner |
| R12 | Response → TTS / chat | ✅ | post-process in `router.js:282+` | speech_act propagated through all return paths |

### Proactive loop (intuition tick)

| # | Wire | Status | Source | Notes |
|---|---|---|---|---|
| I1 | Tick loop start | ✅ | `intuition/index.js:1300 startIntuition()` | Default cadence in INTUITION_TICK_MS |
| I2 | Snapshot build | ✅ | `intuition/index.js:270 buildSnapshot()` | Reads 40 recent events + presence + sensors + sessions + 5 recent UserPromptSubmit |
| I3 | Cerebras classifier call | ✅ | `intuition/index.js:986` (caller='intuition-classifier') | 148 calls today, $2.54 |
| I4 | Persist snapshot | ✅ | `intuition/index.js:841 persistSnapshot()` | `intuition_snapshots` table, indexed by org+user+as_of |
| I5 | Mind write: writeThought('intuition', …) | ✅ | `intuition/index.js:1076` | Writes only when verdict changes (dedupe via _unchangedStreak) |
| I6 | Deliberation: score candidates | ⚠️ **PARTIAL** | `intuition/index.js:1083+` | Inline scorer; smart-router action-scoring extension still planned (see PAN-ARCHITECTURE.md line 81) |
| I7 | Verdict ∈ {act, suppress, hold} | ✅ | `intuition/index.js:1143-1166` | Dedupe by (verdict, top-candidate) identity |
| I8 | dispatchAction on 'act' | ✅ | `intuition/index.js:1198` → `action.js:123` | Fire-and-forget; non-blocking |
| I9 | Channel 1: ΠΑΝ chat thread | ✅ | `action.js:149 panNotify()` | Persistent visible record |
| I10 | Channel 2: WS broadcast | ✅ | `action.js:166 broadcastNotification('pan_interjection')` | Dashboard toast |
| I11 | Channel 3: client speak | ✅ | `action.js:188 sendToClient(device, 'speak')` | Phone TTS + desktop popup. Offline devices skipped silently. Best-effort. |
| I12 | Persistence + dedupe row | ✅ | `action.js:206 INSERT pan_interjections` | 30min dedupe window on action_key |

### Feedback loop

| # | Wire | Status | Source | Notes |
|---|---|---|---|---|
| F1 | User reacts to interjection | ⚠️ **PARTIAL** | Dashboard buttons exist; phone has no reaction UI yet | See **#NEW-6** |
| F2 | recordFeedback → DB update | ✅ | `action.js:254` | status, feedback_at columns |
| F3 | Weight adjust on need-class | ✅ | `action.js:271 adjustWeight()` | accept +0.10, thanks +0.15, dismiss −0.10 |
| F4 | Weight adjust on state-class | ❌ **MISSING** | — | "not_ok" interjection feedback doesn't tune anything. See **#NEW-7** |

## The gaps (file as tasks)

### #NEW-1 — Make searchMemory conditional, not reflexive
**Where:** `router.js:145` and `router.js:870`
**Today:** Every phone/dashboard utterance runs FTS5+vector lookup against events.
**Want:** Skip on first pass. Let the model emit `{intent:"memory",action:"recall",content:"X"}` when it needs facts; the post-process at `router.js:495` already handles recall. Pure conversation never touches the DB.
**Why it matters:** The user's complaint — "they kept trying to do database lookups which is incorrect."

### #NEW-2 — Router reads the intuition snapshot
**Where:** `router.js:~144` (just before the claude() call)
**Today:** Router has no access to commander state. Re-derives mood/focus/location from raw text every call.
**Want:** Import `getCurrentSnapshot` from `./intuition/index.js`, build a `situationBlock` with commander, where, activity, focus, mood, need, engagement, last_heard, prepend to prompt.
**Why it matters:** Lets the model react to context the user already established — "as a conversation that tells PAN should you act and react."

### #NEW-3 — Router reads recent thoughts (continuity)
**Where:** `router.js:~144`
**Today:** Router writes thoughts but never reads them back. Each reply starts cold.
**Want:** `recentThoughts({source:'intuition', limit:3, sinceMs:5*60_000})` injected as a `recentMindBlock`. Lets PAN say "as I was just noting…" or sustain a multi-turn line of thought.

### #NEW-4 — Conversational-trigger interjections
**Where:** `intuition/index.js` deliberation block, plus new phrasing family in `intuition/action.js`
**Today:** `dispatchAction` only fires for need-class (nourishment, hydration, rest, social, focus) and state-class (emergency, not_ok, quiet). It does NOT fire for conversational signals.
**Want:** New candidate IDs:
- `conv:confused` — Commander asked ≥3 clarifying questions in 5min → offer summary
- `conv:stuck` — same error pattern in transcripts repeated → offer Scout
- `conv:tangent` — focus shifted away from active task → ask "still on X?"
- `conv:idle` — Commander silent ≥20min during active session → nudge progress
Add corresponding phrasings.

### #NEW-5 — Atlas panel renders this wire map live
**Where:** Dashboard's intuition section
**Today:** Atlas shows the snapshot data but not the wiring or its status.
**Want:** Panel that draws this exact diagram with live green/yellow/red status per wire, click-through to source file:line. Make the map self-documenting. (Replaces the "no mapping exists" problem this doc is solving.)

### #NEW-6 — Phone interjection feedback UI
**Where:** `service/public/mobile/index.html`
**Today:** Phone receives speak interjections via Channel 3 but has no UI to accept/dismiss/thanks/snooze — the weight-learning loop only fires from dashboard reactions.
**Want:** Bottom-sheet on interjection with 4 buttons → POST `recordFeedback`.

### #NEW-7 — State-class feedback tunes something
**Where:** `intuition/action.js:262`
**Today:** Feedback on a `need:*` candidate adjusts that need's weight. Feedback on `state:not_ok` / `state:emergency` does nothing.
**Want:** Per-state suppression: dismissed `state:not_ok` 3× → raise the trigger threshold for that state for that user.

### #NEW-8 — Verify phone Channel 3 delivery actually works
**Where:** `intuition/action.js:188 sendToClient(device, 'speak', …)` and `client-manager.js`
**Today:** Yesterday's session flagged that `client-manager.js:225` marks all non-hub devices offline at boot, and only HTTP polling flips them back — WS-only clients (the phone) never get re-flipped. So an interjection's speak fanout to the phone may be silently dropping today.
**Want:** Verify with a manual `POST /api/v1/intuition/tick` after planting a `need:hydration` candidate, confirm phone speaks. If not, fix the boot-state bug.

## The integration story (what we're really after)

Today the two loops run in parallel and barely talk:

- Intuition concludes "Commander is focused on Phone Integration, mood Engaged, last_heard 'we can go back to the phone'."
- Then commander says "look at yesterday's transcripts."
- Router sees the words. Cerebras infers intent from words alone. The fact that intuition *just concluded the topic is phone integration* never reaches the reply.

After **#NEW-2** and **#NEW-3** land, the router prompt grows a section like:

```
Situation right now:
- Commander: owner (unknown at desk)
- Where: At The Hub
- Focus: Phone Integration — direction: Clarifying ongoing work
- Mood: Engaged
- Last heard: "we can go back to the phone"

Recently in my mind:
- "Commander is conversing with PAN, picking up phone-integration thread."
- "Yesterday's main blockers were #681 verification + mic-router never tested."
```

The model now answers grounded in continuity. The "database lookup" stops being how PAN understands; intuition is.

After **#NEW-4** lands, PAN gains the symmetric ability — when intuition concludes "Commander is stuck on the same error 3× in 10min", deliberation produces a `conv:stuck` candidate, dispatchAction fires, the phone speaks "Want me to throw this at Scout?" without the user asking.

## Update 2026-07-15 — this doc is partly stale, reconcile

- **R6/R7 (getCurrentSnapshot, recentThoughts) are NOT missing anymore.** `router.js` now imports `getCurrentSnapshot` + `recentThoughts` (lines ~20-22) and builds a situation block + recent-mind block into the prompt (`router.js:~409`, marked `#NEW-2/#NEW-3`). The ❌ rows above are out of date — verify the exact wiring and flip them to ✅/⚠️.
- **NEW keystone: server-side conversation-memory guarantee (reactive loop).** The phone `/api/v1/query` and `/api/v1/query/stream` handlers forwarded only the client-sent `context` as `conversation_history`; the phone's plain voice path sends `null`, so most voice turns were COLD (PAN forgot its own last reply). Fixed in `api.js`: when `context` is empty/short, the server rebuilds the thread from the last 16 text turns on `thread-pan-system` (30-min window). Conversation state is now a SERVER guarantee, device-agnostic (phone/pendant/desktop share one thread). Next: (B) phone always sends its buffer; (C) feed the live dialogue into the intuition snapshot. See memory `project_pan_conversation_memory`.

## See also

- [PAN-ARCHITECTURE.md](./PAN-ARCHITECTURE.md) — what each section IS (Intuition cortex, sub-sections 1–5)
- [FEATURES.md](./FEATURES.md) — PAN's-Mind dashboard panel (§354+), Atlas panel
- [MEMORY-PIPELINE.md](./MEMORY-PIPELINE.md) — how memory feeds Intuition
- `service/src/router.js` — reactive loop
- `service/src/intuition/index.js` — tick loop + deliberation
- `service/src/intuition/action.js` — dispatch + 3 channels + feedback
- `service/src/intuition/mind.js` — pan_thoughts read/write
- `service/src/intuition/needs.js` — needs evaluation + weight learning
