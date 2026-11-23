# The Intuition state (definition v2, 2026-11-11; v1 2026-11-03)

Version 2 is at the end (sections 10 to 14): new fields, the shelf (background attention), the
knowledge library, what was fixed on 2026-11-11, and the order of work from here.

Everything PAN knows about what is going on right now lives here, in one place: the world
(`intuition/world.js`, see [INTUITION-STATE-ENGINE.md](./INTUITION-STATE-ENGINE.md) for the
plan). Sensors and turns write events into it. Models only read it. No LLM keeps it.

This file is generic, the same for anyone running PAN. One person's places, people and
routines are data in that PAN's database (taught by voice or learned), never in the repo.

## 1. The shape: a Sims game

| Sims | PAN | Section |
|---|---|---|
| The Sim | Him: awake, moving, mood, needs, attention | 3.1 |
| The lot | The place he is in | 3.2 |
| Other Sims | The people around him | 3.3 |
| The conversation bubble | Who is talking to whom, about what | 3.4 |
| The current action | What he is doing | 3.5 |
| The clock | Time, routine, trip | 3.6 |
| The game itself | PAN: its mode and what it may do here | 3.7 |
| The situation the game recognises | A named scene that decides how PAN behaves | 4 |

## 2. Every value is a fact with a source

```
{ value, confidence: 0..1, source: "voice" | "gps" | "presence" | ..., at, fades_after_ms }
```

Confidence falls as the fact ages and is gone at `fades_after_ms`. Below 0.3 the fact reads as
unknown and is never stated to a model as true. Two sources that agree raise the confidence;
two that disagree keep the newer one at the lower confidence. A value he states himself ("I'm
at the gym") is 1.0 until something contradicts it.

## 3. The state, field by field

"Now" is a source PAN has today. "Later" is one to add (section 8).

### 3.1 Him

| Field | Values | Sources | Fades |
|---|---|---|---|
| `awake` | awake, asleep, unknown | voice turns and Claude prompts, his waking stretch: first input after a 4 h break (now, `reader.js`); phone motion and charging (later) | 30 min |
| `motion` | still, walking, running, driving, in transit, flying | GPS speed on each turn (now); phone activity recognition (later) | 5 min |
| `attention` | what he is looking at or working on | device presence, Claude prompts (now); pendant camera (later) | 10 min |
| `mood` | valence -1..1, energy low/normal/high, label (calm, focused, happy, tired, frustrated, stressed, upset) | his words, their pace, his clock and hours up, through rules (`reader.js`, step 3; labels also include energized, engaged, impatient, winding down, starting up); voice tone (later) | 20 min |
| `needs` | the 10 bars of `intuition/needs.js`: nourishment, hydration, rest, body movement, mental health, social, focus, fun, environment, safety | regex scanners (now); situations below (later) | per need |
| `wellbeing` | ok, not ok, emergency | rules only (`reader.js`): first person distress and emergency phrases, never hypotheticals or quotes; his own "I'm sick"; 20 h or more up (now); no response to a check-in, no motion at an odd hour (later) | 1 h |
| `interruptible` | yes, only if important, no | derived from the situations (meeting, driving, deep work, asleep, dictating) | with them |
| `devices` | phone, pendant, earbuds; which microphone is live; battery | phone turns, presence (now); battery and earbuds (later) | 10 min |

### 3.2 The place

| Field | Values | Sources | Fades |
|---|---|---|---|
| `kind` | home, someone's home, work, shop, market, restaurant, café, bar, station, airport, vehicle, hotel, gym, medical, outdoors, event, unknown | GPS address (now); place category from the map, Wi-Fi name, car Bluetooth (later); his label | 15 min after he leaves |
| `label` | his name for it ("home", "the gym") | taught by voice, stored in the DB | never |
| `country`, `language`, `timezone` | from the address | GPS (now) | with `kind` |
| `privacy` | private, semi-public, public | from `kind` and his labels | with `kind` |
| `noise` | quiet, normal, loud; TV or music on | overheard lines (now); microphone level (later) | 5 min |

### 3.3 The people around him

A list, one entry per person or voice:

| Field | Values | Sources |
|---|---|---|
| `who` | a known name, or a role: clerk, waiter, driver, friend, family, colleague, stranger, a voice on TV | the interpreting instruction ("she speaks Spanish"), his words ("my friend is here"), Discord authors (now); speaker ID by voice (later) |
| `language` | the language heard from them | the hub's speech model (now) |
| `talking_to` | him, PAN, each other, nobody | addressed score and turn order (now) |
| `last_heard` | when | overheard lines (now) |

Plus `count` (alone, one, a few, a crowd) with its confidence.

### 3.4 The conversation

| Field | Values | Sources |
|---|---|---|
| `addressee` of each line | him to PAN, him to someone, someone to him, him to Claude (dictating), media | addressed score, `noteClaudePrompt`, interpreting (now) |
| `pan_role` | assistant, interpreter (language), bystander (he is dictating), silent (muted), note taker | modes (now) |
| `floor` | he is talking, someone else is, PAN is, overlap, silence (since when) | phone turn events (now) |
| `topic` | a short label, plus its embedding centroid; the last 5 topics with times | stemmed keywords that carry over from line to line (`conversation.js`, step 3); embedding distance as a veto on a shift (later, if the bench needs it) |
| `open` | questions not answered yet (who asked whom), requests in progress (a Claude thread job), PAN's promises ("I'll remind you at 5") | turns, the relay (now); promises (later) |
| `mentioned` | the things just named, for "it", "that one", "the other one" | names in his and PAN's last lines (`conversation.js`) |
| `languages` | the languages in use | speech models (now) |
| `tone` | calm, joking, heated, upset | rules (`reader.js toneOf`, step 3); voice (later) |
| `pan_last` | PAN's last line and what happened to it: heard, cut off by him, ignored | tts and barge-in events (now) |

### 3.5 What he is doing

| Field | Values | Sources |
|---|---|---|
| `activity` | one of the activity situations (section 4) | presence, voice, motion, time |
| `project` | the app, game, codebase or thread | device presence, Claude session folder (now) |
| `flow` | starting, flowing, stuck (the same error again and again), wrapping up | Claude prompts and errors (now) |
| `since` | when it started | first event of the activity |

### 3.6 Time

`local_time`, `day`, his timezone and the place's, `work_hours` (his job's timezone, set once),
`routine` (waking, work block, meal, evening, bedtime, asleep), `next_event` (calendar, later),
`trip` (home base, day out, travelling, abroad, jet lag).

His timezone is never the hub's by assumption: the hub may keep his job's zone while he
lives in another (`intuition/time.js`). Sources, best first: the zone the phone sends with a
turn (later, next app build), the `home_timezone` setting, the hub's zone.

### 3.7 PAN itself

`mode` (normal, interpreting, dictation bystander, muted, game mode, incognito), standing
instructions (`world_modes`, done in step 2), what it is waiting on (a Claude thread, a
download), `health` (speech models up, the voice model up, the cloud reachable, quota left),
and `allowed` here (speak out loud, use the camera, store this conversation).

## 4. Situations

A situation is a named pattern over the state that PAN recognises, the way a Sims game knows
"cooking" or "at a party". It is a file (`intuition/situations/<id>.json`, step 3), so adding
one is adding a file and its test scenes, not a code change:

```json
{
  "id": "shop_abroad",
  "layer": "place",
  "recognise": [
    { "fact": "place.kind", "is": ["shop", "market"], "weight": 0.5 },
    { "fact": "place.country", "differs_from": "home.country", "weight": 0.3 },
    { "fact": "people.language", "differs_from": "his.language", "weight": 0.3 }
  ],
  "enter_at": 0.7, "leave_at": 0.4,
  "implies": { "people.who": "clerk", "conversation.pan_role": "interpreter if asked" },
  "policy": { "speak": "when addressed", "voice": "normal", "proactive": ["offer to interpret"], "listen_for": "the other language" },
  "scenes": ["shop_abroad_price.jsonl"]
}
```

**Layers.** One situation per layer can be active, and several layers at once: place, activity,
social, mode, trip, safety. "Abroad + in a shop + paying + with a stranger in another
language + interpreting + fine" is one moment. Entering needs a score of 0.7 and leaving drops
below 0.4, so it does not flicker between two.

**Policy.** What a situation decides for PAN:
- `speak`: freely, briefly, only when addressed, only if urgent, or silent.
- `voice`: normal, quiet, earbuds only.
- `proactive`: the check-ins and offers allowed here.
- `listen_for`: what to pay attention to.
- `privacy`: what may be said out loud here.
- `store`: what to keep in memory.

### Catalog v1

**Place:**
- **home:** speaks freely.
- **someone's home:** quieter, private things not said out loud.
- **work place:** brief.
- **shop or market:** offers to interpret if the language differs.
- **restaurant, café or bar:** brief; interprets the menu and orders.
- **station or airport:** directions, times, tickets.
- **vehicle:** see driving.
- **public transit:** quiet voice, earbuds.
- **hotel:** like home, but abroad.
- **gym:** short replies, counts, timers.
- **medical (doctor, pharmacy, hospital):** private, interprets carefully, no small talk.
- **outdoors:** normal.
- **event or venue:** only when addressed.
- **unknown:** asks nothing, learns.

**Activity:**
- **asleep:** silent except emergencies.
- **waking up:** the day ahead, once.
- **winding down:** no new work.
- **job, focused:** only when addressed; holds non-urgent check-ins.
- **job, meeting or call:** silent; notes if asked.
- **building with Claude (dictating):** bystander, quiet unless named.
- **game dev:** knows the project; helps when asked.
- **making music:** quiet.
- **gaming:** only when addressed, short.
- **cooking:** timers, steps.
- **eating:** relaxed, social.
- **watching TV or video:** ignores the media voices.
- **resting:** light.
- **exercising:** short.
- **walking:** normal, glanceable.
- **driving:** short, hands-free, nothing to read.
- **shopping and paying:** prices, interpreting.
- **ordering food:** interpreting, allergies.
- **asking directions, buying tickets:** interpreting, maps.
- **packing or travelling:** checklists, times.
- **errands:** lists.
- **socialising:** only when addressed.

**Social:**
- **alone:** free.
- **alone with media on:** ignores the TV.
- **talking to PAN:** a conversation.
- **talking to one person:** `on_call` (section 15), never interrupts.
- **group:** `on_call` (section 15): helps when asked or when nobody else can, never interrupts.
- **phone or video call:** silent.
- **with someone in another language:** interpreter.
- **someone asks about PAN or the recording:** answers honestly, offers to stop listening.
- **a private or intimate moment:** silent, stores nothing.
- **a heated argument:** silent, no check-in until it is over.

**Mode:**
- **normal**
- **interpreting:** language and direction.
- **dictation bystander**
- **muted**
- **game mode:** the GPU is the game's.
- **incognito:** nothing stored.
- **maintenance:** a swap or an update.

**Trip:**
- **home base**
- **day out**
- **travelling:** in transit to somewhere.
- **abroad:** another country and language, so interpreting is on offer.
- **jet lag:** the routine shifted.

**Safety:**
- **fine**
- **low battery or no connection:** says so once, then gets short.
- **PAN degraded:** the cloud or a model is down; it says what still works.
- **possible distress:** his words; one gentle check-in.
- **possible emergency:** "help", a fall, no answer to a check-in; asks, then alerts his chosen contact.
- **lost abroad:** where he is, the way back, the local emergency number.
- **unwell:** symptoms in his words; interprets at the pharmacy.

## 5. How it updates

1. **Events come in.**
   - A voice turn (the words the hub heard, the language, the addressed score, who spoke)
   - An overheard line
   - PAN's reply and whether it was heard
   - The phone's sensors on each turn
   - Computer presence
   - A camera caption
   - A Claude prompt
   - A calendar boundary
   - Mute and unmute
   - A mode change
   - A decay sweep every minute
2. **Recognisers update the facts.** Rules handle the clear cases. Small local models handle the
   fuzzy ones:
   - **Language:** from the speech model.
   - **Topic shift:** distance from the running topic in embedding space (qwen3-embedding, on the
     hub).
   - **Mood and tone:** a small text classifier.
   - **Speaker change:** a voice embedding (later).
   - **Place kind:** the map category of the address.
3. **Situations are scored.** Each layer keeps its best one past `enter_at`.
4. **Policy applies.** Speak or not, how, and what PAN listens for.
5. **The world is written.** The event log and a snapshot are saved, so a swap or a restart keeps
   it.
6. **Readers get it.** Every model gets the state line, `GET /api/v1/world` and the MCP tool give
   the whole thing, and triggers fire on situation changes.

The **state line** every model gets is short (about 200 characters). Only facts above 0.3
confidence go in it, and the mode comes first:

```
Mode: interpreting Greek. Place: a shop, abroad. With: a clerk (Greek). Doing: paying. Topic: the price.
Mode: dictating to Claude, stay quiet unless named. Place: home, desk. TV on.
Place: home. Doing: game dev (Godot). Alone. Mood: focused. 23:40, usually winding down.
```

## 6. How it keeps growing

- **Unknowns are logged.** When events keep coming and no situation in a layer passes its bar
  for 10 minutes, Intuition writes an `unknown_situation` record: the facts it had and the
  lines it heard. Reviewing those, with him, is how new situation files get written, each with
  a test scene. This is the AI Cyclosis loop applied to Intuition.
- **He can teach it by voice.** "This is my gym." "When I'm here, stay quiet." "This is Maria,
  she speaks Spanish." Each becomes a place label, a personal policy or a known person in his
  database, never in the repo.
- **Corrections count.** "I'm not at work, I'm at home" sets the fact to 1.0 and lowers the
  recogniser that got it wrong.

## 7. Where it lives

| Part | Where |
|---|---|
| The state, its event log and snapshot | `intuition/world.js` (the modes since step 2) |
| Situation files and their scenes | `intuition/situations/` (repo, generic) |
| Recognisers | `intuition/recognise/*.js` |
| His places, people, personal policies | his PAN database |
| Readers | the state line (router.js), `GET /api/v1/world`, the MCP tool, the panel |

## 8. Signals: have and add

| Signal | Now | Unlocks |
|---|---|---|
| GPS and speed on each voice turn | yes | place, country, motion |
| Phone motion between turns (Android activity recognition) | add, app | driving, walking, still, asleep |
| Wi-Fi name, car Bluetooth | add, app | home, car, work |
| Microphone level, overheard lines | overheard count only | noise, TV, a crowd |
| The language heard | yes | abroad, people's language, interpreting |
| Speaker ID by voice | add | who is talking, known people |
| What each computer shows | yes | activity, project |
| Claude prompts | yes | dictating, building, stuck |
| Phone camera, on request | yes | what he looks at |
| Pendant camera every ~10 s | later (hardware) | attention, place, people |
| Calendar | add | meetings, next event, travel |
| Phone call state, media playing, battery | add, app | on a call, TV, low battery |
| Face ID | off | known people at home |

## 9. Tests

Each situation file names its scenes. A scene is a list of events, each followed by the facts
and situations expected after it. The state bench (plan step 8) runs every scene. A situation
without a passing scene is not done.

---

# Version 2 (2026-11-11)

Why: on 2026-11-10 he asked PAN eight times in ten minutes when the sun comes up where he is.
Every answer was some form of "your GPS is off". Three things were wrong at once:

- the world knew where he was, but the voice model only read the world when his words
  matched a short phrase list (and the `voice_situation` setting was `off`);
- the phone had switched its own GPS off: the app's mute switched every sensor off (section 13);
- nothing in PAN knew the daylight, so there was nothing true to say.

His direction: the world is one live object of everything a person awake in the room would
know, nested, kept up to date in the background even while PAN is quiet, and read on every turn
it has something for. No special per-question lookups: a fact a person just knows is a field of
the world, and anything else is found in the background before he asks.

## 10. What v2 adds to the fields

New rows, on top of section 3. "Now" means built; "next" means a later step (section 14).

### 10.1 Time and light (adds to 3.6)

| Field | Values | Source | Status |
|---|---|---|---|
| `light` | daylight, dark | his place and the date, NOAA sun formula (`intuition/place.js`): no network, within about a minute | now |
| `sunrise`, `sunset` | today's, and tomorrow's sunrise after dark, in his zone | same | now |
| `weather` | now and the rest of the day, in a few words | open-meteo for his place, fetched in the background every 30 min, never on a turn | next |
| `season`, `holiday` | season at his place; a public holiday there today | the date and the country | next |

### 10.2 The place (adds to 3.2)

| Field | Values | Source | Status |
|---|---|---|---|
| `last_fix` | the phone's last GPS place and its age | every turn that carries GPS (`notePhoneGps`), kept in memory and in the settings row `last_phone_place`, so a turn without a fix still knows where he was | now |
| `home_or_away` | home, out nearby, away (another city), abroad | distance from his home place (taught once) and the country | next |
| `network` | home Wi-Fi, other Wi-Fi, mobile data | the phone (app) | next |

Coordinates stay on the hub. The line carries the place name, never the numbers.

### 10.3 People (3.3, as a nested list of records)

Each person in the room is an entry in `people[]`: `{ ref, who, role, language, talking_to,
last_heard, confidence }`. `ref` points at a record in his people table: name, relation, how they
know each other, the last time together, what they talked about last. The record is not copied
into the world. It loads onto the shelf (section 11) in the background as soon as the person is
named or their voice is recognised, so it is ready before anyone asks about them.

### 10.4 Him and his devices (adds to 3.1)

| Field | Values | Source | Status |
|---|---|---|---|
| `sensors` | which phone sensors are on (each a switch in the app) | the sensor rows on the hub | now |
| `battery`, `charging` | phone battery level | the phone, with each turn | next (app) |
| `on_call`, `media` | on a call; music or video playing | the phone | next (app) |
| `phone_zone` | the phone's time zone | the phone, with each turn | next (app) |
| `waiting_on` | what he asked for and has not had yet (a Claude thread answer, a reminder) | the relay, PAN's promises | next |

### 10.5 Sensor switches decide what goes in

A field fed by a sensor is read only while that sensor's switch is on in the app. With GPS off,
`place`, `light` and `weather` read as unknown, and the voice says so once, plainly, instead of
guessing. The last known place still counts, with its age said.

## 11. The shelf: background attention

What a person in the room does without being asked: they hear names, places and topics go by,
and they already know, or quietly recall, what those are. When someone turns to them, they are
ready. PAN does the same, all the time, on the hub, while it is not replying.

1. **Every line heard**, addressed to PAN or not, goes through cheap extraction with no model:
   names (his people table, capitalised words), places, things, the running topic.
   `intuition/conversation.js` already keeps the topic and `mentioned`.
2. **Each new item starts lookups in the background**, cheapest first, each with its own small
   time limit, never on a voice turn:
   - his PAN memory (the embedding index he already has),
   - his people and places tables,
   - the local knowledge library (section 12),
   - the news feed for anything current (Google News RSS, the one search that works from the
     hub).
3. **Results go on the shelf**: an in-memory list of `{ item, fact, source, at, score }`, a few
   dozen entries, each with its embedding, computed once when it lands. Entries fade over about
   15 minutes unless the item comes up again.
4. **On a turn**, his line is embedded once (about 20 to 50 ms on the hub) and the two or three
   closest shelf entries above a score go into the prompt with the state line. Nothing is
   fetched while he waits.

The whole world lives in memory in the PAN process (the Craft) and is saved to the database on
change, so a swap or restart keeps it:

```
world = {
  him:    { awake, motion, mood, needs, devices, sensors, ... },
  place:  { label, kind, address, last_fix, country, zone, home_or_away, noise },
  time:   { local, day, light, sunrise, sunset, weather, routine, trip },
  people: [ { ref, who, role, language, talking_to, last_heard } ],
  talk:   { topic, topics[], mentioned[], open[], floor, tone, pan_last },
  doing:  { activity, project, flow, since },
  pan:    { mode, standing[], waiting_on[], health, allowed },
  shelf:  [ { item, fact, source, at, score, vec } ],
  line:   "the state line, rebuilt on every change"
}
```

Speed: on a turn the voice reads `world.line` and the top shelf entries. That is a string copy
and one embedding. The line is rebuilt when something changes, not when he speaks.

### 11.1 Built (2026-11-23): notes on things, by name

The memory's facts could not fill the shelf: 9,926 facts, 6,352 filed as his preferences, mostly
scraps of scheduled job prompts; none said what his projects are, and by meaning a relevant fact
scored 0.67 against 0.60 for an unrelated one. So the shelf holds **notes on things** instead
(`memory/things.js`, table `memory_things`), found by **name**, not by meaning:

- **Understood the first time.** The watch (started by the steward with consolidation) reads his
  typed prompts every 3 minutes. Scheduled job prompts and pastes are not his words. A new
  capitalised name (or a thread's project folder) gets a note within minutes, written by the
  hub's own model (`gemma4:e4b`, setting `job_models['memory-things']`) from how it **first**
  came up plus a spread of the latest mentions. Every 3 more mentions it is rewritten.
- **Never during a turn.** A note is written only after 3 quiet minutes, and any heard line stops
  one in progress (`pauseForTalk`); it is written later.
- **Names, spelled the way speech hears them.** Doubled letters count as one: "ellipsis" finds Elipsis.
- **Where the notes go:** the shelf (`intuition/shelf.js`: a named thing stays ready 15 minutes,
  the two freshest go to the bigger model's prompts, and a question about his own thing is not
  searched on the web); the situation line (what the things on his screens or in the talk are);
  memory search (a matching note is the first result, for the voice's recall and for `pan_search`).
- The reader's own prompt is unchanged.
- **A note is an object** (the owner's keys, 2026-11-23), the same for any kind of thing, a
  person, a company, a job, a project, a place, an event: name, aliases, kind, what, role, who
  (name, role, reach), where, when (can repeat), state, as_of, next (what, on), needs, facts,
  reach, links, private, importance. Stored as JSON (`obj`); `renderThing` makes the short
  key: value lines a prompt reads (`record`). Keys the notes do not show are left out.
- **What a note never holds**, checked in code whatever the model writes (`cleanThing`): the
  owner listed under `who`; the owner's own address, phone, email, passwords or account
  numbers (facts whose key says so, any value with a phone number or an email); filler such as
  "Not specified"; a value copied word for word out of the evidence (the model pasted a line of
  an assistant's reply as a note's state).
- **His things, not the news.** After a note is written for anything that is not a project, job,
  app, person or conversation, the model is asked one short question about it: part of his own
  life, or only a public topic he talked about (a country in a talk about the Baltics)? A topic
  has its note dropped and waits for more mentions.
- **Endpoints:** `GET /api/v1/things` (`q` filters by name), `GET /api/v1/things/:name`,
  `POST /api/v1/things/write { name, dry }` (writes one now; `dry` returns it unsaved).
- **Private notes** (health, money) are not put in a reply while two or more other voices were
  heard in the last 2 minutes.

### 11.2 Built (2026-11-23): the brief

What a person in the room already knows when he starts talking, kept ready ahead of his words
(`intuition/brief.js`). The owner asked for it: the hub keeps the small voice model up to date in
the background instead of it working out the moment on each turn, about 500 tokens of the
reader's 4,096.

- **What it holds:** the situation line (place, daylight, weather, screens, camera, the talk's
  topic, other voices), then his threads (the newest ask to each in the last 3 hours: what he
  sent, what it answered, or that it has not), the things in play (the notes on the shelf, with
  where each stands and what is next), and the talk (its summary, the topics before this one).
- **Same words minute to minute:** clock times only, never "5 minutes ago", so the read ahead of
  it (`warmStudent`, `voice-reader.js`) still counts when his words arrive.
- **Size:** at most 2,000 characters; over that, the talk, then the things in play, give way.
- **Where it goes:** in place of the situation line, in every prompt the line goes into, but only
  where the setting `voice_brief` allows: `bench` (bench turns only, the default) until the voice
  model is trained to read it, then `on`; `off` turns it off.
- **The phone:** `GET /api/v1/brief` returns `{ text, parts, tokens, mode, built_at }`, so the
  phone can keep a copy for its own model.

## 12. The knowledge library

So that facts do not depend on a search engine that blocks the hub or costs money:

- **Offline Wikipedia** as Kiwix ZIM files. The text is CC BY-SA: commercial use is allowed, with
  credit and share-alike for the text itself. English without pictures is tens of gigabytes:
  check the current size and the hub's free disk before downloading, and ask him first.
- Searched locally by title and full text; the shelf uses it for the names, places and things
  it hears.
- Facts a person works out rather than looks up (sunrise, the time somewhere else, distances,
  units, arithmetic) are code in the world, never searches.

## 13. Fixed on 2026-11-11

- **The voice reads the state line on every turn the line has something in it** (router.js),
  not only on a phrase list. The `voice_situation` setting is now `auto`; `off` restores the
  old gate. The line goes first in the voice prompt, as background.
- **Place and daylight are in the line** (`intuition/place.js`): this turn's place, else the last
  known one with its age; dark or daylight, with today's sunrise and sunset.
- **Mute no longer turns every sensor off** (app 0.4.100). The app's mic mute switched off all
  sensors with it and turned them back on only from the same button, so a mute from anywhere
  else left GPS off for days. Mute is the mic only now. The app puts back, once, the sensors the
  old mute switched off.
- **The phone's sensors list shows the phone's own parts**, not the pendant's (OV2640, L76K).

## 14. Order of work, from here

Steps 1 to 3 of INTUITION-STATE-ENGINE.md are done. Then:

1. **(done 2026-11-11)** Place memory, daylight, the line on every turn, sensors fixed.
2. **Event-driven world** (engine step 4): `applyEvent` updates the world on each turn and sensor
   event and rebuilds the line; the 60 s tick becomes a decay sweep.
3. **The shelf** (section 11), starting with his PAN memory and people table.
4. **Weather in the background**, and the app fields of 10.4 (battery, call, zone, network).
5. **The knowledge library** (section 12), after he OKs the download.
6. **Syrinx trained with the line and the shelf** (engine step 5). Round 11 still answers some
   lines worse with more context. Measure on the voicebench first; retrain only if it says so.
7. **API, MCP tool and panel; speaking up from state changes; the state bench** (engine steps 6
   to 8).

# Version 3 (2026-11-13): am I part of this?

The owner, 2026-11-13: PAN must not need its name to know it is being talked to. Its main job is to
understand the conversation it is in and know whether it is part of it: am I in a situation where
I should speak or not, do they need help, is there anyone else who can help, are they asking me or
someone else. That has to be defined, with cultural and situational awareness, and it has to be
part of the Intuition state. The name always works too, but it is the backup, not the main way.

Section 4 so far answered "group: silent unless named". This section replaces that.

## 15. Participation

### 15.1 PAN's place in the talk (`participation`, one value at a time, in the world)

| Place | What it means | How PAN speaks |
|---|---|---|
| `partner` | he is talking with PAN: alone with it, or PAN is one of the voices in a group talk | answers his lines; in a group, answers what is aimed at it |
| `on_call` | people are talking among themselves and PAN is welcome but not in it: friends at dinner, a family at home | quiet, unless asked, or unless it can clearly help and nobody else is going to |
| `observer` | PAN has no place in this talk: a meeting he runs, a phone call, someone else's private talk, a lecture, the TV | quiet; only the name or safety opens it |
| `guardian` | something dangerous is happening (section 4 safety layer) | speaks whatever the place |

The modes that already decide it (section 3.7) still do: interpreting speaks for the other
person, dictation and muted stay quiet.

The place is a fact like every other (section 2): it has sources, a confidence and a fade. It
moves with the talk. A dinner is `on_call`; when he turns to PAN and asks something, it is
`partner` for that exchange; when the others pick the talk back up, it fades back to `on_call`.

### 15.2 What PAN weighs, line by line

Each is a field with a source. "Have" means it runs today; "later" means it has to be built.

**A. Who said it**
- `speaker`: him, a known person, an unknown voice, the TV or radio, PAN's own voice coming back.
  His voice: `voice-id.js` (have, observe mode; learns his voice by itself since 2026-11-13).
  Other people told apart from each other: the interpreter's voice book (have, on the phone),
  brought to the hub (later). TV and radio: later.
- `distance`: close (him, on the mic) or across the room, from loudness (later).

**B. Who it was said to**
- PAN's name anywhere in the line, any language (`saysPanName`, have).
- Another person's name: "Maria, can you pass..." is for Maria even if PAN knows the answer (later).
- The shape of the line: a question, a request, "you" without a name (have, in the voice model).
- It goes on from PAN's last line: a follow-up to what PAN said (`followUpOf`, have), in his
  voice (have).
- Turn order: it answers the person who just spoke, not PAN (have, in the voice model).
- Which way he is facing: phone or earbud motion now, the Medallion's camera later (later).
- How it was said: louder and slower toward the mic, softer and faster to the room (later).

**C. The talk itself**
- `kind`: him and PAN, a group talk, a meeting, a call (only his side heard), a lecture or TV,
  interpreting, dictating (section 4; have in part).
- `pan_last`: when PAN last spoke, and whether anyone took it up or talked over it (have in part).
- `open_question`: a question was asked and nobody answered after a few seconds, the answers
  disagree, or someone says "does anyone know" (later).
- `stuck`: he is hunting for a word or a name ("what's it called", a long pause mid sentence)
  (later; the phone's `unfinished` flag is a start).
- `pan_knows`: whether PAN has something real to add here: the fact is in its memory or library,
  or it was in the room for it (later).

**D. Can someone else help**
- How many people are here and who they are (3.3; voice prints, later).
- Did someone already answer? An answer within about 2 seconds means the room has it.
- Was it asked of one person by name? Then that person answers first.
- Is the person who knows this in the room (his colleague on work, his mother on family)? (later)

**E. Place and culture**
- Setting: home, someone else's home, work, a restaurant, the street, the car, a formal event
  (3.2, have).
- Who might hear: with strangers present PAN never says his private things aloud.
- How people talk here: in some places people talk over each other and a quick line is normal;
  in others any interruption is rude. The language of the talk and the country (have) set PAN's
  starting patience, and it learns from him (G).
- Formality: a business meeting or a formal dinner raises the bar; friends at home lower it.

**F. Him**
- His standing wishes: "stay quiet at dinner", "always tell me if I get a fact wrong" (have:
  standing instructions).
- `interruptible` and mood (3.1, have).

**G. What it learns**
- He says "not now" or "shh", or talks over PAN: that kind of moment raises the bar.
- He asks again after PAN stayed quiet, or turns to it with "well?": PAN missed one, the bar
  goes down.
- Kept per situation and per place, so it learns that the Tuesday team call is `observer` and
  Sunday lunch is `on_call` with a low bar for facts.

**H. What is at stake**
- Speaking wrongly costs: talking over people, saying private things in front of others,
  answering something meant for someone else.
- Staying quiet wrongly costs: he waits for an answer that never comes, a wrong fact stands, he
  misses something urgent.
- Safety always speaks.

### 15.3 The decision

Firm rules first, in this order:
1. Safety: speak (`guardian`).
2. A mode decides: interpreting translates, dictating and muted stay quiet.
3. His standing wishes ("quiet at dinner") hold.
4. Said to someone else by name: quiet.
5. PAN's name in the line: answer.

Then the weighing, for everything else:
- `partner`: the bar is low. His line after PAN spoke is for PAN unless it clearly goes to
  someone else.
- `on_call`: the bar is high. PAN speaks when it is asked without the name ("can you look that
  up?", a question aimed at the device), or when an `open_question` stays unanswered for a few
  seconds, PAN knows the answer well, and the place allows it. Then one short line, or an offer
  ("I can check that"), never a lecture.
- `observer`: only rules 1 and 5.

When PAN is not sure, it uses the hold it already has (`hold_ms`): it gets the answer ready and
says it only if the room goes quiet. A missed moment costs less than talking over people.

### 15.4 How it is measured

convbench's addressed test (`evals/convbench/addressed_bench.py`, 18 languages) is the score
for this, not "would this person have spoken next". Live model on 2026-11-12, voice ID simulated:

| Moment | Right |
|---|---|
| Quiet on room talk | 99% |
| Quiet on others right after PAN answered him | 100% (50% without voice ID) |
| Quiet on him talking to others right after PAN answered him | 52% |
| Answers "PAN, ..." | 100% |
| Answers his follow-up | 81% |

The third row is the hard one now: his own voice, right after PAN spoke, turned to the others.
The words alone do not tell it from a follow-up; moving the bar only trades one for the other
(2026-11-12 replay). It needs B's facing and manner, and C's "did the others take it up".

Kinds still to add to the test, each in every language: an open question nobody answers (PAN
should help when `on_call`), a question to a named other person (quiet), him hunting for a word,
TV lines, a phone call with one side heard, a private talk, a heated argument.

### 15.5 Order of work

1. **(done 2026-11-13)** His voice learned by itself, no name needed (`voice-id.js`). Observe mode
   until his real turns show clean scores, then `voice_id_gate` = `on`.
2. **(first part done 2026-11-13)** `intuition/participation.js`: the place for every turn
   (partner, on_call, observer, interpreter) from PAN's last line, the other speakers in the
   history and the mode, logged (`[participation]`) and returned with the turn (`participation`).
   Plain rules, about 0.01 ms. Still to do: keep it in the world (`intuition/world.js`) with its
   fade, and add the setting and the talk kind to it.
3. **(done 2026-11-13)** Named-other detector: "Maria, ...", "hey Maria ...", "..., Maria?",
   "Lan ơi, ...", "민수야, ...", "マリア、..." with the names taken from the people in the talk, in
   any script. Such a line stays quiet before any model runs (`reason: 'named_other'`). Known
   gaps: Thai has no comma after a name; a name at the start for someone not yet heard in the
   talk is missed on purpose (speech-to-text capitalises every first word). A title counts as a
   name ("Gracias, señor Martínez.", "Κύριε Υπουργέ, ..."): on all 630 bench lines it caught 40, none
   meant for PAN (2026-11-13, Craft 19).
4. `open_question` and "did anyone answer" from turn timing, and `pan_knows` from the shelf
   (section 11): PAN helps when `on_call`.
5. The other people's voices on the hub (the voice book), for the people count and who answered.
6. **(first part done 2026-11-13)** Learning from "not now" and from repeated questions (G):
   the turn book and the nightly learner, section 16.
7. The new bench kinds (15.4), per language, before each step goes live.
8. Later: facing and manner (phone and earbud motion, the Medallion), TV detection.

## 16. The situational state program learns from his turns

Written 2026-11-13. Built and live on the hub (Craft swap the same day); the rules it tunes are
still in shadow.

### 16.1 Why

The rules in section 15 have numbers in them (how short is a short question, how long is a line
for the room). The right numbers differ per person and per language, and a bench can only guess
them. His own turns say what was right: if PAN stayed quiet and he asked again, it should have
spoken; if PAN spoke and he said "not now", it should not have. So the program keeps every turn,
labels it from what he did next, and retunes itself on a schedule. Local, plain arithmetic, no
model, no cloud.

### 16.2 The turn book (`intuition/turn-book.js`, table `situation_turns`)

Every real voice turn (never a bench turn) is written after PAN answers: the line, the recent
history, the language, what the program saw (place, ms since PAN last spoke, whose voice and the
likeness, p_pan, named_other) and what PAN did (spoke or not, the reason, held, the first 300
characters of the reply). The next turn labels the one before it:

| Label | PAN did | Then he | Window |
|---|---|---|---|
| `missed` | stayed quiet | said it again (60% the same words) or called ("hello?", "PAN?") | 25 s |
| `quiet_ok` | stayed quiet | went on with the talk | 25 s |
| `intruded` | spoke | said "not now", "shh", "stop", "σώπα", "chut"... | 15 s |
| `spoke_ok` | spoke | followed up on the answer | 45 s |

A turn in someone else's voice never labels anything. Turns older than 180 days are dropped.

**Labels v2 (2026-11-22, live on the hub, Craft 49).** On his first 1,390 turns the table above
called 123 turns `missed`, but 76 came while he dictated or music played and most of the rest were
the same words heard twice or a song's chorus. Only "shh" counted as PAN talking over him (6
turns). Now:

| Label | PAN did | Then he | Window |
|---|---|---|---|
| `missed` | stayed quiet | called it ("hello?", "PAN?"), or said it again WITH the name added | 25 s |
| `quiet_ok` | stayed quiet, and its own weighing decided (not music or dictating) | went on with the talk | 25 s |
| `intruded` | spoke | said "not now"/"shh"; went on dictating (45 s); talked over it (next line under 0.4 s after PAN's voice stopped, laughing aside); or the line opened with another assistant ("Okay Google", "A google ...") | 15 to 45 s |
| `wrong` | spoke, rightly | said the answer was wrong ("that's wrong") | 15 s |
| `spoke_ok` | spoke | followed up on the answer | 45 s |

A plain repeat gets no label. Test devices (`voice_test_devices`) stay out of the book, and each
turn now keeps its device. `relabelAll()` redoes every stored label with the current rules; run
once on the hub: 6 missed, 123 quiet_ok, 16 intruded, 1 wrong, 53 spoke_ok, 1,190 unlabeled.
Most of PAN's replies get no clear reaction, so a checked set (turns judged one by one) is the
scoreboard for `docs/CONVERSATION-CALCULUS.md`; it stays on his machines.

### 16.3 The nightly learner (`intuition/situation-learn.js`, steward service `situation-learner`)

Checks every hour, runs once a day. It:

1. takes the labeled turns in time order, older 70% to tune on, newest 30% to check;
2. tries the short question size (3 to 10 words) and the long line size (8 to 25 words, or off)
   on the older turns;
3. keeps the best setting (`situation_params`) only if it beats the current one on the newest
   turns by 2 points, with at least 20 newest turns; otherwise nothing changes;
4. writes every try, kept or not, to `situation_learn_runs`, with how PAN did as it was;
5. writes all labeled turns to `<data dir>/situation-dataset/labeled.jsonl`.

A pass takes about 5 ms on the hub. The rules it tunes (right after PAN answered, in a voice not
known to be someone else's: short question = for PAN, long line = for the room) are scored in
shadow either way. In the router they sit behind setting `situation_rules`: `off` (default),
`bench` (bench turns only) or `on`. They earn their way in on his turns, not on a bench.
Addressed bench, half the run, voice model alone vs program first: follow-ups 84% to 100%, his
talk to others right after PAN 69% to 73% (sizes 6/15) or 83% (4/8), all kinds 93% to 95-97%.
Full run (630 lines, 15 languages): all 91% to 95%, follow-ups 81% to 100%. Live through the
router (`bench`): follow-ups 81% to 100%. His talk to others did not move (61% to 58%, the voice
model's own run to run noise on the lines no rule touches), so a third rule went in: a bare
acknowledgement ("yeah", "はいはい", "그렇지") right after PAN needs no answer unless PAN's last line
was a question. Offline it fixed 4 to 8 more lines and broke none.

### 16.4 The dataset

`labeled.jsonl` is the same material the convbench rounds were built from, but real and his own:
what was said, what was around it, what PAN did, and what he showed was right. It is the training
and test set for the next voice model round on his conversations, and it grows every day.

### 16.5 Per person first, everyone later

Everything above is per person and stays on his hub. A voice print, a line he said, a reply, never
leave it.

The collective part is later and opt-in only. What could be shared is the shape of what was learned,
never the words: for example "in Greek, a 7 word question right after PAN spoke was for PAN" with
counts, or a setting and how much it helped. Many people's signals could set better starting
numbers for a new user in their language. Whoever shares gets paid for it through the data dividend
(project_data_staking). Not built.

### 16.6 Next

- Add more settings to the grid as more rules exist (open question timing, talk kind).
- A page on the hub showing the book's counts and the learner's runs.
- When the shadow score beats PAN as it was on 50+ newest turns, ask the owner to turn `situation_rules` on.
