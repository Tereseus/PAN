# Governance & Security Rules

## Deny Rules (`.claude/settings.json`)
These deny rules protect against destructive and sensitive operations:
- Block `rm -rf /`, `rm -rf ~`, `rm -rf /*`
- Block `git push --force` to main/master
- Block `git reset --hard`
- Block `DROP TABLE` via bash
- Block reading `.env`, `.env.*`, `credentials.json`, `secrets.*`, `service-account*.json`
- Block `cat` on env/credentials/secrets files

## Hooks
- **PreToolUse (Bash)**: Log before bash command execution
- **PostToolUse (Write|Edit)**: Log after file modifications

## Verification Commands
Before committing changes, verify:
1. Server starts: `node service/src/server.js` (listen on 7777)
2. Python STT: `python service/bin/dictate-vad.py --help`
3. Android build: `JAVA_HOME=".../jbr" ./gradlew.bat assembleDebug`
4. Dashboard: http://localhost:7777 — no console errors

## Architecture Documentation
- CLAUDE.md top section uses Mermaid diagram for architecture (73% fewer tokens than prose)
- Dream cycle manages `.pan-state.md` and PAN-CONTEXT section only
- Static project docs (above PAN-CONTEXT markers) are manually maintained
