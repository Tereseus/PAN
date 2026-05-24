# Next Session Handoff — 2026-05-19 evening

> Canonical copy of the handoff block in `MEMORY.md`. If you're reading this file
> instead of MEMORY.md, the user wants to see the summary + 3 questions below
> verbatim before answering anything else.

---

## Summary

Today we landed three router improvements that make PAN's voice replies feel grounded in the moment:

- **#744** — stopped PAN from running a memory search on every utterance; now it only fires when the user actually asks to recall something
- **#745** — router now reads the live intuition snapshot (where you are, what you're doing, who's around, what's on screen) and injects it into the prompt
- **#746** — router now reads PAN's recent thoughts (what intuition concluded in the last 5 min) so replies have continuity

All three were committed yesterday (`6cb7328`) but never loaded into the running server because a `POST /api/carrier/restart` killed the assistant session before the reload completed. Today we used `POST /api/carrier/swap` (the safe code-reload command) to actually load them. Verified live: "what time is it" now returns a situation-aware answer; "what did we say about X" still triggers memory recall. All three tasks marked `done`.

We also filed:

- **#753** — Carrier restart wipes active PTY/Claude session (now nightmare bug #8 in `docs/NIGHTMARE_BUGS.md`)
- **#763** — TTS throttle (per-device rate limit)
- **#764** — TTS quiet mode (DND schedule + meeting detection + manual mute)
- **#765** — PAN interject conversational triggers — confused/stuck/tangent/idle (maps to #NEW-4 in `docs/CONVERSATION-AND-INTERJECTION.md`)

And added the **reload rule** (swap = safe, restart = death) to both MEMORY.md and CLAUDE.md under the Super-Carrier section.

We then designed the **TTS endpoint**. The plan as of pause:

- `POST /api/v1/speak` accepting `{text, device?, voice?}`
- Engine: F5-TTS (already in PAN, cross-platform via Python, phrase cache → ~10ms common phrases, ~1-2s novel on GPU)
- Default device = server (local speakers via Python `sounddevice`); if `device` given, route via existing `speakSomewhere()`
- Surface: drop the widget idea; use the existing **Comms > PAN** chat thread as the conversation home — typing in that thread sends a message, PAN replies in text *and* speaks
- No toast banner (user vetoed)
- ΠΑΝ chat thread becomes the unified log of: user→PAN, PAN→user reactive, PAN→user proactive interjections

The user pushed back on the widget idea (correctly — duplicates the chat). They also asked three open design questions before I could start building. Those are below, **verbatim**, exactly as I sent them.

---

## 3 Questions (verbatim — present these unchanged)

**Q1 — Where does the Speak button live?**

You suggested two spots. Pick one (or both):
- **(A) Bottom, near the mic button on the chat input bar** — feels natural ("mic = your voice in, speak = PAN's voice out")
- **(B) Top-right above Impersonate** — global chrome, always accessible regardless of which page you're on
- **(C) Both** — the bottom one is contextual (within a thread), the top one is global

My recommendation: **C, both.** The bottom one is the conversational trigger ("speak this reply"); the top one is the global "open PAN convo" shortcut. They have different purposes.

---

**Q2 — "Open a new window for a chat" — what kind of window?**

Three things "new window" could mean:
- **(A) Browser popup window** — `window.open()`, a real OS window
- **(B) Modal/floating panel inside the dashboard** — overlay on top of the terminal, draggable
- **(C) New dashboard tab** — like opening a new Claude tab, but it's the PAN comms thread

My recommendation: **B, floating panel.** Keeps you in one dashboard window, lets you keep working in the terminal underneath, dismissible. (A) means tab-switching pain, (C) takes up a whole tab for chat.

---

**Q3 — When PAN speaks autonomously (intuition interjection), does it use the same chat thread?**

Right now, intuition interjections already go to the ΠΑΝ chat thread via `pan-notify.js`. With our new design, those interjections would *also* get spoken aloud. So your Comms > PAN becomes the unified log of:
- Things you said to PAN
- Things PAN said in response
- Things PAN said proactively (interjections)

All three streams, one thread. **Agree, or split proactive vs reactive?**

My recommendation: **one unified thread.** Splitting them adds complexity; the natural way conversation flows is "mixed."

---

*Once user answers (or says skip), delete this handoff and the matching `🛎️ OPEN HANDOFF` block in MEMORY.md.*
