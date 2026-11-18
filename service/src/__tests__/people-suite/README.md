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
| unit | `../person-messages.test.js` | What counts as a message to someone on the hub and what does not; whose device says it; a person to the owner and to another person; who may send; a device that is off; six a minute. Kept in the database: a restart loses nothing; one device says it, once; the conversation both people see and nobody else; what is too old to read out; pages. Two people with one first name: ΠAN asks which, and the whole name or the rest of it answers. The owner may read a child's and nobody else's, and looking opens nothing. |
| unit | `../met-people.test.js` | A meeting is kept and the same key is the same person; each person's own list; a stranger's name as plain text; a bad code; forgetting only one's own; 500 at most. |
| unit | `../people-groups.test.js` | A group is a name; a person is in one group or none; renaming; deleting leaves the people; thirty at most. |
| unit | `../group-calls.test.js` | A call with a whole group: what is said to start, join and leave one; who is rung and who is not; nothing passed on before a person comes on; who hears a line and who can read it later; how it ends; one call at a time; the limit; ΠAN's answer shared. |
| unit | `../person-voices.test.js` | A person's voice is learned from their own turns; the owner's, another known person's and a stranger's voice are dropped on their device; a device that mostly hears someone else never learns them. |
| unit | `../same-line.test.js` | The same words at the same moment on two people's devices are one line: the voice's, else the louder device's; waiting ends by itself; different words or one word are never compared. |
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
  words on the other device and queues no job; a test turn sends nothing. The People tab's
  calls: a person's list of the others and what is new, her conversation with the owner in
  order, opening it marks it seen, nobody opens a conversation they are not in, a typed
  message is said on the owner's device only, the owner's list, and messages to nobody, to
  oneself or with nothing in them are refused. The owner reads a child's list and
  conversation and it opens nothing; the child's list says who can read; an adult's, the
  owner's own, and any try from a person's device are refused.
- **calls**: the owner opens a call and her device is told once and asks faster; his next line
  goes to her and ΠAN says nothing; nothing she says is passed on until she answers; then her
  words reach him alone, without her name; hanging up ends it for both; the app's own open and
  close; a person chooses shown only; the owner sets and locks it for a child.
- **calls, after the owner's first real call**: "hang up" inside a longer line and without
  ΠAN's name ends the call and is not passed on; "talk to her and tell her" sends the words and
  opens no call; a name the speech model respelled reaches the one person it sounds like; a
  person gives herself another name and a message by it reaches her.
- **groups**: the owner makes a group and puts someone in it and everyone sees it; only the
  owner changes them; a person in two groups, then taken out of one; renamed, then deleted, the
  person stays on the hub in no group.
- **calls, saying no**: the called person declines, the caller is told and their side closes;
  a person who takes no calls from someone: the call is refused and their device hears nothing.
- **group calls**: the owner calls a group by voice and everyone in it is rung once; nothing a
  rung person says is passed on; she answers in the app and the child by voice; with two on the
  words alone, with three who said them; a typed line; each reads only what they said or heard;
  hanging up and the call ending when one is left; nobody calls a group they are not in; a call
  with one person ends when a group is called; everyone rung saying no; a child calling
  everyone; someone who takes no calls from the caller is not rung.
- **met**: an adult adds someone she met and only her list has it; a child cannot unless the
  owner opens it; the owner's record of the same person is his own; a code with no name or a
  bad key is refused; nobody forgets another person's record.
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
