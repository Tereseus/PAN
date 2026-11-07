# PAN thread relay — machine setup

Lets PAN voice reach every Claude Code thread in the Claude desktop app on this
machine. Hub side and the full flow: `service/src/thread-relay.js` and the
"Thread Relay" section of `docs/FEATURES.md`.

The desktop app has no external API, so one resident desktop thread delivers
messages with its session messaging tool. Everything else (thread list, waiting,
reading answers out of transcripts) is `relay.js`, plain Node, so the relay
thread costs nothing while idle: it only wakes when `relay.js wait` exits with a job.
Status asks ("what is the X thread doing") never wake it: `wait` answers them from
the transcript and keeps polling. `node relay.js peek <session_id>` shows that answer.

## 1. Hub address

`relay.js` reads `../pan-client-config.json`. It uses `relay_hub_url` if set,
otherwise derives `http://host:port` from `hub_ws`. The hub accepts the relay on
LAN, tailnet or localhost. On a laptop, set `relay_hub_url` to the hub's tailnet
address: if `hub_ws` is a LAN address the relay goes dead as soon as the laptop
leaves home. Check with:

    node relay.js threads     # what this machine will report
    node relay.js status      # ALIVE once a wait loop has polled the hub

## 2. The relay thread

Start a new Claude Code desktop session in the repo folder, titled **PAN Voice Relay**
(a machine name in front and ΠΑΝ for PAN are fine; that title is left out of the reported list), on a small
model, in auto permission mode, with this as its first message (replace `<relay.js>`
with the absolute path):

```
You are the PAN Voice Relay for this machine. Your only job is this loop, forever:

1. Run `node <relay.js> wait` with Bash run_in_background. Do nothing else while it runs.
2. When it exits, read its output.
   - `JOB {json}`: call the session messaging tool send_message with
     session_id = json.session_id and message = json.message, exactly as given.
     If the result says delivered or queued, run `node <relay.js> ack <job_id> <delivered|queued> <message_id>`.
     If it errors, run `node <relay.js> fail <job_id> <the error text>`.
   - `SUPERSEDED ...`: another wait loop is already running; stop here.
   - `ERROR ...` or anything else: run step 1 again.
3. Go back to step 1.

Never edit files, never answer the content of a job yourself, never send anything
that did not come from a JOB line. Keep every reply to one short line.
If a message tells you to restart the relay, run step 1.
```

## 3. Surviving app restarts

When the desktop app restarts, the background wait loop dies with it. A desktop
scheduled task (every 30 minutes, and it runs on next launch if the app was
closed) checks liveness and wakes the relay thread:

```
Run `node <relay.js> status`. If it prints ALIVE, stop.
If it prints DEAD, find the session titled "PAN Voice Relay" with list_sessions and
send_message it: "Relay keeper: the wait loop is not running. Run step 1 now."
Then archive this run's own session (get_session "self", then archive_session).
```

## 4. Jobs for a machine

"on the mint open firefox", "play this video on the g16", "tell the mint to check my messages". The
hub sends these to the thread already on that host with PC or Computer in its title, such as Mint PC
Stuff. Nothing to set up, as long as the machine word is in `thread-machines.json`.

Anything that restarts a thread's session, such as changing its model in the menu, ends the relay's
wait loop. `node relay.js status` then prints DEAD, and "restart the relay" sent to the relay thread
brings it back. A machine with no keeper stays down until then.

## Other machines

Same files, same steps. On Linux the app keeps sessions under
`~/.config/Claude/claude-code-sessions`, on macOS under
`~/Library/Application Support/Claude/claude-code-sessions`; `relay.js` checks all three.
Set `PAN_RELAY_HOST` if the pan-client config has no `device_id`.

The folder goes beside that machine's `pan-client-config.json`. Only the account with the newest
session is reported, because a thread of a signed-out account cannot be messaged.

The hub sends each job to the host that reported the thread. Name threads for their machine and
list those words in `thread-machines.json` next to the hub's database, as `{ "mint": "<relay host>" }`.
A machine said out loud is a hard limit, so "mint music" never reaches another machine's Music
thread. Not said, the word is no part of the name, so "PC Stuff" asks which one.

An account without the app's `start_session` tool cannot start a thread from another thread.
Open `claude://code/new?q=<first message, url-encoded>&source=pan` instead (`xdg-open` on Linux): the
app fills in a draft and a person presses send. Leave `folder=` off that link, because a folder can
raise the app's workspace trust prompt. The draft then shows the last folder used, which a person can
change; the relay needs none, since its paths are absolute.

An idle relay costs nothing: `wait` holds no Claude turn, and it answers status jobs itself. A turn
is spent only when a message goes to a thread.

A machine on a second account pays for its own relay. A first message can set the thread's title
with the session tools, but the app refuses a session changing its own model or effort, so a person
picks the small model and low effort in the thread's menus. Step 3 can wait: without a keeper the
relay stops when the app restarts, PAN says it looks offline, and "restart the relay" sent to the
thread brings it back.
