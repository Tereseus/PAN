@echo off
set "SYS=%SystemRoot%\System32"
set "PAN_SERVICE=%~dp0service"
set "PAN_SHELL=%~dp0service\tauri\src-tauri\target\release\pan-shell.exe"
set "PAN_SHELL_WD=%~dp0service\tauri"

:: Check if already running
"%SYS%\netstat.exe" -ano | "%SYS%\findstr.exe" ":7777 " | "%SYS%\findstr.exe" "LISTENING" >NUL 2>&1
if %ERRORLEVEL% EQU 0 goto ALREADY_RUNNING

:: ── Fresh start ─────────────────────────────────────────────
echo [PAN] Starting server...
cd /d "%PAN_SERVICE%"
start "PAN Server" cmd /c pan-loop.bat

echo [PAN] Waiting for Carrier...
set ATTEMPTS=0
:CARRIERLOOP
set /a ATTEMPTS+=1
if %ATTEMPTS% GTR 40 goto FAILED
"%SYS%\ping.exe" -n 2 127.0.0.1 >NUL 2>&1
"%SYS%\curl.exe" -s --max-time 2 "http://127.0.0.1:7777/health" >NUL 2>&1
if %ERRORLEVEL% NEQ 0 goto CARRIERLOOP
goto WAITCRAFT

:: ── Already running ─────────────────────────────────────────
:ALREADY_RUNNING
echo.
echo  PAN is running.
echo.
echo  [O] Open dashboard  (default)
echo  [Q] Quit PAN
echo.
choice /c OQ /t 5 /d O /n /m "  Choice: "
if %ERRORLEVEL% EQU 2 goto QUIT
goto WAITCRAFT

:QUIT
echo.
echo [PAN] Shutting down...
"%SYS%\curl.exe" -s -X POST --max-time 3 "http://127.0.0.1:7777/api/carrier/shutdown" >NUL 2>&1
echo [PAN] Done.
"%SYS%\timeout.exe" /t 2 /nobreak >NUL
exit /b 0

:: ── Wait for Craft to be ready ───────────────────────────────
:WAITCRAFT
echo [PAN] Waiting for Craft...
set ATTEMPTS=0
:CRAFTLOOP
set /a ATTEMPTS+=1
if %ATTEMPTS% GTR 60 goto FAILED
"%SYS%\ping.exe" -n 2 127.0.0.1 >NUL 2>&1
"%SYS%\curl.exe" -s --max-time 2 "http://127.0.0.1:7777/api/carrier/ready" >NUL 2>&1
if %ERRORLEVEL% NEQ 0 goto CRAFTLOOP

echo [PAN] UP - opening dashboard...
start "" /D "%PAN_SHELL_WD%" "%PAN_SHELL%"
exit /b 0

:FAILED
echo [PAN] Server failed to start. Check the "PAN Server" window for errors.
"%SYS%\timeout.exe" /t 15 /nobreak
exit /b 1
