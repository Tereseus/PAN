# People, families and other ΠANs

Written 2026-11-18 from a read of the code. The owner's call that day: all of this comes before install. Install is last. These are core: a product that lets a hundred ΠANs in one train car talk over each other is not one to hand out. Nothing here is built yet unless the table says so.

## What the owner asked for

1. **Two people who both have ΠAN** should talk through their ΠANs directly, not in turns where one ΠAN speaks out loud and the other translates what it heard.
2. **A crowd.** A thousand ΠANs in a subway must not hear, answer or message each other.
3. **Unknown devices.** Someone sending strange messages to your ΠAN: it has to accept or deny, and it must not be hackable that way.
4. **Messages to friends** through ΠAN.
5. **Families.** A parent runs the children's devices from one ΠAN. Teenagers have their own ΠAN and their own computer.

## What exists

| Piece | State | Where |
|---|---|---|
| Users, roles and power levels (owner, admin, manager, user, guest, child) | Built. In practice every request is the owner: with the default setting nobody else can sign in as themselves | `schema.sql`, `routes/auth.js`, `middleware/auth.js` |
| Organizations: create, invite, members, roles, a database per organization, sharing between two | Built, on one hub only | `routes/orgs.js`, `org-db.js` |
| Roles that actually stop something | Three places: the terminal (no child), one automation switch, deleting a client | `permissions.js` |
| A child's limits on voice | Not there. The voice path checks no role at all | `router.js` |
| Each device has its own key; a limited device can reach only a short list of requests | Built and live (PAN Link) | `pan-link/`, `routes/link.js` |
| Which person a device belongs to | A column nothing reads or writes | `devices.owner_user_id` |
| Contacts, message threads | Stored on the hub. The desktop pages show them; the phone app has no screen for them | `routes/chat.js` |
| Sending a message from one person's hub to another's | Not there. Two `TODO` lines. The receiving route exists, takes any sender on trust and has no caller | `routes/chat.js` |
| A relay server for hub to hub messages | Written in April, never run. It is a hosted server, which the owner has ruled out, and its encryption is not real (the shared secret is a hash of two public keys) | `hub/`, `hub-crypto.js`, `hub-client.js` |
| The rules for what another ΠAN may do (same family, partner, stranger; ask once, ask always, deny) | Written, used by nothing | `trust-ladder.js` |
| Two ΠANs passing words as text while interpreting | Works in a test only: plain HTTP over a cable, no keys | `interpret/PeerLink.kt`, `evals/voicebench/peer_person.py` |
| Phones finding each other by radio | Not there. The only Bluetooth is to the pendant. Design text exists | `docs/BLE-MESH.md` |
| ΠAN ignoring its own voice from another speaker | Built and on, for ONE voice: the print file holds the default voice only. Another person's ΠAN on another voice is not dropped, and over the air the check catches about 84%, not all | `voice-id.js` (`pan_self_voice`), `pan-voice-print.json` |
| ΠAN ignoring people who are not its wearer | Built, but only logs by default | `voice-id.js` (`voice_id_gate` = `observe`) |
| A scanner for messages that try to give ΠAN orders | Written, set to warn only, connected to nothing that comes in | `guardian.js` |
| Zones (act differently in a place) | Routes exist, nothing calls them | `routes/zones.js` |

## Holes to close first

Found in the same read. They matter the moment anyone else's device can reach a hub.

1. **Anyone who reaches the hub's port is the owner** unless sign-in by token is switched on. Today that port is only reachable from the owner's own network and devices, and PAN Link was built to close it (INSTALL-PLAN, "the hub listens on the computer itself only"). That move is not finished.
2. **A limited device can make the phone speak.** It may send a note of the kind "speak", up to 2,000 characters, and the phone reads it out. No sender is named and nothing checks the words.
3. **All notes share one queue.** Whichever phone asks first takes every note, whoever it was for.
4. **Approving a new computer needs no owner check** beyond having reached the hub.
5. **Pretending to be a child in the dashboard lowers every device at once,** the phone included: it is one switch for the whole program.

## The rules

1. **Three kinds of other.** People inside my ΠAN (my family, under me). Other people's ΠANs I have accepted (contacts). Everyone else (strangers).
2. **Words from another ΠAN are never orders.** They are shown, spoken as "Maria says ..." or translated. They never go through the part of ΠAN that acts on what it hears, and never into the model as if the wearer had said them.
3. **A stranger gets nothing.** No radio presence, no message, no request on your screen. The only way a stranger reaches you is a session the two of you start on purpose, and it ends by itself.
4. **Every pairing has a level and an end.** What it may send, how often, until when. The owner can end any of them at once.
5. **No server of ours, and hubs never pair** (the owner, 2026-11-18: that is dangerous). The hub holds a person's memory, so nothing but that person's own devices ever reaches it. Two people's ΠANs meet only as two devices close together, for a while. The phone tells its hub which words came from the other person, and the hub treats them as theirs (rule 2).

6. **Closed until opened** (the owner, 2026-11-18: "don't allow anything in, and then you can determine if you want to do something"). A ΠAN that is not in a session accepts nothing from any other device. In a session it accepts the words of the talk and nothing else. Anything the other side asks for ("send me that photo") is put to the wearer, who decides.
7. **A session lowers what ΠAN will do, it never raises it.** While any other person's device is paired, each action is one of three kinds:
   - **as usual:** talk, translate, answer from general knowledge;
   - **only with a fingerprint or a touch on the wearer's own device:** send a message, give out anything from memory, a contact, a photo or a place, pay;
   - **not at all until the session is over:** run a computer, talk to a Claude thread, open Memory, pair another device, change settings or what people may do.

   The owner can move an action to a stricter kind, never to a looser one.
8. **Every session leaves a record on the wearer's own hub:** the other device's key, the name it gave, when, how long, and everything it tried that was refused. It is never sent anywhere. A device that tried something can be blocked by its key, and the next scan of its code says so before anything starts.

## The plan, in build order

### Step 1: close the holes (small)

- Finish moving the hub's port to the computer itself, so every request arrives through PAN Link with a device key.
- A note that is spoken carries who sent it, and the phone says so. Notes are queued per device.
- Approving a device needs the owner.
- Take `hub/`, `hub-client.js` and the false encryption out.

### Step 2: people inside one ΠAN (families with young children)

- A pairing code is made for a person. The device it pairs belongs to that person (`devices.owner_user_id`), and its requests arrive as that person, not as the owner.
- The voice path asks one question before it acts: may this person do this? A child cannot run a computer, read anyone else's memory, send to a thread or lend a device. A parent sets the rest (hours, what it will talk about) from their own phone.
- **Every path into the hub has a least power, and a path nobody has listed is closed** (the owner, 2026-11-18: by role). The phone app calls about forty; today most answer anyone who reaches them. One table says who may call what, checked in one place before any route runs.
- Each person's talk and memory are their own. A parent sees a child's; nobody sees a parent's.
- On a shared device (the car, a TV) the voice print says who is talking, and an unknown voice is a guest.

### Step 3: messages to people (friends, family far away)

- **A message goes out the way messages already do:** through the phone's own SMS or messaging app. ΠAN drafts it, reads one line back, and sends on "send" (PRODUCT-MAP, Pilot mode, "Drafts and send"). The other person needs no ΠAN.
- **A message coming in** is read to the wearer as "Maria says ...", by the wearer's own rules: now, later, or shown only. It is words, never an order (rule 2).
- **Contacts** are the phone's own contacts plus what ΠAN has learned to call them. The hub's old contact tables and the receiving route that trusts any sender are taken out.
- **What this leaves out, on purpose:** anything between two ΠANs at a distance (a teenager's ΠAN answering "where are you" for a parent). That would need hubs to reach each other. If it is ever wanted it rides on ordinary messages.
- **A family of separate ΠANs** (teenagers with their own) is then just people who message each other, plus lending a shared device when they are in the same house (PRODUCT-MAP idea 15), which is a pairing between devices on one home network.

### Step 4: talking together (two or more ΠANs in one place)

- **Starting it is a deliberate act by both people:** one shows a code, the other scans it, or the two phones are tapped together. Nothing starts because two ΠANs are near each other.
- **Inside a session the ΠANs pass words as text,** signed with a key made for that session. My ΠAN hears me, sends my words; yours translates them and says them to you in your ear, in your own ΠAN's voice. Nothing is spoken into the room as a turn of its own, so both people can talk the way they normally do, and a third person can join by scanning.
- **Each ΠAN goes quiet on its own microphone while the other person's words are playing,** and already ignores every other ΠAN's voice.
- **The pairing is between the two devices, never the hubs,** and it is temporary. Each phone passes the other person's words to its own hub marked as theirs.
- **The wire** between the two phones is direct (Bluetooth for the first version: the lines are a few hundred bytes). The test version (`PeerLink`) already does the passing; it needs the real wire and the keys.
- **It ends** when either person says so, or when the phones have been apart for a few minutes. Nothing is kept on the other person's ΠAN except what they heard.

### A crowd, and who is speaking

No ΠAN announces itself and a stranger's ΠAN cannot send anything, so the radio side needs nothing more. In a session the ΠANs pass text, so they never need to hear each other. What is left is sound: a hundred voices and a hundred speakers in one train car. One check is not enough (the owner: someone can play a voice at full volume), so there are layers, each covering what the one before cannot:

1. **Does it sound like the wearer.** The voice print (`voice-id.js`, CAM++). Loudness does not help a stranger: a loud voice still is not the wearer's. Measured Nov 6: the right person of two, 99 to 100% on a clean 2 s line, about 90% through a simulated bad room. It exists and only logs today (`voice_id_gate` = `observe`); it goes on by default once a ΠAN has its wearer's print.
2. **Is it close.** The Medallion's two microphones: the wearer's mouth is about 20 cm away and reaches them differently from a loudspeaker across the room, however loud (PRODUCT-MAP, "Two devices in one room"). Designed, calculated, not measured. A phone in a pocket does this poorly, so on the phone layers 1 and 3 carry it.
3. **Is it meant for ΠAN.** The addressed check (0.97 on the addressed test).
4. **Other ΠANs' voices.** The own-voice check knows one voice today; people pick different ones (the owner, 2026-11-18). Add a print for each voice the app ships. A second layer only: a voice from another engine is not caught, and over the air the known one is caught about 84% of the time.
5. **Voice gets talk, not power.** A recording or a copy of the wearer's own voice passes layer 1. So what matters (sending, paying, opening Memory, running a computer) needs a touch or a fingerprint, as Memory already does.

## Decided

The owner, 2026-11-18:

1. **A child's limits are set by whoever owns the organization.** The plan ships a starting list (no computer control, nobody else's memory, no sending to a thread, no lending a device) and the owner changes it.
2. **A personal device (phone, pendant) belongs to its person. A shared device (a TV, the car) belongs to the organization's owner,** who decides who may use it and can take it over at any moment, including "only listen to me" on that device.
3. **The users, roles and organizations code is old and not trusted.** It is checked piece by piece before anything is built on it; what does not hold is rewritten, not patched.

Left to the plan, which chose:

4. **Strangers: only by a deliberate act of both people (scan or tap).** A stranger's ΠAN can never put a request on your screen. That request would be the door for the abuse the owner named.
5. **Order: holes, family, messages to people, talking together, then the crowd layers measured on real devices.** Install comes after all of it.

## What was already tried

The interpreter test where the owner spoke English to a computer playing a second person, and it answered in Japanese, is the test version of step 4: each side passed its line as text and nothing was spoken as a turn of its own. The wire was a cable to the computer (plain HTTP, no keys), not Bluetooth. No two phones have talked to each other by radio yet.

## How it is tested

Two phones are free for this without the owner's own: the test tablet and an older phone.

- Messages: a draft read back and sent from the test tablet; an incoming one read as the sender's words; one that tries to give ΠAN an order is read, not obeyed.
- Family: a child's pairing on the test tablet; every voice action tried and refused where it should be.
- Talking together: the test tablet and a second phone, with recorded speech in two languages (the interpreter bench already has it).
- The crowd: the conversation bench with other ΠAN voices and other people's voices played at the phone.

## Progress

- **2026-11-18, the base of step 2, not live.** `service/src/people.js`: a pairing code can be made for a person (`POST /api/v1/link/pair` with `for_user`, and `shared` for a TV or the car); pan-link already says which tunnel address a code reserves, so the device that pairs is bound to that person with no change in pan-link. A device nobody was named for is the owner's, as before. `PUT /api/v1/link/devices/:id/person` hands a device over or takes it back, `GET /api/v1/link/people` lists whose is whose, and removing a device removes its binding. `may(person, action)` is the one check, with a starting list of twelve actions and the least power each needs; the owner changes it in the setting `people_limits`. Tests: `__tests__/people.test.js` (9) and five more in `pan-link-routes.test.js` (16).
- **2026-11-18, a request arrives as its person, not live.** `server.js` asks `people.js` whose a paired device is. The owner's devices are untouched. A device that belongs to anyone else: (1) is paired limited from its first request, so pan-link refuses everything not on `PERSON_ALLOW` before PAN sees it, pages and WebSockets included; (2) arrives in PAN as that person (`req.user` with their role and power), and PAN checks the same list again; (3) writes to a database of its own, `pan.person-<id>.db`, whatever scope the device asks for. Handing a device over sets the wall first and the name second; taking it back lifts the wall only when it is the owner's again. If a code made for a person is waiting and pan-link cannot say which device used it, an unknown device is refused (503) rather than taken for the owner. `PERSON_ALLOW` is five paths today: health, who am I, the app's version and download, and the device's own log. Talking is not on it. Tests: `people.test.js` (11), `pan-link-routes.test.js` (18), and 28 checks through a dev hub with a stand-in for pan-link (a child's device closed on 14 owner paths, the owner's device unchanged, a forged secret refused).
- **Next:** the voice path for a person. Today it builds every prompt from the owner's situation, memory, name and voice profile, and stores the turn in the owner's talk. For a person it must use none of that, ask `may` before it acts (threads, computers, the house, the camera, messages), and say plainly when it will not. Then talking joins `PERSON_ALLOW`, then the app gets a screen for the owner to add a person and show their code. Also open: the app calls about forty hub paths, some outside the login check altogether (`/dashboard/api/mem` is how Memory is read); pan-link's wall covers those for a person's device, and each one a person should have is to be answered from that person's own data.
