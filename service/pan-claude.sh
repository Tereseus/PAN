#!/bin/bash
# pan-claude — starts Claude with auto-context summary
# Usage: pan-claude [project_dir]
#   If no dir given, uses current directory
#
# This is the fix for "Claude doesn't speak first" —
# it passes the initial prompt as a CLI argument so Claude
# immediately summarizes context without the user typing anything.

DIR="${1:-.}"
cd "$DIR" 2>/dev/null || DIR="."

# Check if .pan-briefing.md or .pan-state.md exists
if [ -f ".pan-briefing.md" ] || [ -f ".pan-state.md" ]; then
  claude "This is a fresh session. Read the PAN session context injected into CLAUDE.md (between PAN-CONTEXT markers). Summarize what we were working on last time — start with 'Last time we were working on...' and list the key topics. Then ask what I want to work on next."
else
  claude "This is a fresh session. Check CLAUDE.md for any session context. If there's a Recent Conversation section, summarize what we were working on. Otherwise just say hello and ask what to work on."
fi
