

- **CRITICAL**: Before suggesting tasks or previous issues, always read the current conversation history first. Memory files are stale — actual truth is in the chat.
- Never show a task from project_status.md that isn't explicitly confirmed solved in the current conversation.
- If user says "memory is not correct" or "you don't remember what we just talked about", immediately pivot to reading conversation, not memory.


### Special Case: Efficiency Reports
User generates efficiency reports after work sessions (5+ instances exist). Search steps:
1. Check Library widget for efficiency_reports folder
2. Query: `curl http://127.0.0.1:7777/dashboard/api/events?q=efficiency+report` 
3. Look in dream-cycle outputs (auto-generated weekly summary)
4. If not found, generate new one with format: metrics (restart %, feature velocity %) + service procedures + vibe-coding optimizations
5. Always open in new window via ui-commands, never dump in terminal
