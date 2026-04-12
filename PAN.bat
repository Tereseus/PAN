@echo off
:: PAN Launcher — starts server and opens dashboard
:: Double-click this or type "PAN" from Start Menu

set "PAN_SHELL=%~dp0service\tauri\src-tauri\target\release\pan-shell.exe"
set "PAN_SHELL_WD=%~dp0service\tauri"
set "PAN_LOCK=%~dp0service\.pan-server.lock"

cd /d "%~dp0service"

:: ─── Guard 1: Is /health already responding? ───
curl -sf -o NUL --max-time 2 http://127.0.0.1:7777/health
if %ERRORLEVEL% EQU 0 (
    echo [PAN] Server already running — opening dashboard
    start "" /D "%PAN_SHELL_WD%" "%PAN_SHELL%"
    exit /b 0
)

:: ─── Guard 2: Is port 7777 already bound? (catches boot-in-progress) ───
netstat -ano | findstr ":7777 " | findstr "LISTENING" >NUL 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [PAN] Port 7777 already in use — server is booting, opening dashboard
    goto WAIT
)

:: ─── Guard 3: Lock file prevents concurrent PAN.bat invocations ───
:: Lock is deleted by the respawn loop on exit, or stale after reboot
if exist "%PAN_LOCK%" (
    :: Lock exists — check if the PID in the lock is still alive
    set /p LOCK_PID=<"%PAN_LOCK%"
    tasklist /FI "PID eq %LOCK_PID%" 2>NUL | findstr /I "cmd.exe" >NUL 2>&1
    if %ERRORLEVEL% EQU 0 (
        echo [PAN] Another launcher is running (PID %LOCK_PID%) — opening dashboard
        goto WAIT
    ) else (
        echo [PAN] Stale lock file (PID %LOCK_PID% dead) — removing
        del /f "%PAN_LOCK%" >NUL 2>&1
    )
)

echo [PAN] Starting server...
:: IMPORTANT: launch in a NEW visible cmd window (not /b background) so node
:: gets a real Windows console. node-pty's conpty_console_list_agent.js calls
:: AttachConsole(parent) — if there's no console, every PTY spawn crashes the
:: server. The visible window is also a live log viewer; closing it kills PAN.
::
:: The window respawns node every time it exits — replaces the WinSW wrapper
:: we used to have. Lets the in-app Restart button (which calls process.exit)
:: work transparently. Closing the window kills the loop and stops PAN.
::
:: The lock file is written with the cmd PID and deleted on exit to prevent
:: duplicate launchers (the root cause of the Carrier/Craft conflict bug).
start "PAN Server" cmd /k "%~dp0service\pan-loop.bat"

:: Write lock with the new cmd's PID (best-effort — the cmd itself also writes one)
:: We find it by looking for the newest cmd.exe with our window title
timeout /t 1 /nobreak >NUL
for /f "tokens=2" %%a in ('tasklist /FI "WINDOWTITLE eq PAN Server" /FO TABLE /NH 2^>NUL ^| findstr "cmd.exe"') do (
    echo %%a > "%PAN_LOCK%"
)

:: Wait for server to come up (max 15 seconds)
:WAIT
set ATTEMPTS=0
:WAITLOOP
set /a ATTEMPTS+=1
if %ATTEMPTS% GTR 15 (
    echo [PAN] Server did not start in time — check terminal
    pause
    exit /b 1
)
timeout /t 1 /nobreak >NUL
curl -sf -o NUL --max-time 2 http://127.0.0.1:7777/health && goto READY
goto WAITLOOP

:READY
echo [PAN] Server running — opening dashboard
start "" /D "%PAN_SHELL_WD%" "%PAN_SHELL%"
