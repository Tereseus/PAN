# PAN thread relay — machine setup

Lets PAN voice reach every Claude Code thread in the Claude desktop app on this
machine. Hub side and the full flow: `service/src/thread-relay.js` and the
"Thread Relay" section of `docs/FEATURES.md`.

The desktop app has no external API, so one resident desktop thread delivers
messages with its session messaging tool. Everything else (thread list, waiting,
reading answers out of transcripts) is `relay.js`, plain Node, so the relay
thread costs nothing while idle: it only wakes when `relay.js wait` exits with a job.

## 1. Hub address

`relay.js` reads `../pan-client-config.json`. It uses `relay_hub_url` if set,
otherwise derives `http://host:port` from `hub_ws`. The hub accepts the relay on
LAN, tailnet or localhost. On a laptop, set `relay_hub_url` to the hub's tailnet
address: if `hub_ws` is a LAN address the relay goes dead as soon as the laptop
leaves home. Check with:

    node relay.js threads     # what this machine will report
    node relay.js status      # ALIVE once a wait loop has polled the hub

## 2. The relay thread

Start a new Claude Code desktop session in the repo folder, titled exactly
**PAN Voice Relay** (that title is excluded from the reported list), on a small
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

## Other machines

Same files, same steps. On Linux the app keeps sessions under
`~/.config/Claude/claude-code-sessions`, on macOS under
`~/Library/Application Support/Claude/claude-code-sessions`; `relay.js` checks all three.
Set `PAN_RELAY_HOST` if the pan-client config has no `device_id`.
