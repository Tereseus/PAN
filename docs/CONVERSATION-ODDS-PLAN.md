# Conversation as odds: plan

Written 2026-11-22 for the owner to review. Step 0 (labels) and step 1 (offline fit) done the same day; see the end.

## The idea

Stop fixing conversation one bad answer at a time. Every decision PAN makes in a talk becomes a
number worked out the same way, from the model's own word odds plus the situation, and fitted on
the owner's real turns.

A language model picks every word from a list of odds ("pan" 62%, "room" 31%, ...). Those odds
are the model's real judgment. When we instead ask it to write a judgment as text, a small model
writes rough buckets (measured 2026-09-16: no, don't know, yes). So we read the odds and do the
arithmetic ourselves.

Three numbers, every turn:

| Number | Question it answers | Replaces |
|---|---|---|
| `p_for_pan` | is this line for PAN? | hand rules and fixed thresholds (`minPan`, "after PAN spoke, everything is for PAN") |
| `sure` | does PAN actually know what it is about to say? | keyword lookups (the weather list), and invented details |
| `worn` | has PAN leaned on this phrase too much in this talk? | nothing today; "Fair enough" six times in one talk |

## What already exists (read 2026-11-22)

- **The reader already reads one odd.** `voice-reader.js` asks Syrinx for one token after
  `{"to": "` and reads the odds of `pan` (`pPan`). If `pPan` clears `minPan` (or `needPan` while
  dictating), PAN answers. So the "who is it for" odds are read today, but used alone, against a
  hand set bar, with the situation added as separate rules.
- **The situational state program** (`intuition/participation.js`, `INTUITION-STATE.md` section 15)
  works out place (partner, on_call, observer), time since PAN spoke, whose voice, named other,
  music, dictating. Plain rules on top (`situation_rules` = `on`).
- **The turn book** (`intuition/turn-book.js`, section 16) keeps every real turn with what PAN saw
  (`p_pan`, place, `since_pan_ms`, voice, likeness, named_other) and what it did, and labels it from
  what the owner did next. 415 labeled turns, Nov 14 to Nov 22.
- **Repetition:** `repeat_penalty` 1.15 over the last 192 tokens of one reply. Nothing across the talk.
- **Lookups:** keyword lists decide when to fetch live facts (`weather.js` `WEATHER_RE`).

## What the numbers say today (415 real turns, read only)

- The odds already work where the labels are clean: `p_pan` tells "he followed up on PAN's answer"
  from "the talk went on without PAN" almost perfectly (AUC 0.975, 35 vs 75 turns).
- `p_pan` exists on only 143 turns. The rest were decided by rules before the model ran (music 117,
  dictating 80).
- **The scoreboard itself is wrong in two ways, so it has to be fixed first:**
  - 123 turns are labeled `missed` ("he said it again"), but 76 of them were while he dictated or
    music played, where repeating words is normal. Most of those are not misses.
  - Only 6 turns are labeled `intruded`, because the only sign it knows is "shh" or "not now". The
    owner rarely says that; he just carries on. Today's bad talk, where PAN answered his dictation
    and his words to Google, would mostly not show up as intrusions at all.

## How the three numbers are worked out

### 1. `p_for_pan`: one running number instead of rules

Each line moves the odds. In plain arithmetic (log odds, so pieces add up):

```
score = base
      + w1 * reader's log odds of "pan"
      + w2 * PAN spoke in the last N seconds (fading with time)
      + w3 * his voice / someone else's voice
      + w4 * PAN's name said          + w5 * another person named
      + w6 * dictating                + w7 * music or TV
      + w8 * talking to another assistant ("Okay Google", "Claude", "Siri")
      + w9 * place (partner / on_call / observer)
      + w10 * the last line's score (the talk carries over, but fades)
p_for_pan = 1 / (1 + e^-score)
```

- The weights `w` are fitted on the labeled turns (logistic regression: the standard way to turn
  several signals into one calibrated probability). Nobody sets them by hand.
- "The talk carries over" is the running part: it replaces "PAN just spoke, so the next line is
  for PAN" with a number that fades and that one strong signal (Okay Google, dictation) can
  outweigh.
- Speak, hold or stay quiet is then one decision on one number, with a cost for each mistake:
  talking over him costs more than missing one (section 15.3's own rule). The bar comes from
  those costs, not from a guess.
- Hard rules stay only where no number should argue: safety, mute, interpreting, dictation into a
  thread.

### 2. `sure`: is it guessing?

While PAN writes a reply, read the odds of the words that carry facts: places, numbers,
temperatures, times, names. When the model knows something, the top word has high odds. When it
is guessing ("New York", "since dawn"), the odds are spread over many words.

- Low `sure` on a fact word: stop, fetch the fact (lookup, memory, the shelf) and write again, or
  say plainly that it doesn't know.
- This is what replaces the weather keyword list: "should I bring a coat later" makes the model
  reach for a temperature it doesn't know, its odds drop, and the lookup runs. The same rule
  covers any question where facts are needed, in any wording and language.
- Cost to check: reading odds while writing is nearly free on llama-server (`n_probs`); a second
  write after a lookup adds the lookup time on those turns only.

### 3. `worn`: stock phrases

Keep a count of PAN's own phrases over the whole talk (and the day). Push down the odds of a
phrase each time it is reused (llama-server `logit_bias`), so "Fair enough" can still come up but
gets less likely every time. Measured as: share of replies that start the way one of the last 10
replies did.

## The scoreboard comes first

Better labels from what the turn book already records, plus a checked set:

| New label rule | Why |
|---|---|
| Repeating words while dictating or with music is not `missed` | removes most of the 76 false misses |
| PAN spoke and he carried on dictating or talking to someone else without taking it up: `intruded` | catches the intrusions he never says "shh" to |
| PAN spoke and he talked over it within a second: `intruded` | same |
| Lines to another assistant ("Okay Google ...") that PAN answered: `intruded` | today's case |

Then a checked set of about 200 of his turns, judged one by one (Claude may judge; the owner spot
checks). His real lines stay on the hub and the G16, never in the repo or a training set without
his say.

One score for every change: how often PAN talks over him and how often it misses him, on the
same turns, against how PAN did as it was.

## Order of work

| # | Work | Touches the live voice? |
|---|---|---|
| 0 | Fix the labels and build the checked set | no |
| 1 | Fit `p_for_pan` offline on the logged turns; compare with today's rules on the same turns | no (arithmetic, about a second) |
| 2 | Shadow: compute and log `p_for_pan` every live turn, act on nothing, 2 to 3 days | logging only |
| 3 | Turn it on: addressed bench, conversation bench and a replay of his real lines first, then a Craft swap at a quiet time | yes, with his OK |
| 4 | `sure`: log fact word odds, replay talks with invented details against normal ones, measure | logging only |
| 5 | `sure` live: lookup or "I don't know" on low odds; remove the weather keyword list | yes, with benches |
| 6 | `worn`: phrase counts and odds push across the talk | yes, with benches |

Training rounds keep going alongside. They make the raw odds better; this turns the odds into
decisions. Each new round gets scored through the same fitted numbers.

## What this does not solve

- His own voice turning to other people right after PAN answered him. The words alone look like a
  follow up. It needs facing and manner (phone motion, the Medallion camera), section 15.2 B.
- A model that has never seen a kind of talk can't give good odds on it; that is what training is for.

## Cost

No new models, no cloud. The fit is plain arithmetic on the hub. The only extra work per turn is
reading odds the model already computes.

## Step 1 result (2026-11-22, offline, nothing live changed)

Voice model round 24 went live the same day, so the fit used r24's odds: every one of the 1,390 turns
in the turn book read again by r24 on the Mint (the reader's own call, who token only). Labels: the
checked set (233 turns judged one by one) plus labels v2 where no judged label exists; 366 turns in
all, 124 for PAN, 242 not. Twelve situation numbers: the reader's log odds, time since PAN spoke
(fading, tau fitted), the two multiplied, the last turn's odds (fading), his voice, another voice,
another person named, PAN named, another assistant named, dictating, music, line length. Logistic
regression, settings picked inside the older 70% only.

| Check | Fitted, all twelve | r24's odds alone |
|---|---|---|
| Newest 30% (110 turns): log loss, lower is better | 0.725 | **0.609** |
| Newest 30%: AUC | 0.748 | **0.817** |
| Each day left out in turn (366 turns): log loss | 0.465 | **0.445** |
| Each day left out in turn: AUC | 0.847 | **0.852** |

**The situation adds nothing that holds up yet.** r24's own odds alone are as good or better. Why:

- **The labels do not cover the situations that matter.** All 242 music turns and 87 of 89 dictation
  turns have no label: labels v2 skips them on purpose and the checked set did not reach them. So
  the fit cannot learn what music or dictation means; its dictation weight came from two turns.
- **The share of lines for PAN moves a lot from day to day** (Nov 14: 10 of 93; Nov 21: 29 of 48;
  Nov 22: 6 of 31). A fit on older days carries their share into newer ones.

What the odds alone already give, on the same 366 turns (live PAN as it was: answered 89 lines not
for it, missed 13):

| Bar on r24's odds of "pan" | Answers lines not for PAN | Misses lines for PAN |
|---|---|---|
| 0.5 | 80 | 13 |
| 0.8 | 57 | 23 |
| 0.9 | 49 | 29 |
| 0.98 | 30 | 40 |
| 0.99 | 23 | 46 |

Every point on this curve trades one for the other: the cost ratio `c_I / c_M` (how much worse
talking over him is than missing him) picks the point, and that is the owner's to set. At equal
misses (13), r24's odds alone answer 80 lines not for PAN, against 89 for live PAN with all its
rules.

Next: label the turns the fit cannot see (music, dictation, the newest days), then fit again. The
situation terms only earn a place in `p_for_pan` when they beat the odds alone on days left out.
Files (local, his lines): scratchpad `step1_prompts.py`, `step1_run.py` (Mint), `step1_odds.jsonl`,
`step1_fit.py`, `step1_weights.json`.
