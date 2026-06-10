---
name: Send to Claude (Computer Control)
triggers: [tell claude to {action}, ask claude to {action}, have claude {action}, claude {action}, computer control {action}, on my computer {action}, on the hub {action}, can you {action} on my computer, can you {action} on the hub, please {action} on my computer, run {action}, execute {action}, do {action} for me]
intent: claude_control
priority: 8
---
# Send to Claude — computer control bridge

When the user wants Claude Code (running as PAN's dedicated background
terminal) to perform a computer-control task, dispatch their message
verbatim to the claude-control PTY.

Examples of when this fires:
- "tell claude to open notepad"
- "ask claude to rename the files in Downloads"
- "have claude kill the steam process"
- "claude open my main browser"

Pass the user's `{{action}}` text directly to the claude-control PTY —
no rewriting, no embellishment. Claude Code itself decides how to
execute the request and replies in its own terminal. PAN waits a few
seconds for output and surfaces the first user-facing line as the
voice confirmation.

Respond with this JSON shape:
```json
{
  "intent": "claude_control",
  "action": "send",
  "text": "{{action}}",
  "response": "On it — sending to Claude."
}
```

The server-side handler will:
1. POST the `text` to `/api/v1/claude-control/send`
2. Wait briefly for output
3. Speak the first non-empty line of new output back to the user (or
   "Claude acknowledged" if nothing readable arrived in the window)

This skill assumes claude-control is running. If it isn't, the
endpoint returns 503 and PAN tells the user "Claude terminal is not
running — restart it from the dashboard."
