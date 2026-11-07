# Intuition as a local state engine (plan, 2026-11-03)

The owner's idea: Intuition should be a program that runs all the time inside PAN on the mini PC,
not an LLM. It watches the conversation and everything else, keeps a live picture of what is
going on, like a Sims game, and the models ask it where things are at.

**Verdict: yes.** Keeping state is a job for code: instant, free, the same answer for every
model, testable, and it works with no internet. Models are for language. A model reads the
state; it never is the state.

## What runs where (target)

| Place | Job | Models |
|---|---|---|
| Phone, pendant | Ears and mouth: mic, start and stop of speech, a rough transcript to time the turn, the voices, sensors (place, motion, camera frames) | Smart Turn, sherpa streaming ASR, Supertonic and Android voices. No model that answers. |
| Mini PC (hub) | Everything that thinks | Speech to text (Parakeet v2, Parakeet v3, SenseVoice, Whisper), translation (a model licensed for commercial use, step 1), **the state engine**, Syrinx (conversation), Gemma 4 E2B (side jobs, camera answers), memory and embeddings |
| Cloud, optional | Only what cannot be local | Gemini for world knowledge and live-data wording; Claude for the Claude threads. PAN keeps working without it. |

## What exists (2026-11-03)

- A 60 s tick builds a snapshot in code: where, activity, focus, social, engagement, last
  heard (`intuition/index.js` `buildSnapshot`), from voice turns, Claude prompts, device
  presence and the phone camera (see CONVERSATION-AND-INTERJECTION.md, Update 2026-11-03).
- Sims-style needs bars with decay (`intuition/needs.js`), fed by regex scanners.
- A conversation buffer: overheard lines, dictating to Claude, PAN spoke recently
  (`conv-state-watcher.js`).
- Device presence: what each computer shows (`device_presence`).
- One situation line for prompts (`buildSituationLine`, router.js).
- PAN's Mind thoughts (`intuition/mind.js`).

## What is wrong with it

As found on 2026-11-03. Items 1 and 2 are fixed by step 3, the interpreting mode in item 3 by
step 2; the clock in item 4 is step 4.

1. **The judgment calls are LLM calls.** Mood, urgency and assumption come from a cloud model
   (`classifyAxes`, `model_selections.reasoning_cloud`): 414 calls on 2026-11-03, which used
   up the free Gemini quota the interpreter needed. The conversation's topic and phase come
   from gemma4:e2b on the hub CPU (`conv-state-watcher.js` distill).
2. **The rest are keyword guesses.** Mood from "yes", "works", "why"; urgency is 3 Claude
   prompts in 3 minutes; "not ok" is any prompt between 2 and 6 AM.
3. **State is scattered, and some of it is fragile.** The interpreting mode and other standing
   instructions live in router.js memory (`_standing`), so every Craft swap silently turns
   interpreting off. Conversation state is RAM only. The phone keeps its own 10 lines.
4. **It runs on a clock.** PAN-ARCHITECTURE.md says event-driven; the code ticks every 60 s.

## The design

**The state itself, field by field, and the situation catalog: [INTUITION-STATE.md](./INTUITION-STATE.md).**

### One world, one owner

A single state object (`intuition/world.js`, new). Every change goes through
`applyEvent(event)`, which writes an append-only event log and a snapshot, so Craft swaps and
restarts keep it. Nothing else holds conversation state.

### What is in it

- **People:** the owner; others present (voices overheard, the person he is interpreting for); who
  is talking to whom (PAN, Claude, the room, the other person).
- **Mode:** normal, interpreting (language), dictating to Claude, quiet or muted, game mode;
  standing instructions.
- **Conversation:** topic and the topics before it, open questions (PAN's and his), PAN's last
  line and whether it was heard or cut off, things just mentioned ("it", "that"), the
  language in use.
- **Place and motion:** the phone's place; still, walking or driving; home or out.
- **Activity:** what each computer shows, which project, in a game.
- **Body:** the needs bars (existing), awake or asleep, a mood estimate with its confidence.
- **Time:** now, the next calendar item.

Every value carries when it was set and how sure it is, and fades like a Sims need, so a
stale fact drops out of the line instead of being stated as true.

### How it updates, with no LLM

- **Events:** a voice turn (the text the hub heard, the language the speech model reported,
  the addressed score, who spoke), PAN's reply, an overheard line, the phone's sensors on each
  turn, computer presence, a camera caption, a Claude prompt, a calendar boundary, mute and
  unmute, a standing instruction.
- **Rules** for the clear cases, applied at once.
- **Small local models** for the fuzzy ones:
  - The language comes free from SenseVoice and Whisper.
  - A topic shift is the distance of the new line from the running topic in embedding space
    (qwen3-embedding, already on the hub).
  - Frustration or mood comes from a small local text classifier now, and from voice tone
    later.
  - The topic label comes from keywords and named things.
  - A Gemma summary runs only when idle or when asked, never inside a voice turn.

### How the models use it

- **Push:** one short state line in every prompt: Syrinx, the translator's rules, the cloud
  prompts.
- **Pull:** `GET /api/v1/world`, plus an MCP tool, so a Claude thread can ask what is going on
  with the owner right now.
- **Panel:** a live Sims-style view on the dashboard and the phone.
- **PAN speaking up:** triggers fire on state changes, with the existing dedupe and snooze
  rules, not on a clock.

## Order of work

Each step ships on its own and is measured before the next.

1. **Local translation.** A translator on the hub, so interpreting does not depend on Gemini.
   Only models whose licence allows commercial use. **Done 2026-11-05, past what was planned:**
   quickmt (CC-BY-4.0) beat MADLAD and M2M, 99 of 104 everyday facts at 40 ms, and the whole
   interpreter now runs on the phone with no hub and no language model (FEATURES.md,
   `InterpreterLoop.kt`). The fine-tune below is no longer needed for speed; it may still help
   Japanese. Done before that (2026-11-03):
   - The slot: `interpretStream` and the steward service.
   - The rules for "ask them X" and "tell her X".
   - NLLB-200, tested and removed for its CC-BY-NC licence. It was fast (0.2 s a line); Greek
     was usable, Japanese weak.

   Next, after step 3 (started 2026-11-03, the owner approved the downloads):
   - Benchmark commercial bases on the hub. **Done 2026-11-04:** MADLAD-400 3B (Apache 2.0)
     won, chrF 69.3 at 1.3 s a line against M2M-100 418M (MIT) at 53.9 and 0.22 s, on 81
     lines (Greek, Japanese, Spanish, French, Turkish, his own phrasing) read line by line.
     MADLAD is live as the interpreter's fallback, M2M kept as a backup (FEATURES.md,
     translator server, with MADLAD's input trap). Not tried yet: Opus-MT pairs (Apache 2.0
     or CC-BY 4.0 by pair) and TranslateGemma (Gemma terms, gated: he would accept them on
     Hugging Face).
   - The phrase set: Tatoeba's sentences and links (370 MB, CC BY 2.0 FR, text only) are on
     the hub; `translate-phrases.py` picks up to 600 everyday lines per category (4,800 in
     75 languages), each with every translation Tatoeba has, and holds 10% out by meaning
     for the test (457 lines). `translate-eval.py` scores a model on those held-out lines.
   - Fine-tune the best on everyday conversation phrases (shop, restaurant, transport,
     hotel, directions, emergencies, small talk, and what staff say back), the same phrases
     in every language so each pairs with every other.
   - Sources that allow commercial use, like Tatoeba (CC-BY). Not Claude or Gemini answers:
     their terms restrict training other models on them.
   - Keep a new model only if it beats the old one on held-out lines, his Greek session
     included.
2. **Modes into the world.** Interpreting and standing instructions are persisted, so a Craft
   swap no longer ends them. **Done 2026-11-03** (Craft 39): `intuition/world.js` (table
   `world_modes`, `loadModes`/`saveMode`/`dropMode`), read by router.js; a mode lasts 2 hours
   after its last use, and its speech model is warmed again after a start.
3. **The cloud classifier off.** Mood, urgency and assumption come from rules and small local
   models; the conversation distill moves from gemma4:e2b to rules and embeddings. Target:
   zero cloud calls in the background. **Done 2026-11-03** (Craft 45), all rules, no model:
   - `intuition/reader.js` reads him: mood, wellbeing, urgency, awake, need, complexity,
     each with its evidence and confidence, held until a clearly stronger reading or its
     fade (FEATURES.md, Intuition panel). 24 test scenes pass, his own lines from that
     night among them.
   - `intuition/conversation.js` reads the conversation: topic with its history, phase,
     PAN's open question, how he is talking, whether his line was finished, the things
     just named, his tone. 15 scenes pass; 4 lines take 11.7 ms on the hub, first call
     included.
   - `intuition/time.js`: his clock. The hub runs on his job's time zone (New York) and
     the owner lives 7 hours ahead, so every time of day rule had read 7 hours off; the voice
     prompt's `Now:` line had too.
   - Background jobs never fall back to the cloud (`ai_fallback_chain_background` is local
     only, and so is llm-fallback's default for it).
   - Measured after the swap: `intuition-classifier` and `conv-state` stopped at 434 and 15
     calls for the day. On the last Craft every classify had spent 5 s on Gemini and 4 s
     on gemma4:e2b before failing.
   - Topic shift is lexical (stems that carry over from line to line). Embedding distance
     is not used yet: add it as a veto if the state bench (step 8) shows paraphrases
     splitting one topic in two.
   - Not in yet, for later steps: the situation files of INTUITION-STATE.md section 4 and
     the world fact store (step 4 makes the world event-driven; this step reads the same
     signals as before).
4. **Event-driven.** Each voice turn and sensor event updates the world at once; the 60 s tick
   becomes a decay sweep.
5. **Syrinx round 11 trained with the state line.** Given a line it never saw in training, it
   called "How's it going?" room talk (hub bench, 2026-11-03).
6. **API, MCP tool, panel.**
7. **Speaking up from state changes.**
8. **A state bench.** Scripted scenes with the expected world after each line: interpreting
   in a shop, dictating to Claude with the TV on, walking to a station. Then voicebench end to
   end.

## Not doing

- Another LLM in the loop to keep state.
- A big-bang rewrite.
