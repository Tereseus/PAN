#!/bin/bash
# PAN Remembers — Recovery command
# Type "pan-remembers" or "pan remembers" in any terminal to get back to full PAN state
#
# This fetches the context briefing, writes it to .pan-briefing.md,
# prints the banner, and starts Claude with the full briefing context.

PROJECT_PATH="$(pwd)"
BRIEFING=""

# Fetch briefing from PAN server
if curl -s --connect-timeout 2 "http://localhost:7777/health" > /dev/null 2>&1; then
  BRIEFING=$(curl -s "http://localhost:7777/api/v1/context-briefing?project_path=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$PROJECT_PATH'))" 2>/dev/null || echo "$PROJECT_PATH")" 2>/dev/null | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); console.log(j.briefing||''); } catch { console.log(''); }
    });
  " 2>/dev/null)
fi

# Write briefing to .pan-briefing.md if we got one
if [ -n "$BRIEFING" ]; then
  echo "$BRIEFING" > .pan-briefing.md
fi

# Print the banner
printf "\033[1;96mΠΑΝ remembers..\033[0m\n"

# Start Claude with the briefing prompt
claude --permission-mode auto "ΠΑΝ remembers... Start session. Read CLAUDE.md and give the session continuity summary."
