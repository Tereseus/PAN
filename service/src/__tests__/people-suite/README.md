# The people suite

Every test of **who a device belongs to and what that person may do** (families, organizations,
guests). The plan and the rules it tests are in `docs/PEOPLE-PLAN.md`.

```bash
python service/src/__tests__/people-suite/run.py
```

One command, about four minutes, exit code 0 only when nothing failed. `--unit` runs the fast
part alone (20 s), `--hub` the dev hub part alone, `-v` prints every check. Run it before any
change to `people.js`, `routes/link.js`, the person branch of `server.js`, `routes/api.js`
`/query/stream` or `router.js` `personTurn` goes to a hub.

## What it covers

| Part | File | What is proven |
|---|---|---|
| unit | `../people.test.js` | A code made for a person binds the device that uses it, once. Every role by every action (72 pairs): allowed exactly when the role's power reaches the limit. What is the owner's alone stays his at any power below his. The owner's changes to the limits hold, nonsense in the setting does not. Shared devices. A removed person. The path list and paths dressed to look like it. |
| unit | `../person-voice.test.js` | Fake owner data is planted in the database (name, facts about him, personality, a memory, a screen title, his talk). 70 lines by 6 kinds of person by 2 kinds of model (840 prompts): none holds a word of it, including lines that pretend to be the owner or the system. A name cannot write the prompt. The owner's threads and computers get no answer at all and nothing is sent. Opened by the owner, an adult reaches them and a child does not. Camera, mute and room talk for every kind of person. |
| unit | `../pan-link-routes.test.js` | Pairing codes for a person are limited from the start; handing a device over sets the limit first; taking it back lifts it; a device PAN Link does not know cannot be handed over. |
| unit | `../pan-link-auth.test.js` | A device's identity comes from PAN Link's secret, and forged headers are refused. |
| unit | `../notes-sender.test.js` | A note's sender is the PAN Link device, not what the note says; six spoken notes a minute per device; a note goes to the device of the person it is for (pinned device, the device he last talked on, the asker of a thread, what happens when that device is away, expiry). |
| unit | `../person-messages.test.js` | What counts as a message to someone on the hub and what does not; whose device says it; a person to the owner and to another person; who may send; a device that is off; six a minute. |
| unit | `../thread-people.test.js` | Whose a relay host is; which threads the owner and each person can reach; the owner's own thread first; what one person heard or asked never reaches another; a job is taken only by the computer that holds its host; handing over, taking back, removing. |
| link | `pan-link/allow_test.go` | PAN Link's own wall (runs when Go is installed). |
| hub | `hub_suite.py` | A dev hub with its own port and database and a stand-in for PAN Link's admin. Five people (child, guest, adult, manager, admin), each with a paired device, plus the owner's two devices, a device whose person was removed and a device nobody knows. |

The hub part, by group:

- **owner**: the owner's devices read and change settings and talk, as before.
- **pairing**: a code per role, limited from the start; each device arrives as its person; a
  code for nobody is refused; a code for the owner is not limited; a wrong link secret; with a
  code waiting and PAN Link silent an unknown device gets 503 on an API path and on a page,
  never the owner's reach; a removed person's device is nobody's at once.
- **wall**: `routes.py` reads every route out of the hub's source (about 590). Each is sent
  from the child's device, and one in four from another role's. Every one not on
  `PERSON_ALLOW` must answer `not open to this person`; every one on it must be open. Then 68
  tries at pages, odd spellings (`..`, `%2f`, `//`, upper case, a trailing slash, a null byte)
  and paths dressed as allowed ones, and headers that claim to be local, the tailnet or the
  owner's phone. A route written next year is swept the day it is written.
- **talk**: for each role: mute, a line said to someone else, three asks about the owner's
  threads (no answer, nothing queued), their own name, a question about the owner with the
  owner's phone named in a header. No words of theirs in the owner's events. A person's device
  naming the owner's phone cannot cancel his turn.
- **notes**: the rate limit, the real sender, no person can send a note. A note the owner
  sends to the child reaches the child's device and no other role's, whatever name a device
  sends; the owner's own note stays his; a note for nobody is refused; a device limited to
  sending notes cannot say who a note is for; with a device pinned, the owner's notes go to
  it and not to whichever asks first. The old door for another hub's messages is gone.
- **computers**: two more people get a computer each. Each reports its own threads; nobody
  (the other person, the owner's second device) can report under a name another computer
  holds; a person's computer sees no registry and none of another host's jobs; a job the
  owner sends to a person's thread can be read, answered or failed only by that person's
  computer, which is told the owner is asking. By voice: an adult reaches her own threads
  and her list is her own; "the notes thread" from her is her Notes and from the owner is
  his; the owner's thread, another person's and one nobody has get her one and the same
  answer and queue nothing; a child with a computer gets silence; the owner asks about a
  person's thread by her name; a removed computer's threads are gone.
- **messages**: the owner tells a person something by voice and only her device gets it, as
  his words; a person tells the owner; a child can too, and only the owner's device gets it; the same words not said to PAN send nothing; an order inside a message is only
  words on the other device and queues no job; a test turn sends nothing.
- **admin**: no role can add, rename, promote or remove people, pair a device, free their own
  device or change the limits; the owner can; handing over and taking back; removal.

The sweep never runs as the owner: it first checks that its device is a child and that the wall
answers, and stops if not (as the owner it would call every delete route there is).

## Real devices

`devices.py` is a separate, deliberate step, because it uses a live hub: it hands a paired
test device to a test person, sends lines on that device with the app's test intents, reads
what came back, then takes the device back and removes the person.

```bash
python service/src/__tests__/people-suite/devices.py --hub http://<hub>:7777 --adb <adb serial> --link-device <pan-link id>
```

## Not covered yet

Things the plan names that have no code to test: interpreting and a memory of a person's own,
messages to people, two devices talking together, the crowd layers. WebSockets are opened by the
Carrier, where PAN Link's list is the only wall; that list has its own tests (`link`).
