# PAN Session Memory

Automatic capture of all terminal sessions. PAN remembers every conversation, every command, every output.

## How It Works
- **PowerShell sessions**: Auto-logged via `Start-Transcript` in PowerShell profile
- **Git Bash / Claude Code sessions**: Auto-logged via `script` in bash profile
- **Log format**: `YYYY-MM-DD_HH-MM-SS_<shell>.log`
- **Location**: This directory (`PAN/sessions/`)

## Retention
All sessions are kept. PAN doesn't forget.
