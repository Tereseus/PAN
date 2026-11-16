# How other voice systems take turns, and what ΠAN takes from them

Written 2026-11-15. The owner: "We just have to understand how their turn based system works. That's all that matters." We do not use their models (too big: Unmute needs about 16 GB of graphics memory, Moshi about 24 GB). We copy the ideas.

## ΠAN today (phone, app 0.4.108)

- The phone's speech recognizer waits for 0.35 s of quiet, then Smart Turn (a small model that listens to the sound of the last few seconds) gives the odds he is done.
- High odds: send now. Low odds: hold ("sounds unfinished") and wait up to about 1.5 s more.
- On the car's slow chip Smart Turn often took over 0.8 s, so the phone decided on the words alone.
- While ΠAN talks, the mic stays open; a new line cancels the reply in flight.

### Corrected the same day, after reading the loop itself (`android/.../stt/SherpaStreamingStt.kt`, the `while` loop from about line 770)

The four lines above undersell what the phone already does. Read this before building any row of the table below.

- **End of turn starts at 0.2 s of quiet, not 0.35 s.** With Smart Turn loaded, a pause becomes a candidate after `EOT_VAD_SILENCE_MS` = 200 ms of VAD silence; the recognizer's own 0.35 s endpoint is only the trigger when the model is missing. Owner's talk, Nov 15 11:36 ET (Pixel, app 0.4.119): commits 314 to 419 ms after his last word when the model was sure (p 0.95 to 0.99), 575 to 615 ms when it first said "unfinished".
- **Row 2 (a new word resets it) is already there in another form.** Each pause is judged once, keyed on the last window of his speech (`heardAt`). Any new speech moves `heardAt`: the old verdict is dropped (`judgeFor == heardAt`), the wait restarts, and Smart Turn is asked again.
- **Row 3 (flush, don't wait) is already there.** At the decision the loop pushes `FLUSH_PAD_S` of silence into the recognizer and decodes at once (`flushedFor`, event `flush` with `grew`), so the last words are in the text that is judged and sent.
- **Row 4 (interruptions) is the one that differs.** While ΠAN talks the recognizer is not fed. An interruption is 700 ms of VAD speech (`BARGE_IN_SPEECH_MS`, gaps up to 160 ms) louder than 2.2 times ΠAN's own echo, with the echo level learned over the first moments of each line (`CALIBRATION_MS`). That is loudness, not words: a long loud noise can stop ΠAN, and a real interruption takes 0.7 s to count. Words-only means decoding the candidate run on a second recognizer stream and stopping on a word that is not in what ΠAN is saying. It needs tuning on a device with a speaker (the echo decodes into words too), so it is not a blind change.
- **Where the time went in that same talk:** end of turn 0.3 to 0.6 s; the hub's first words 1.3 to 1.9 s after that (the phone was on a second provider's Wi-Fi, on the backup route). The reply start, not the turn end, is the bigger part of the gap today (`project_pan_point_six_plan`).

So of the "small ones first" (2, 3, 4), only 4 is real work. Order now: 4 (words-only interruption, on the Pad bench), then 1 (judge all the time while he talks), then 6.

### Row 4 built: words stop ΠAN (app 0.4.121, code 124, on the hub since 2026-11-15 12:40 ET; rollback `app-debug.v123.apk` = 0.4.120)

**Why the old rule was slow.** voicebench on the OnePlus Pad (`python run.py --only barge,backchannel`, run `20261115-121424`): interruption to ΠAN going quiet 1738 / 1771 ms (p50 / p90). The clips start "wait,", "hold on,", "stop,": a quarter second of speech, then a pause. The 0.7 s rule never saw that word, so ΠAN stopped 0.7 s into the phrase after it, and the first word was lost from the turn ("When did it fall?").

**What it does now** (`SherpaStreamingStt.kt`, the `ttsOn && !barged` branch; `wordsOver`, `interrupts`):
- A run of speech louder than ΠAN's echo (same level gate as before, same calibration) is read on a recognizer stream of its own, off the audio thread: from 200 ms into the run, again every 250 ms while it lasts, and once when it ends (from 64 ms). The reading gets the run plus 250 ms before it and 0.66 s of silence (at 0.3 s "wait" came back empty and "stop" as "STO").
- `interrupts(heard, ended)`: words ΠAN is saying right now are taken out (its own voice coming back). A stop word stops ΠAN at once, alone (`STOP_WORDS`: stop, wait, hold, no, hey, pan, what, why... with how the recognizer writes them: "wait" is heard as "WEIGHT"; a 3 letter start counts, "STO"). Two real words stop it at once. One other word of 4 letters or more counts only when the sound has ended: read half way, "mm hmm" came out as "IMMIT". "mm hmm", "yeah" and hums ("M M", "MC") never count (`BACKCHANNEL`, `HUM`).
- Sound with no readable word still stops ΠAN after 1.5 s (`BARGE_IN_LEVEL_MS`), unless music is playing; that is for a language the ear cannot read. Interpreting keeps the old 0.7 s level rule for the same reason.
- One reading at a time, and the main stream waits for a reading still running, so the recognizer never decodes two streams at once.
- Events: `over_words` (text, ms, his, ended), `barge_in` gained `by` (`words` or `level`) and `words`.

**Measured on the Pad, same scenarios** (runs `20261115-122922`, `-123127`): interruption to quiet 561 / 687 ms and 397 / 607 ms (gate 500 / 1000); all 6 interruptions obeyed; all 4 "mm hmm" / "yeah" talked through. A reading takes 120 to 200 ms on the Pad. The whole turn now reaches the hub ("wait when did it fall").

**Real room, real mic:** three long lines out loud on the Pad, its own echo at 0.26 to 0.35 of full level: no reading started, no stop. A voice from another speaker across the room (the Mint at 75%) over the Pad: no stop either, before or after this change, because it never got louder than 2.2 times the Pad's own echo. That level gate is the next thing in the way on a loudspeaker device; on a phone held near the mouth the echo is small and the bench numbers apply. Not tried: reading below the gate and trusting the word filter (ΠAN's echo would be read too, so it needs a speaker-in-the-room bench first).

**Not tested:** his real voice over ΠAN on the phone; the car's slow chip (a reading may take much longer there); other languages.

### Row 1 built: looking for the end of the turn all the time (app 0.4.123, code 126, on the hub since 2026-11-15 13:45 ET; rollback `app-debug.v124.apk` = 0.4.121)

**Before:** one Smart Turn look after 0.2 s of quiet, one more at 0.65 s if the first said "not done". Then the recognizer was flushed, then the commit.

**Now** (`SherpaStreamingStt.kt`: `JUDGE_EARLY_MS` 96, `REJUDGE_STEP_MS` 200, `early`, `judgeMid`):
- A first look after 96 ms of quiet. It only counts when it is sure (0.9 or more). The normal look at 0.2 s runs beside it and counts as before.
- The recognizer is flushed while the look is running, not after it.
- While a turn is held as "not done", another look every 0.2 s of quiet, and the old late look at 0.65 s. The in between looks only count when sure.
- Not while interpreting (that has its own rule). `turn_p` events gained `quiet_ms`, `early`, `mid`, `counts`.

**Measured on the Pad** (voicebench, runs `20261115-130522` and `-132438`): a turn Smart Turn is sure about now commits 270 to 350 ms after his last word (was 380 to 460). 9 of 25 commits under 350 ms; median 400. Interruption to quiet 397 / 449 ms, all interruptions obeyed, all "mm hmm" talked through. Pause sentences cut: 25% in one run, 0% in the next (one clip, "can you explain / in simple words / how a fridge...", sits on the edge, same as before the change).

**The trade:** a sure look can now end a turn in a 0.3 to 0.4 s pause in the middle of a sentence. Before it needed 0.38 s at least.

**Real air is worse than the bench here.** The same pause clips played from the Mint's speakers to the Pad's mic across the room (`back_air.sh`): Smart Turn called "I want to cook something tonight and" finished (0.90 at 0.2 s once; 0.18 then 0.94 at 0.48 s the second time), where the same clip fed straight in scores 0.01. That is a synthetic voice through a second loudspeaker and a room, heard by a tablet. It is not his voice at the phone, so it says "check this with his real voice", not "broken".

**Final run on this build** (defaults, the "mm-hm" off): run `20261115-133356` (conversation, barge, backchannel; 76 turns). Commits: median 398 ms, 17 of 76 under 350 ms. Interruption to quiet 472 / 527 ms. "mm hmm" / "yeah" talked through 100%. Pause sentences cut 0%, in pieces 0%. Reply gap 2.4 / 4.2 s, of which the phone's decision is 0.4 s; the rest is the hub (upload and ear 0.39, first words 0.76) and the Pad building the voice (0.84). **Not the phone, but seen in this run:** the hub's voice model (r15) marked 39 of 72 turns as room talk (`"to": "room", "addressed": 0.05`) and stayed quiet, in long runs: after "Honestly that seems like a lot to me" it answered nothing for the next 20 lines, including "Tell me the main downsides of owning an electric car" and "What's the weather like in Lisbon this week?". Missed turns 56% (was 2 to 9% on Nov 5, before the rounds that taught it to stay quiet). The clips are a synthetic voice, not his (voice ID: "someone else", gate on observe), and the scripts mix lines for ΠAN with lines for the room, so the real number for him is not known. One interruption counted as failed because the hub never answered the line before it (10 s timeout), so there was nothing to stop.

### The loudspeaker level gate: measured, not fixable by reading words (2026-11-15)

Debug mode `TEST_READ_BELOW` (stays in debug builds): while ΠAN talks, read the last second every 0.3 s whatever the level, report it as `below_words`, never act. Run `below1` (`below_run.py`, `below_an.py` in the session scratchpad): the Pad said 12 long lines out loud; on 6 of them the Mint (75%) said "wait...", "stop...", "hold on..." over it.
- ΠAN's own echo at the Pad's mic: 0.14 to 0.33 of full level.
- The readings were ΠAN's own words. The Mint's "stop", "wait", "hold on" did not show up in one reading: the echo covers them.
- Applying today's word rule to those readings would have stopped ΠAN by mistake on 5 of the 6 lines nobody interrupted (13 of 150 readings), because its own words come back misheard and no longer match the line.

So on a device that talks through a loudspeaker next to its own mic (tablet on a desk, phone mic with car speakers on the media path), words cannot do it. It needs ΠAN's own sound taken out of the mic first: echo cancelling with the TTS samples as the reference (WebRTC AEC3 or Speex, both BSD), or duck and listen. Not built. On a phone near the mouth, where Android's call path already cancels the echo, the Row 4 numbers apply.

### Row 6, the simple version: "mm-hm" while he thinks (app 0.4.123, OFF unless turned on)

Not Moshi's trained version. One rule, one sound. Settings > Feedback > "Mm-hm while you think" (`backchannel_enabled`; debug: `TEST_BACKCHANNEL --ez on true`, and `TEST_HUM` plays it once).
- **When** (`SherpaStreamingStt.kt`, the hold branch; `BACK_*`): he has paused 0.45 s, the turn is 6 words or more, Smart Turn says clearly not done (under 0.2) and the words do not read as done, no music, not interpreting, not the car path; once per pause and at most once in 12 s.
- **What** (`PiperTtsEngine.prepareHum`, `hum`): "Mm-hm." built once in ΠAN's own voice, about 0.5 to 0.7 s, played at about a fifth of full level on a track of its own. It is not a line: "ΠAN is talking" stays false, so the turn stays open and the interruption logic never starts.
- **So it does not hear itself:** speech detection ignores the mic until 0.25 s after it ends (the recognizer keeps getting the sound, so words he says over it are kept). A hum the recognizer wrote at that spot is taken out of the turn, and that turn goes to the hub as words only.
- **Measured on the Pad** (run `20261115-132438`, rule then at 0.5 and 8 words): it fired 3 times; no pause sentence was cut or split. One of the three was wrong: after "how long does it take to boil an egg" (Smart Turn 0.48), and ΠAN answered 0.2 s later. Hence under 0.2 plus the words check. Played alone with the mic open (`hum1`): the recognizer wrote nothing; speech detection flickered once for 0.1 s.
- **Not measured:** how it sounds (nobody has listened to it yet), his real pauses, the phone. In real air through the Mint it never fired, because the Pad misheard the words and the rule refused. Why it is off: the owner's rule against filler sounds, and a wrong one is worse than none.

### Row 4 redone the same afternoon: hold, then decide (app 0.4.124, code 127, on the hub since 2026-11-15 14:56 ET; rollback `app-debug.v126.apk` = 0.4.123)

**The owner, on his Pixel with 0.4.123: "I try saying stop, it doesn't listen to it."** The bench had said 100%. The bench feeds clips straight into the app; a real phone hears through the call path's echo canceller, and that is where it broke.

**Measured on the Pixel** (the phone says a long line, the Mint's speakers say a short clip over it 3.5 s in; `stopclips.py`, `pixel_words.sh`, `words_an2.py` in the session scratchpad; 36 stop lines "Stop.", "Pan, stop.", "Be quiet."... and 12 listening sounds "Yeah.", "Mm hmm."..., two Windows voices; TEST_LIVE so nothing is kept):
- ΠAN's own echo after the canceller: 0.0001 to 0.003. The gate sits at its floor, 0.015. A voice over it arrives at 0.05 to 0.43. Level is not the problem on a phone.
- The speech detector (Silero) caught 0.1 to 0.2 s of each clip, or nothing: it missed 25 of 36 stop lines in one run and 3 of 30 in the next.
- What the recognizer read of a word said while ΠAN was talking was not that word: "stop" came out "WELL", "ONE", "NONE", "WRONG", "SNAPPED"; "yeah" came out "EVEN", "WAR". With 0.4.123: 9 of 36 stop lines stopped ΠAN and 7 of 12 listening sounds did too, both by luck.
- A word said after ΠAN had gone quiet read right ("okay, STOP").

**What it does now** (`SherpaStreamingStt.kt`: `BARGE_PAUSE_MS` 96, `BARGE_RESUME_AFTER_MS` 700, `BARGE_PAUSE_MAX_MS` 4000, `onPauseTts` / `onResumeTts`; `PiperTtsEngine.pause` / `resume`):
1. **Hold.** Sound over the gate for about 0.1 s while ΠAN talks, speech detector or not, holds ΠAN's voice mid-word (`AudioTrack.pause`). Not when music is playing or while interpreting, and only with the built in voice (the Android voice cannot be held; there the 0.4.121 rule stays).
2. **Listen.** With ΠAN quiet the canceller has nothing to cancel. Readings go on as before.
3. **Decide.** A stop word or two real words while he is still talking: stop, and his words are the turn, but only the part said after the hold goes to the recognizer and the hub (the part before it is what the canceller chewed: "okay, stop" used to reach the hub as "snog"). The sound ended and any word is left that is not ΠAN's own and not a plain "yeah" / "mm": stop, silently, no turn (what it read is not what he said). Nothing readable, or only "yeah" / "mm": ΠAN carries on from the same spot 0.7 s after the sound ended.
- Events: `barge_pause`, `barge_resume` (held_ms, words), `tts_pause`, `tts_resume`, `barge_in` gained `lone`, `over_words` gained `held`, and `loud_run` (measuring: every stretch over the gate, how much of it the speech detector called speech).

**Measured, same rig, 30 clips** (runs `pixel_words4`, `pixel_words5`): ΠAN went quiet at once on 29 and 28 of 30. Stop lines that ended ΠAN: 19 of 24 both times (was 9 of 36). The misses read as nothing at all, and ΠAN carried on after 0.8 s; saying it again in that gap is heard clean. **The price:** listening sounds talked through 2 of 6 (was 5 of 12 by luck). On this phone "yeah" over ΠAN mostly stops it, because nothing can tell a mangled "yeah" from a mangled "stop", and an ignored "stop" is the worse mistake. To flip that choice: `if (held && ended) return said.isNotEmpty()` in `interrupts`.
**Pad, clips fed straight in** (run `20261115-145302`): interruption to quiet 349 / 629 ms, all obeyed, "mm hmm" / "yeah" talked through 100% (there the words read right, so ΠAN holds for under a second and carries on). The first word of an interrupting turn is no longer in it ("When did it fall?", not "Wait, when did it fall?").

**Not known:** his own voice near the phone (the rig is a synthetic voice from a speaker across the room, which is harder). A loud noise holds ΠAN for under a second. If he talks during the first 1.2 s of a line, the gate learns his voice as echo and that line cannot be interrupted (seen in the runs, not fixed).

**Strict rule, the same day (app 0.4.125, code 128, on the hub 15:10 ET; rollback `app-debug.v127.apk` = 0.4.124).** The owner: "yeah" and humming must not stop it, "that makes no sense"; and someone else's "stop" should not count either. So while ΠAN is held, only this stops it (`interrupts`, `held`): a stop word (now also "don't", "shut", "silence", "shush"), a word that starts the way "stop" and "shut" do (`STOP_LIKE`, `^s[tnmpkclwhq]`: half the chewed "stop"s still read "SNAPPED", "SMOKE", "STUD", "SHE"), or three real words. Everything else: carry on, now 0.9 s after the sound ended (was 0.7), to leave room for a second word. Replayed on the Pixel recordings (`replay.py`, no new run): listening sounds stop ΠAN 1 of 22 (was 18), a single "stop" 2 of 24 (was 18), phrases 22 of 56 (was 48; too low, the recordings end at the first junk stop). In practice: the first "stop" makes ΠAN go quiet, the second one, said into that quiet, reads clean and ends it. Pad, clips fed in (run `20261115-150616`): interruption to quiet 402 / 427 ms, "mm hmm" / "yeah" talked through 100%. Not run through the air again (the owner had had enough noise).
**What gets both** ("stop" once, "yeah" never, not someone else): ΠAN's own echo cancelling on the raw mic, so words over it are not chewed; then voice ID on anything about a second long, and closeness (a Medallion hears him far louder than anyone else). Whose voice cannot be told from a quarter second "stop". Next piece of work; the car and the tablet need the same thing.

### ΠAN's own echo cancelling: first measurement says the simple way will not work on the phone's speaker (2026-11-15)

Debug recorder `TEST_AEC_DUMP --ez on true|false` (`debug/AecDump.kt`; in debug builds from the one installed on the Pixel at 15:14 ET, not yet in a published build): records the raw mic (the UNPROCESSED stream `MusicDetector` already opens), the mic after the call path, and every line ΠAN plays with its start time; files in the app's external folder `aecdump/`. While it runs ΠAN is not held or stopped. Rig: `pixel_dump.sh` on the Mint; analysis `aec_an.py` (aligns the lines, cancels, reads the result with the phone's own recognizer, model copied from the Pad).

One 47 s recording on the Pixel (`aecdump1`):
- Speaker to raw mic delay 73 to 96 ms, different on every line.
- At the raw mic ΠAN's echo is 0.025; the Mint's voice from across the room is 0.008 to 0.016, quieter than the echo. Android's call path lifts that voice to 0.04 to 0.26.
- **A fixed straight filter of what ΠAN played explains only about 30% of what the raw mic hears** (coherence: 0.9 under 300 Hz, 0.7 up to 1 kHz, 0.3 above). At best 2 dB of cancelling; a plain NLMS got 1.8 dB. The phone's speaker path (protection, compression, a small speaker at call volume) bends the sound too much. So Speex or a plain WebRTC canceller fed with the TTS samples will not do it on this speaker. Phone makers cancel with a reference taken after that processing, which an app cannot get.
- **The Mint rig understates the phone.** Said with ΠAN quiet, the Mint's "Stop." read "STOPP", "Yeah." read "YES", "Pan, stop." read "HIM SNUFF": a far synthetic voice is poorly read even alone. Under ΠAN: "SNARLING", "MAN", "AND IN SNOW". The owner near the phone is several times louder at the mic than the Mint was.

What that leaves, in the order to try:
1. **His own voice.** `pixel_me.sh` (no sound from the Mint; ΠAN talks 35 s, he says "stop", "yeah"... over it) and `me_an.py` (every burst the call path let through, what it reads as, his level against the echo at the raw mic). If his "stop" reads right, the strict rule already does what he asked and nothing more is needed on the phone.
2. Where the speaker is far from the mic and behaves (car speakers, a room speaker), a straight canceller should work far better than here. Needs one recording in that setup before building it. The reference then has the Bluetooth delay in it.
3. A canceller that handles a bent speaker (WebRTC AEC3's suppressor, or a small neural one such as DTLN-aec, MIT). These also press down a voice that talks over the echo, so they may be no better than Android's. Only worth trying on a recording first.
4. Hardware: earbuds or the Medallion with its speaker away from its mic. No echo, no problem.

**Lesson:** digital bench numbers for anything said while ΠAN talks mean nothing for a phone. The stop test has to go through the air on the real device.

Order now: his real voice on the phone for rows 1 and 4; echo cancelling for loudspeaker devices; Moshi style listening sounds only if the simple one earns its place.

## Kyutai Unmute (read from its source, unmute/unmute_handler.py and stt/speech_to_text.py, MIT)

1. **One model hears the words and judges the end of the turn.** The speech recognizer itself outputs, every 80 ms, the odds that the speaker has finished (its "semantic VAD"). It uses both the words and the tone, so "I went to the" never counts as finished however long the pause. No fixed silence timer.
2. **Smoothing and a bar.** The odds go through a moving average with a 10 ms half life, and the turn ends when they pass 0.6. The first 12 frames (about 1 s) are ignored because the odds are noisy at the start.
3. **Every new word resets it.** When a word arrives the odds go back to 0, so a single word never ends the turn before the model has heard more.
4. **Flush, don't wait.** The recognizer runs 0.5 s behind the audio. Once the end is detected, Unmute pushes 0.5 s of silence into it at once, faster than real time, so the last words come out immediately instead of half a second later.
5. **Interruptions.** While the bot talks, any real word from the recognizer stops it at once. A drop in the "finished" odds below 0.4 also stops it, but only after the bot has been talking for 3 s, because the start of its own voice leaks into the mic and caused false stops.
6. **Long silence.** If he says nothing for a while after the bot asked something, the bot speaks again.
7. The voice starts speaking from the first few words the language model writes, so the reply starts before the model finishes.

## Moshi (Kyutai)

Full duplex: one model hears and speaks at the same time, all the time. Silence is just something it outputs. Turn taking, "mm" and "yeah" while you talk, and talking over each other are learned from real two person phone conversations, not written as rules. It cannot be copied piece by piece; the idea worth keeping is that backchannels come from training on real conversations, which is how ΠAN would learn them too (from his own talk, eval only, never Claude or Gemini output).

## Sesame

CSM is only the voice. How their demo takes turns is not published.

## What ΠAN takes

| # | Idea | From | Where in ΠAN | Cost |
|---|---|---|---|---|
| 1 | Judge "finished" all the time while he talks, from words and sound together, instead of after 0.35 s of quiet | Unmute 1 | phone: run Smart Turn on a rolling window plus a words check, or train one small model on his talk | biggest gain; the 0.35 s wait goes |
| 2 | A new word resets the odds | Unmute 3 | phone STT loop | tiny |
| 3 | Flush the recognizer at the end instead of waiting for it | Unmute 4 | phone streaming STT and the hub's final pass | small |
| 4 | Stop ΠAN on real words only, never on loudness, and ignore the first moments of its own voice | Unmute 5 | phone barge in; pairs with the voice check (drop lines that sound like ΠAN) and YAMNet | small |
| 5 | Speak again after a long silence when ΠAN asked something | Unmute 6 | proactive loop (exists, check the rule) | small |
| 6 | "mm", "yeah" while he talks | Moshi | simple rule built, off by default (above); the trained version later | large |

Order: 2, 3, 4 first (small, measurable in the voice report), then 1, then 6.

## Sources

- Unmute code: https://github.com/kyutai-labs/unmute (unmute/unmute_handler.py, unmute/stt/speech_to_text.py, unmute/stt/exponential_moving_average.py)
- Kyutai STT: https://huggingface.co/kyutai/stt-1b-en_fr , https://kyutai.org/stt
- Moshi: https://github.com/kyutai-labs/moshi
- CSM: https://github.com/SesameAILabs/csm
