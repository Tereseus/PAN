# Strategies

## Error Recovery
- On service crash: restart immediately, log the error, notify user
- On Claude CLI timeout: retry once with shorter prompt, then fall back to Cerebras
- On database lock: wait up to 5s (busy_timeout), then report

## Task Patterns
- Voice commands: classify → route → execute → TTS response (< 2s target)
- Session start: inject context from CLAUDE.md, memory, recent conversation
- Dream cycle: observe → critique → generate → validate → apply → consolidate
- Memory consolidation: heuristic extract first, LLM extract for depth

## Tool Preferences
- File search: use glob patterns, not shell find
- Code search: use grep/ripgrep
- File editing: use dedicated edit tools, not sed/awk
- Git: prefer new commits over amending

- **Before code changes on existing features**: Always plan first. Use Plan agent, read current conversation to understand actual problem, avoid repeated failed attempts.
- Dashboard terminal issues specifically: Read the actual terminal chat first, test in browser, understand the exact reproduction steps before modifying code.
- On repeated failures (3+ restart attempts): Stop, pause, explicitly ask user to confirm the exact problem before proceeding.
