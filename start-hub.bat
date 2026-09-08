@echo off
REM PAN hub launcher (headless, started by the PAN-Hub scheduled task as SYSTEM).
REM
REM node is pinned by ABSOLUTE PATH on purpose. SYSTEM's PATH resolves to a
REM different node (v24.19.0) than the user account that built the native
REM modules (v25.7.0), and better-sqlite3-multiple-ciphers then fails with
REM ERR_DLOPEN_FAILED because the binary was compiled for a different ABI.
REM On a different machine, change PAN_NODE below to that machine's node.
REM
REM PAN_DATA_DIR is pinned for the same class of reason: SYSTEM has its own
REM profile, so LOCALAPPDATA would point at the system profile and PAN would
REM silently create a brand new empty database there instead of yours.
REM
REM Entry point is pan.js start, NOT src\server.js. server.js is the Craft and
REM binds 17700; the Super-Carrier is what owns 7777 and spawns Carrier->Craft.

REM Load credentials from environment rather than the settings database.
REM secrets.js getSecret() prefers PAN_* env vars over db rows, so keys set in
REM pan-secrets.env.bat are never stored in, or served from, the database.
REM That file is gitignored and also carries PAN_HUB_USER (see below).
if exist "C:\PAN\pan-secrets.env.bat" call "C:\PAN\pan-secrets.env.bat"

REM PAN_HUB_USER is the Windows account whose profile holds the database. It is
REM deliberately NOT hardcoded here: this repo is public and was history-purged
REM in 2026-08 to zero identity references, so a literal C:\Users\<name> path in
REM a tracked file would reintroduce exactly what that purge removed. Set it in
REM pan-secrets.env.bat, which is gitignored and sourced on the line above.
if not defined PAN_HUB_USER (
  echo [start-hub] FATAL: PAN_HUB_USER is not set.
  echo [start-hub] Add    set PAN_HUB_USER=^<windows-account^>    to pan-secrets.env.bat
  echo [start-hub] Refusing to start: guessing here would create an EMPTY database
  echo [start-hub] under the wrong profile instead of loading yours.
  exit /b 1
)

set PAN_DATA_DIR=C:\Users\%PAN_HUB_USER%\AppData\Local\PAN\data
set PAN_PROFILE=full
set PAN_NODE=C:\nvm4w\nodejs\node.exe

REM Fail loudly rather than writing a log into a directory that does not exist.
if not exist "%PAN_DATA_DIR%" (
  echo [start-hub] FATAL: PAN_DATA_DIR does not exist: %PAN_DATA_DIR%
  echo [start-hub] Check PAN_HUB_USER in pan-secrets.env.bat.
  exit /b 1
)

cd /d C:\PAN\service
"%PAN_NODE%" pan.js start >> "%PAN_DATA_DIR%\hub.log" 2>&1
