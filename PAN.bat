@echo off
:: PAN Launcher — starts server and opens dashboard
:: Double-click this or type "PAN" from Start Menu

set "PAN_SHELL=%~dp0service\tauri\src-tauri\target\release\pan-shell.exe"
set "PAN_SHELL_WD=%~dp0service\tauri"

cd /d "%~dp0service"

:: Check if PAN server is already running. Use --fail so curl returns non-zero
:: on any non-2xx response (or no connection), -o NUL discards the body. This
:: avoids the brittle "parse the http_code from a temp file" approach which
:: was failing intermittently and causing the bat to spawn a duplicate server.
curl -sf -o NUL --max-time 2 http://127.0.0.1:7777/health
if %ERRORLEVEL% EQU 0 (
    echo [PAN] Server already running — opening dashboard
    start "" /D "%PAN_SHELL_WD%" "%PAN_SHELL%"
    exit /b 0
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
start "PAN Server" cmd /k "cd /d %~dp0service && (for /l %%i in (1,0,2) do @(echo [PAN Server] starting node... & node pan.js start & echo [PAN Server] exited, restarting in 2s... & timeout /t 2 /nobreak >NUL))"

:: Wait for server to come up (max 15 seconds)
set ATTEMPTS=0
:WAIT
set /a ATTEMPTS+=1
if %ATTEMPTS% GTR 15 (
    echo [PAN] Server did not start in time — check terminal
    pause
    exit /b 1
)
timeout /t 1 /nobreak >NUL
curl -sf -o NUL --max-time 2 http://127.0.0.1:7777/health && goto READY
goto WAIT

:READY
echo [PAN] Server running — opening dashboard
start "" /D "%PAN_SHELL_WD%" "%PAN_SHELL%"
